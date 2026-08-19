/* ═══════════════════════════════════════════════════════════════
   Monopoline server — static host + realtime rooms.
   Zero dependencies: Node stdlib only (http, fs, path, crypto).
   Realtime uses Server-Sent Events, which survive Render's proxy
   and reconnect on their own. State is one JSON blob per room,
   versioned so a stale writer can never clobber a newer table.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const ROOM_TTL = 1000 * 60 * 60 * 8;   // rooms die 8h after last touch
const MAX_STATE = 1024 * 1024;         // 1MB ceiling on a pushed state
const MAX_ROOMS = 500;

/** code -> { code, v, state, players:[{pid,name,piece}], clients:Set, host, touched } */
const rooms = new Map();
/** Newest-first bug reports. In memory only — they also go to stdout, which is
    what survives on a host with an ephemeral disk. */
const reports = [];

/* ── accounts ──────────────────────────────────────────────────
   Small on-disk store. DATA_DIR should point at a mounted disk in
   production; on an ephemeral filesystem accounts reset on redeploy. */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = Object.create(null);
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(USERS_FILE)) {
    // Object.create(null): a plain {} would report "constructor", "toString"
    // and friends as existing accounts.
    users = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')));
  }
} catch (e) { console.log('[accounts] could not read store:', e.message); }
let saveTimer = null;
function saveUsers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(users)); }
    catch (e) { console.log('[accounts] could not write store:', e.message); }
  }, 250);
}
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 64).toString('hex');
const userKey = name => String(name || '').trim().toLowerCase();
const validName = n => /^[a-zA-Z0-9 _-]{3,14}$/.test(String(n || '').trim());
function publicUser(u) {
  return { name: u.name, prefs: u.prefs || {}, stats: u.stats || { games: 0, wins: 0 }, since: u.created };
}
function userByToken(token) {
  if (!token) return null;
  for (const k of Object.keys(users)) if (users[k].token === token) return users[k];
  return null;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
function newCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(c));
  return c;
}
const newToken = () => crypto.randomBytes(16).toString('hex');
const clean = (s, n = 14) => String(s == null ? '' : s).replace(/[\x00-\x1f<>]/g, '').trim().slice(0, n);

function touch(room) { room.touched = Date.now(); }

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_TTL) {
      for (const c of room.clients) { try { c.res.end(); } catch (e) {} }
      rooms.delete(code);
    }
  }
}, 1000 * 60 * 10).unref();

/* ---------- helpers ---------- */
function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(data);
}
function readJson(req, limit = MAX_STATE) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function broadcast(room, event, payload, exceptToken) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of room.clients) {
    if (exceptToken && c.token === exceptToken) continue;
    try { c.res.write(frame); } catch (e) { /* dropped; the stream's close handler cleans up */ }
  }
}
function sendTo(room, pid, event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  let sent = 0;
  for (const c of room.clients) {
    if (c.pid !== pid) continue;
    try { c.res.write(frame); sent++; } catch (e) {}
  }
  return sent;
}
const roster = room => ({
  title: room.title || '',
  players: room.players.map(p => ({ pid: p.pid, name: p.name, piece: p.piece || null, color: p.color || null })),
  online: [...room.clients].map(c => c.pid)
});

/* ---------- static files ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');       // no path traversal
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (path.extname(file)) return send(res, 404, 'Not found');
      return serveStatic(req, res, '/');                                   // SPA fallback
    }
    const ext = path.extname(file).toLowerCase();
    // The app shell must never be cached stale; hashed assets could be, but we keep it simple.
    const cache = ext === '.html' || ext === '.webmanifest' || file.endsWith('sw.js')
      ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- api ---------- */
async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean);   // ['api','rooms',code,action]
  const method = req.method;

  if (seg[1] === 'health') return send(res, 200, { ok: true, rooms: rooms.size, reports: reports.length, up: Math.round(process.uptime()) });

  // POST /api/report -> a bug report, from an online table or a solo device
  if (seg[1] === 'report' && method === 'POST') {
    const body = await readJson(req, 128 * 1024);
    const text = clean(body.text, 2000);
    if (!text) return send(res, 400, { error: 'Describe what went wrong first.' });
    const entry = {
      at: new Date().toISOString(),
      from: clean(body.from, 24) || 'anonymous',
      code: clean(body.code, 8) || null,
      text, agent: clean(body.agent, 200),
      snapshot: typeof body.snapshot === 'string' ? body.snapshot.slice(0, 100000) : null
    };
    reports.unshift(entry);
    if (reports.length > 200) reports.pop();
    // Render surfaces stdout in the dashboard, so this is where reports land.
    console.log(`[bug] ${entry.at} | ${entry.from}${entry.code ? ' @' + entry.code : ''} | ${entry.text.replace(/\s+/g, ' ').slice(0, 400)}`);
    return send(res, 200, { ok: true, filed: reports.length });
  }

  // ── accounts ───────────────────────────────────────────────
  if (seg[1] === 'auth') {
    const what = seg[2];

    if (what === 'register' && method === 'POST') {
      const body = await readJson(req, 4096);
      const name = String(body.name || '').trim();
      const pass = String(body.pass || '');
      if (!validName(name)) return send(res, 400, { error: 'Names are 3–14 characters: letters, numbers, spaces, - and _.' });
      if (pass.length < 4) return send(res, 400, { error: 'Use at least 4 characters for the password.' });
      if (Object.keys(users).length >= 5000) return send(res, 503, { error: 'The account list is full.' });
      const key = userKey(name);
      const existing = users[key];
      if (existing) {
        // same person submitting twice (slow cold start, double tap, proxy retry)
        const attempt = hashPass(pass, existing.salt);
        const same = attempt.length === existing.hash.length &&
          crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(existing.hash, 'hex'));
        if (same) {
          existing.token = newToken();
          saveUsers();
          console.log('[accounts] repeat register for ' + existing.name + ' -> signed in');
          return send(res, 200, { token: existing.token, user: publicUser(existing), existing: true });
        }
        return send(res, 409, { error: 'That name is taken. If it is yours, use Sign in.' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      users[key] = {
        name, salt, hash: hashPass(pass, salt), token: newToken(),
        created: new Date().toISOString(), stats: { games: 0, wins: 0 }, prefs: {}
      };
      saveUsers();
      console.log('[accounts] created ' + name + ' (' + Object.keys(users).length + ' total)');
      return send(res, 200, { token: users[key].token, user: publicUser(users[key]) });
    }

    if (what === 'login' && method === 'POST') {
      const body = await readJson(req, 4096);
      const u = users[userKey(body.name)];
      const pass = String(body.pass || '');
      // compare in constant time, and do the work even when the user is unknown
      const salt = u ? u.salt : 'x'.repeat(32);
      const attempt = hashPass(pass, salt);
      const expect = u ? u.hash : attempt.replace(/./g, '0');
      const ok = u && attempt.length === expect.length &&
        crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(expect, 'hex'));
      if (!ok) return send(res, 401, { error: 'Wrong name or password.' });
      u.token = newToken();
      saveUsers();
      return send(res, 200, { token: u.token, user: publicUser(u) });
    }

    if (what === 'me' && method === 'GET') {
      const u = userByToken(url.searchParams.get('token'));
      if (!u) return send(res, 401, { error: 'Signed out.' });
      return send(res, 200, { user: publicUser(u) });
    }

    if (what === 'prefs' && method === 'POST') {
      const body = await readJson(req, 4096);
      const u = userByToken(body.token);
      if (!u) return send(res, 401, { error: 'Signed out.' });
      u.prefs = u.prefs || {};
      if (typeof body.piece === 'string') u.prefs.piece = clean(body.piece, 16);
      if (/^#[0-9a-fA-F]{6}$/.test(String(body.color || ''))) u.prefs.color = body.color;
      if (typeof body.skin === 'string') u.prefs.skin = clean(body.skin, 16);
      saveUsers();
      return send(res, 200, { user: publicUser(u) });
    }

    if (what === 'result' && method === 'POST') {
      const body = await readJson(req, 4096);
      const u = userByToken(body.token);
      if (!u) return send(res, 401, { error: 'Signed out.' });
      u.stats = u.stats || { games: 0, wins: 0 };
      u.stats.games++;
      if (body.won) u.stats.wins++;
      saveUsers();
      return send(res, 200, { user: publicUser(u) });
    }

    if (what === 'logout' && method === 'POST') {
      const body = await readJson(req, 4096);
      const u = userByToken(body.token);
      if (u) { u.token = null; saveUsers(); }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'Unknown account endpoint.' });
  }

  // ── moderator broadcasts ───────────────────────────────────
  // These reach every table on the server, so they are gated by ADMIN_KEY
  // when one is configured. Leave it unset only on a server you own.
  if (seg[1] === 'admin' && method === 'POST') {
    const body = await readJson(req, 8192);
    const key = process.env.ADMIN_KEY;
    if (key && body.key !== key) return send(res, 403, { error: 'Bad moderator key.' });

    const reach = () => {
      let tables = 0, people = 0;
      for (const room of rooms.values()) { tables++; people += room.clients.size; }
      return { tables, people };
    };

    if (seg[2] === 'announce') {
      const text = clean(body.text, 240);
      if (!text) return send(res, 400, { error: 'Nothing to announce.' });
      for (const room of rooms.values()) broadcast(room, 'announce', { text, at: Date.now() });
      const r = reach();
      console.log(`[announce] ${text} -> ${r.tables} tables, ${r.people} devices`);
      return send(res, 200, Object.assign({ ok: true }, r));
    }

    if (seg[2] === 'blackout') {
      const r = reach();
      for (const room of rooms.values()) broadcast(room, 'blackout', { at: Date.now() });
      console.log(`[blackout] every device asked to reload -> ${r.tables} tables, ${r.people} devices`);
      return send(res, 200, Object.assign({ ok: true }, r));
    }

    return send(res, 404, { error: 'Unknown moderator action.' });
  }

  // GET /api/reports?key=... -> read them back; only with ADMIN_KEY set
  if (seg[1] === 'reports' && method === 'GET') {
    const key = process.env.ADMIN_KEY;
    if (!key) return send(res, 404, { error: 'Report viewing is disabled. Set ADMIN_KEY to enable it.' });
    if (url.searchParams.get('key') !== key) return send(res, 403, { error: 'Bad key.' });
    return send(res, 200, { count: reports.length, reports });
  }

  // POST /api/rooms  -> create
  if (seg[1] === 'rooms' && seg.length === 2 && method === 'POST') {
    if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'Server is at capacity. Try again shortly.' });
    const body = await readJson(req, 4096);
    const name = clean(body.name) || 'Player 1';
    const title = clean(body.title, 28);
    const code = newCode();
    const token = newToken();
    const room = { code, title, v: 0, state: null, players: [{ pid: 0, name, token }], clients: new Set(), host: token, touched: Date.now() };
    rooms.set(code, room);
    return send(res, 200, { code, title, pid: 0, token, host: true, roster: roster(room) });
  }

  const code = (seg[2] || '').toUpperCase();
  const room = rooms.get(code);
  if (seg[1] === 'rooms' && !room) return send(res, 404, { error: 'No table with that code. Check the letters and try again.' });
  const action = seg[3];

  // POST /api/rooms/:code/join
  if (action === 'join' && method === 'POST') {
    const body = await readJson(req, 4096);
    const name = clean(body.name) || `Player ${room.players.length + 1}`;
    if (body.token) {                                     // rejoin with an existing seat
      const seat = room.players.find(p => p.token === body.token);
      if (seat) { touch(room); return send(res, 200, { code, title: room.title || '', pid: seat.pid, token: seat.token, host: room.host === seat.token, roster: roster(room), v: room.v, state: room.state }); }
    }
    if (room.state) return send(res, 409, { error: 'That game has already started.' });
    if (room.players.length >= 8) return send(res, 409, { error: 'That table is full (8 players).' });
    const token = newToken();
    const pid = room.players.length;
    room.players.push({ pid, name, token });
    touch(room);
    broadcast(room, 'roster', roster(room));
    return send(res, 200, { code, title: room.title || '', pid, token, host: false, roster: roster(room), v: room.v, state: room.state });
  }

  // GET /api/rooms/:code/events?token=  -> SSE
  if (action === 'events' && method === 'GET') {
    const token = url.searchParams.get('token');
    const seat = room.players.find(p => p.token === token);
    if (!seat) return send(res, 403, { error: 'Not a member of this table.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const client = { res, token, pid: seat.pid };
    room.clients.add(client);
    touch(room);
    res.write(`event: sync\ndata: ${JSON.stringify({ v: room.v, state: room.state, roster: roster(room), voice: room.voice || [] })}\n\n`);
    broadcast(room, 'roster', roster(room));
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    const drop = () => {
      clearInterval(beat);
      room.clients.delete(client);
      if (!rooms.has(code)) return;
      const stillHere = [...room.clients].some(c => c.pid === seat.pid);
      if (!stillHere && room.voice && room.voice.includes(seat.pid)) {
        room.voice = room.voice.filter(pid => pid !== seat.pid);
        broadcast(room, 'voice', { voice: room.voice });
      }
      broadcast(room, 'roster', roster(room));
    };
    req.on('close', drop); req.on('error', drop);
    return;
  }

  // POST /api/rooms/:code/state  -> push a new full state
  // Only the player whose turn it is may write. That single rule removes every
  // write race during play; the draft (many simultaneous writers) uses /pick.
  if (action === 'state' && method === 'POST') {
    const body = await readJson(req);
    const seat = room.players.find(p => p.token === body.token);
    if (!seat) return send(res, 403, { error: 'Not a member of this table.' });
    const st = room.state;
    if (st && !st.over) {
      if (st.phase === 'draft') {
        return send(res, 409, { error: 'Job picks are drafted, not pushed.', v: room.v, state: st });
      }
      if (typeof st.turnIdx === 'number' && st.turnIdx !== seat.pid) {
        return send(res, 409, { error: 'Not your turn.', v: room.v, state: st });
      }
    }
    if (typeof body.v === 'number' && body.v !== room.v) {
      // Someone else moved first — hand back the truth so the client can rebase.
      return send(res, 409, { error: 'stale', v: room.v, state: room.state });
    }
    room.v++;
    room.state = body.state;
    touch(room);
    broadcast(room, 'state', { v: room.v, state: room.state, by: seat.pid }, body.token);
    return send(res, 200, { v: room.v });
  }

  // POST /api/rooms/:code/pick  -> claim a job during the draft.
  // Merged field-by-field on the server so simultaneous picks cannot clobber.
  if (action === 'pick' && method === 'POST') {
    const body = await readJson(req, 4096);
    const seat = room.players.find(p => p.token === body.token);
    if (!seat) return send(res, 403, { error: 'Not a member of this table.' });
    const st = room.state;
    if (!st || st.phase !== 'draft') return send(res, 409, { error: 'The draft is over.', v: room.v, state: st });
    const me = st.players[seat.pid];
    if (!me) return send(res, 409, { error: 'No seat in this game.' });
    if (me.job) return send(res, 409, { error: 'You already chose.', v: room.v, state: st });
    const offered = (st.draft && st.draft.offers && st.draft.offers[seat.pid]) || [];
    if (!offered.includes(body.job)) return send(res, 400, { error: 'That job was not offered to you.' });

    me.job = body.job;
    st.draft.picked[seat.pid] = body.job;
    st.log.unshift({ r: st.round, h: `<b>${clean(me.name)}</b> takes work as a <b>${clean(body.label || body.job, 24)}</b>.` });
    if (st.players.every(p => p.job)) st.phase = 'play';
    room.v++;
    touch(room);
    broadcast(room, 'state', { v: room.v, state: st, by: seat.pid });
    return send(res, 200, { v: room.v, state: st });
  }

  // POST /api/rooms/:code/signal -> relay one WebRTC message to one peer.
  // The server never inspects the payload; it only routes it.
  if (action === 'signal' && method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    const seat = room.players.find(p => p.token === body.token);
    if (!seat) return send(res, 403, { error: 'Not a member of this table.' });
    const to = Number(body.to);
    if (!Number.isInteger(to)) return send(res, 400, { error: 'No recipient.' });
    touch(room);
    const sent = sendTo(room, to, 'signal', { from: seat.pid, kind: body.kind, data: body.data });
    return send(res, 200, { delivered: sent });
  }

  // POST /api/rooms/:code/voice -> announce joining or leaving the call
  if (action === 'voice' && method === 'POST') {
    const body = await readJson(req, 4096);
    const seat = room.players.find(p => p.token === body.token);
    if (!seat) return send(res, 403, { error: 'Not a member of this table.' });
    room.voice = room.voice || [];
    const on = !!body.on;
    room.voice = room.voice.filter(pid => pid !== seat.pid);
    if (on) room.voice.push(seat.pid);
    touch(room);
    broadcast(room, 'voice', { voice: room.voice });
    return send(res, 200, { voice: room.voice });
  }

  // POST /api/rooms/:code/pact -> answer an alliance offer.
  // The responder is not the current player, so this is merged server-side the
  // same way job picks are, rather than pushed as a whole state.
  if (action === 'pact' && method === 'POST') {
    const body = await readJson(req, 4096);
    const seat = room.players.find(p => p.token === body.token);
    if (!seat) return send(res, 403, { error: 'Not a member of this table.' });
    const st = room.state;
    if (!st || !st.pact) return send(res, 409, { error: 'There is no offer on the table.', v: room.v, state: st });
    if (st.pact.to !== seat.pid) return send(res, 409, { error: 'That offer is not yours to answer.', v: room.v, state: st });

    const from = st.players[st.pact.from], to = st.players[st.pact.to];
    const held = id => (st.alliances || []).some(a => a.a === id || a.b === id);
    st.alliances = st.alliances || [];
    if (body.kind === 'accept' && from && to && !held(from.id) && !held(to.id)) {
      st.alliances.push({ a: from.id, b: to.id, since: st.round });
      st.log.unshift({ r: st.round, k: 'deed', h: `<b>${clean(from.name)}</b> and <b>${clean(to.name)}</b> strike an alliance.` });
    } else if (from && to) {
      st.log.unshift({ r: st.round, k: 'system', h: `<b>${clean(to.name)}</b> declines the alliance with <b>${clean(from.name)}</b>.` });
    }
    st.pact = null;
    room.v++;
    touch(room);
    broadcast(room, 'state', { v: room.v, state: st, by: seat.pid });
    return send(res, 200, { v: room.v, state: st });
  }

  // POST /api/rooms/:code/title -> host renames the table
  if (action === 'title' && method === 'POST') {
    const body = await readJson(req, 4096);
    if (body.token !== room.host) return send(res, 403, { error: 'Only the host can rename the table.' });
    room.title = clean(body.title, 28);
    touch(room);
    broadcast(room, 'roster', roster(room));
    return send(res, 200, { title: room.title });
  }

  // POST /api/rooms/:code/piece  -> claim a playing piece in the lobby, first come first served
  if (action === 'piece' && method === 'POST') {
    const body = await readJson(req, 4096);
    const seat = room.players.find(p => p.token === body.token);
    if (!seat) return send(res, 403, { error: 'Not a member of this table.' });
    if (room.state) return send(res, 409, { error: 'The game has already started.' });
    const piece = clean(body.piece, 16);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? body.color : null;
    if (room.players.some(p => p.pid !== seat.pid && p.piece === piece)) {
      return send(res, 409, { error: 'Someone already took that piece.', roster: roster(room) });
    }
    if (color && room.players.some(p => p.pid !== seat.pid && p.color === color)) {
      return send(res, 409, { error: 'Someone already took that colour.', roster: roster(room) });
    }
    seat.piece = piece;
    if (color) seat.color = color;
    touch(room);
    broadcast(room, 'roster', roster(room));
    return send(res, 200, { roster: roster(room) });
  }

  // POST /api/rooms/:code/say  -> table chat, kept out of the game state
  if (action === 'say' && method === 'POST') {
    const body = await readJson(req, 4096);
    const seat = room.players.find(p => p.token === body.token);
    if (!seat) return send(res, 403, { error: 'Not a member of this table.' });
    const text = clean(body.text, 140);
    if (!text) return send(res, 400, { error: 'Nothing to say.' });
    touch(room);
    broadcast(room, 'say', { pid: seat.pid, name: seat.name, text, at: Date.now() });
    return send(res, 200, { ok: true });
  }

  // GET /api/rooms/:code  -> snapshot (used on reconnect)
  if (!action && method === 'GET') return send(res, 200, { code, v: room.v, state: room.state, roster: roster(room) });

  return send(res, 404, { error: 'Unknown endpoint.' });
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(err => {
      if (!res.headersSent) send(res, 400, { error: err.message || 'Bad request' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, url.pathname);
});

server.keepAliveTimeout = 76000;   // sit above Render's 60s idle proxy timeout
server.headersTimeout = 77000;
server.requestTimeout = 0;         // SSE streams are meant to stay open

server.listen(PORT, () => console.log(`Monopoline listening on :${PORT}`));
