/* ═══════════════════════════════════════════════════════════════
   Monopoline on Cloudflare: static host + realtime rooms.
   The Worker serves public/ as static assets and hands /api/* to:
     • Room: one Durable Object per table. It holds the table's JSON state
       (saved to storage, so it survives restarts) and every live connection.
     • Hub: one Durable Object for the whole server, tracking which table
       codes are in use plus the bug-report inbox.
   Live updates go out over WebSockets, which can sit idle without being
   billed. Server-Sent Events stay available as a fallback for networks
   that block sockets. Every endpoint and rule matches server.js.
   ═══════════════════════════════════════════════════════════════ */
import { DurableObject } from 'cloudflare:workers';

const ROOM_TTL = 1000 * 60 * 60 * 8;       // rooms die 8h after last touch
const MAX_STATE = 1024 * 1024;             // 1MB ceiling on a pushed state
const MAX_ROOMS = 500;
const TOUCH_SAVE_EVERY = 1000 * 60 * 10;   // persist "last active" at most every 10 minutes
const OPEN = 1;                            // WebSocket readyState

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const randomIndex = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
const newCode = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomIndex(CODE_ALPHABET.length)]).join('');
const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const clean = (s, n = 14) => String(s == null ? '' : s).replace(/[\x00-\x1f<>]/g, '').trim().slice(0, n);

const hubOf = env => env.HUB.get(env.HUB.idFromName('hub'));
const roomOf = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));
const NO_TABLE = { error: 'No table with that code. Check the letters and try again.' };

/* ---------- helpers ---------- */
function send(status, body, headers = {}) {
  const text = typeof body === 'string';
  return new Response(text ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

async function readJson(request, limit = MAX_STATE) {
  if (Number(request.headers.get('content-length') || 0) > limit) throw new Error('payload too large');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > limit) throw new Error('payload too large');
  try { return JSON.parse(new TextDecoder().decode(buf) || '{}'); }
  catch { throw new Error('bad json'); }
}

/* ---------- Worker: routing + server-wide endpoints ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (err) {
      return send(400, { error: err.message || 'Bad request' });
    }
  },
};

async function api(request, env, url) {
  const seg = url.pathname.split('/').filter(Boolean);   // ['api','rooms',code,action]
  const method = request.method;
  const hub = hubOf(env);

  if (seg[1] === 'health') return send(200, { ok: true, ...(await hub.stats()) });

  // POST /api/report -> a bug report, from an online table or a solo device
  if (seg[1] === 'report' && method === 'POST') {
    const body = await readJson(request, 128 * 1024);
    const text = clean(body.text, 2000);
    if (!text) return send(400, { error: 'Describe what went wrong first.' });
    const entry = {
      at: new Date().toISOString(),
      from: clean(body.from, 24) || 'anonymous',
      code: clean(body.code, 8) || null,
      text, agent: clean(body.agent, 200),
      snapshot: typeof body.snapshot === 'string' ? body.snapshot.slice(0, 100000) : null,
    };
    const filed = await hub.fileReport(entry);
    // Workers Logs keeps console output, so this is where reports land.
    console.log(`[bug] ${entry.at} | ${entry.from}${entry.code ? ' @' + entry.code : ''} | ${entry.text.replace(/\s+/g, ' ').slice(0, 400)}`);
    return send(200, { ok: true, filed });
  }

  // ── moderator broadcasts ───────────────────────────────────
  // These reach every table, so they are gated by ADMIN_KEY when one is set.
  if (seg[1] === 'admin' && method === 'POST') {
    const body = await readJson(request, 8192);
    const key = env.ADMIN_KEY;
    if (key && body.key !== key) return send(403, { error: 'Bad moderator key.' });

    let event, payload;
    if (seg[2] === 'announce') {
      const text = clean(body.text, 240);
      if (!text) return send(400, { error: 'Nothing to announce.' });
      event = 'announce'; payload = { text, at: Date.now() };
    } else if (seg[2] === 'blackout') {
      event = 'blackout'; payload = { at: Date.now() };
    } else {
      return send(404, { error: 'Unknown moderator action.' });
    }

    const codes = await hub.codes();
    const reached = (await Promise.all(codes.map(code =>
      roomOf(env, code).adminBroadcast(event, payload).catch(() => -1)))).filter(n => n >= 0);
    const r = { tables: reached.length, people: reached.reduce((sum, n) => sum + n, 0) };
    console.log(event === 'announce'
      ? `[announce] ${payload.text} -> ${r.tables} tables, ${r.people} devices`
      : `[blackout] every device asked to reload -> ${r.tables} tables, ${r.people} devices`);
    return send(200, { ok: true, ...r });
  }

  // GET /api/reports?key=... -> read them back; only with ADMIN_KEY set
  if (seg[1] === 'reports' && method === 'GET') {
    const key = env.ADMIN_KEY;
    if (!key) return send(404, { error: 'Report viewing is disabled. Set ADMIN_KEY to enable it.' });
    if (url.searchParams.get('key') !== key) return send(403, { error: 'Bad key.' });
    const reports = await hub.reports();
    return send(200, { count: reports.length, reports });
  }

  // POST /api/rooms -> create
  if (seg[1] === 'rooms' && seg.length === 2 && method === 'POST') {
    const body = await readJson(request, 4096);
    const name = clean(body.name) || 'Player 1';
    const title = clean(body.title, 28);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await hub.claimCode(MAX_ROOMS);
      if (!code) return send(503, { error: 'Server is at capacity. Try again shortly.' });
      const made = await roomOf(env, code).create(code, name, title);
      if (made) return send(200, made);
    }
    return send(503, { error: 'Server is busy. Try again shortly.' });
  }

  // Everything under /api/rooms/:code belongs to that table's Room object.
  if (seg[1] === 'rooms') {
    const code = (seg[2] || '').toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(code)) return send(404, NO_TABLE);
    return roomOf(env, code).fetch(request);
  }

  return send(404, { error: 'Unknown endpoint.' });
}

/* ═══════════ Room: one table ═══════════ */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** { code, title, v, state, players:[{pid,name,token,piece,color}], host, voice, touched } */
    this.room = null;
    this.streams = new Set();   // SSE fallback connections: in memory, and they keep the object awake
    this.beat = null;
    this.lastSaved = 0;
    // Clients ping every 30s; the runtime answers without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || null;
    });
  }

  /* ---------- persistence ---------- */
  async save() {
    this.room.touched = Date.now();
    this.lastSaved = this.room.touched;
    await this.ctx.storage.put('room', this.room);
  }
  touch() {
    const now = Date.now();
    this.room.touched = now;
    if (now - this.lastSaved > TOUCH_SAVE_EVERY) {
      this.lastSaved = now;
      this.ctx.storage.put('room', this.room);
    }
  }

  /* ---------- connections ---------- */
  peers(exceptSocket) {
    const list = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exceptSocket || ws.readyState !== OPEN) continue;
      const a = ws.deserializeAttachment();
      if (a) list.push({ pid: a.pid, token: a.token, ws });
    }
    for (const s of this.streams) list.push({ pid: s.pid, token: s.token, stream: s });
    return list;
  }
  roster(exceptSocket) {
    const r = this.room;
    return {
      title: r.title || '',
      players: r.players.map(p => ({ pid: p.pid, name: p.name, piece: p.piece || null, color: p.color || null })),
      online: this.peers(exceptSocket).map(c => c.pid),
    };
  }
  syncPayload() {
    return { v: this.room.v, state: this.room.state, roster: this.roster(), voice: this.room.voice || [] };
  }
  deliver(peer, event, json) {
    if (peer.ws) {
      try { peer.ws.send(`${event}\n${json}`); } catch { /* closing; its close handler cleans up */ }
    } else {
      peer.stream.write(`event: ${event}\ndata: ${json}\n\n`);
    }
  }
  broadcast(event, payload, exceptToken, exceptSocket) {
    const json = JSON.stringify(payload);
    let reached = 0;
    for (const p of this.peers(exceptSocket)) {
      if (exceptToken && p.token === exceptToken) continue;
      this.deliver(p, event, json);
      reached++;
    }
    return reached;
  }
  sendTo(pid, event, payload) {
    const json = JSON.stringify(payload);
    let sent = 0;
    for (const p of this.peers()) {
      if (p.pid !== pid) continue;
      this.deliver(p, event, json);
      sent++;
    }
    return sent;
  }
  left(pid, closingSocket) {
    if (!this.room) return;
    const stillHere = this.peers(closingSocket).some(p => p.pid === pid);
    if (!stillHere && this.room.voice && this.room.voice.includes(pid)) {
      this.room.voice = this.room.voice.filter(v => v !== pid);
      this.ctx.storage.put('room', this.room);
      this.broadcast('voice', { voice: this.room.voice }, null, closingSocket);
    }
    this.broadcast('roster', this.roster(closingSocket), null, closingSocket);
  }

  async webSocketMessage() { /* clients only send pings, which the runtime answers itself */ }
  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* already closed */ }
    const a = ws.deserializeAttachment();
    if (a) this.left(a.pid, ws);
  }
  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a) this.left(a.pid, ws);
  }

  openStream(seat) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const stream = {
      pid: seat.pid, token: seat.token, writer,
      write: text => { writer.write(enc.encode(text)).catch(() => this.dropStream(stream)); },
    };
    this.streams.add(stream);
    writer.closed.then(() => this.dropStream(stream), () => this.dropStream(stream));
    if (!this.beat) this.beat = setInterval(() => { for (const s of this.streams) s.write(': ping\n\n'); }, 25000);
    const response = new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
    return { stream, response };
  }
  dropStream(stream) {
    if (!this.streams.delete(stream)) return;
    if (!this.streams.size) { clearInterval(this.beat); this.beat = null; }
    this.left(stream.pid);
  }

  /* ---------- called by the Worker ---------- */
  async create(code, name, title) {
    if (this.room) return null;                 // that code is still a live table
    const token = newToken();
    this.room = { code, title, v: 0, state: null, players: [{ pid: 0, name, token }], host: token, voice: [], touched: Date.now() };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL);
    return { code, title, pid: 0, token, host: true, roster: this.roster() };
  }

  async adminBroadcast(event, payload) {
    if (!this.room) return -1;
    return this.broadcast(event, payload);
  }

  // Rooms die 8h after their last touch, as on the Node server.
  async alarm() {
    if (!this.room) return;
    const due = this.room.touched + ROOM_TTL;
    if (Date.now() < due) { await this.ctx.storage.setAlarm(due); return; }
    const code = this.room.code;
    this.room = null;
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'Table closed'); } catch { /* gone */ } }
    for (const s of this.streams) s.writer.close().catch(() => {});
    this.streams.clear();
    clearInterval(this.beat); this.beat = null;
    await this.ctx.storage.deleteAll();
    await hubOf(this.env).release(code);
  }

  async fetch(request) {
    if (!this.room) return send(404, NO_TABLE);
    try {
      return await this.handle(request, new URL(request.url));
    } catch (err) {
      return send(400, { error: err.message || 'Bad request' });
    }
  }

  async handle(request, url) {
    const room = this.room;
    const action = url.pathname.split('/').filter(Boolean)[3];
    const method = request.method;
    const code = room.code;
    const seatFor = token => room.players.find(p => p.token === token);

    // POST /api/rooms/:code/join
    if (action === 'join' && method === 'POST') {
      const body = await readJson(request, 4096);
      const name = clean(body.name) || `Player ${room.players.length + 1}`;
      if (body.token) {                                     // rejoin with an existing seat
        const seat = seatFor(body.token);
        if (seat) { this.touch(); return send(200, { code, title: room.title || '', pid: seat.pid, token: seat.token, host: room.host === seat.token, roster: this.roster(), v: room.v, state: room.state }); }
      }
      if (room.state) return send(409, { error: 'That game has already started.' });
      if (room.players.length >= 8) return send(409, { error: 'That table is full (8 players).' });
      const token = newToken();
      const pid = room.players.length;
      room.players.push({ pid, name, token });
      await this.save();
      this.broadcast('roster', this.roster());
      return send(200, { code, title: room.title || '', pid, token, host: false, roster: this.roster(), v: room.v, state: room.state });
    }

    // GET /api/rooms/:code/socket?token= -> WebSocket (the normal live connection)
    if (action === 'socket' && method === 'GET') {
      const seat = seatFor(url.searchParams.get('token'));
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return send(426, { error: 'Expected a WebSocket.' });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ pid: seat.pid, token: seat.token });
      this.touch();
      server.send(`sync\n${JSON.stringify(this.syncPayload())}`);
      this.broadcast('roster', this.roster());
      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /api/rooms/:code/events?token= -> SSE (fallback when sockets are blocked)
    if (action === 'events' && method === 'GET') {
      const seat = seatFor(url.searchParams.get('token'));
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      const { stream, response } = this.openStream(seat);
      this.touch();
      stream.write('retry: 3000\n\n');
      stream.write(`event: sync\ndata: ${JSON.stringify(this.syncPayload())}\n\n`);
      this.broadcast('roster', this.roster());
      return response;
    }

    // POST /api/rooms/:code/state -> push a new full state
    // Only the player whose turn it is may write; the draft uses /pick.
    if (action === 'state' && method === 'POST') {
      const body = await readJson(request);
      const seat = seatFor(body.token);
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      const st = room.state;
      if (st && !st.over) {
        if (st.phase === 'draft') {
          return send(409, { error: 'Job picks are drafted, not pushed.', v: room.v, state: st });
        }
        if (typeof st.turnIdx === 'number' && st.turnIdx !== seat.pid) {
          return send(409, { error: 'Not your turn.', v: room.v, state: st });
        }
      }
      if (typeof body.v === 'number' && body.v !== room.v) {
        // Someone else moved first: hand back the truth so the client can rebase.
        return send(409, { error: 'stale', v: room.v, state: room.state });
      }
      room.v++;
      room.state = body.state;
      await this.save();
      this.broadcast('state', { v: room.v, state: room.state, by: seat.pid }, body.token);
      return send(200, { v: room.v });
    }

    // POST /api/rooms/:code/pick -> claim a job during the draft (merged server-side)
    if (action === 'pick' && method === 'POST') {
      const body = await readJson(request, 4096);
      const seat = seatFor(body.token);
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      const st = room.state;
      if (!st || st.phase !== 'draft') return send(409, { error: 'The draft is over.', v: room.v, state: st });
      const me = st.players[seat.pid];
      if (!me) return send(409, { error: 'No seat in this game.' });
      if (me.job) return send(409, { error: 'You already chose.', v: room.v, state: st });
      const offered = (st.draft && st.draft.offers && st.draft.offers[seat.pid]) || [];
      if (!offered.includes(body.job)) return send(400, { error: 'That job was not offered to you.' });

      me.job = body.job;
      st.draft.picked[seat.pid] = body.job;
      st.log.unshift({ r: st.round, h: `<b>${clean(me.name)}</b> takes work as a <b>${clean(body.label || body.job, 24)}</b>.` });
      if (st.players.every(p => p.job)) st.phase = 'play';
      room.v++;
      await this.save();
      this.broadcast('state', { v: room.v, state: st, by: seat.pid });
      return send(200, { v: room.v, state: st });
    }

    // POST /api/rooms/:code/signal -> relay one WebRTC message to one peer
    if (action === 'signal' && method === 'POST') {
      const body = await readJson(request, 64 * 1024);
      const seat = seatFor(body.token);
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      const to = Number(body.to);
      if (!Number.isInteger(to)) return send(400, { error: 'No recipient.' });
      this.touch();
      const delivered = this.sendTo(to, 'signal', { from: seat.pid, kind: body.kind, data: body.data });
      return send(200, { delivered });
    }

    // POST /api/rooms/:code/voice -> announce joining or leaving the call
    if (action === 'voice' && method === 'POST') {
      const body = await readJson(request, 4096);
      const seat = seatFor(body.token);
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      room.voice = (room.voice || []).filter(pid => pid !== seat.pid);
      if (body.on) room.voice.push(seat.pid);
      await this.save();
      this.broadcast('voice', { voice: room.voice });
      return send(200, { voice: room.voice });
    }

    // POST /api/rooms/:code/trade -> the other player answers a trade offer
    if (action === 'trade' && method === 'POST') {
      const body = await readJson(request, 4096);
      const seat = seatFor(body.token);
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      const st = room.state;
      if (!st || !st.trade) return send(409, { error: 'There is no offer on the table.', v: room.v, state: st });
      if (st.trade.to !== seat.pid) return send(409, { error: 'That offer is not yours to answer.', v: room.v, state: st });

      const deal = st.trade;
      const from = st.players[deal.from], to = st.players[deal.to];
      st.trade = null;
      const say = (h, k) => st.log.unshift({ r: st.round, k: k || 'system', h });

      if (body.kind !== 'accept') {
        say(`<b>${clean(to.name)}</b> turns down the trade with <b>${clean(from.name)}</b>.`);
      } else {
        // re-check the terms: the board may have moved since the offer was made
        const holds = (who, bag) => {
          if (who.cash < bag.cash) return `${clean(who.name)} no longer has the cash.`;
          if ((who.cards || 0) < bag.cards) return `${clean(who.name)} no longer holds those cards.`;
          for (const i of bag.props) {
            const o = st.own[i];
            if (!o || o.owner !== who.id) return 'A deed in the offer has changed hands.';
            if (o.houses > 0) return 'A property in the offer has buildings on it.';
          }
          return null;
        };
        const why = (!from || !to || from.bankrupt || to.bankrupt)
          ? 'A player in the trade has left the game.'
          : (holds(from, deal.give) || holds(to, deal.want));
        if (why) {
          say(`The trade between <b>${clean(from.name)}</b> and <b>${clean(to.name)}</b> fell through — ${why}`);
        } else {
          from.cash -= deal.give.cash; to.cash += deal.give.cash;
          to.cash -= deal.want.cash; from.cash += deal.want.cash;
          from.cards = (from.cards || 0) - deal.give.cards; to.cards = (to.cards || 0) + deal.give.cards;
          to.cards = (to.cards || 0) - deal.want.cards; from.cards = (from.cards || 0) + deal.want.cards;
          deal.give.props.forEach(i => { if (st.own[i]) st.own[i].owner = to.id; });
          deal.want.props.forEach(i => { if (st.own[i]) st.own[i].owner = from.id; });
          [from, to].forEach(q => { if (q.job === 'realtor') q.cash += 50; });
          say(`<b>${clean(from.name)}</b> and <b>${clean(to.name)}</b> shake on a trade.`, 'deed');
        }
      }

      room.v++;
      await this.save();
      this.broadcast('state', { v: room.v, state: st, by: seat.pid });
      return send(200, { v: room.v, state: st });
    }

    // POST /api/rooms/:code/pact -> answer an alliance offer (merged server-side)
    if (action === 'pact' && method === 'POST') {
      const body = await readJson(request, 4096);
      const seat = seatFor(body.token);
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      const st = room.state;
      if (!st || !st.pact) return send(409, { error: 'There is no offer on the table.', v: room.v, state: st });
      if (st.pact.to !== seat.pid) return send(409, { error: 'That offer is not yours to answer.', v: room.v, state: st });

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
      await this.save();
      this.broadcast('state', { v: room.v, state: st, by: seat.pid });
      return send(200, { v: room.v, state: st });
    }

    // POST /api/rooms/:code/title -> host renames the table
    if (action === 'title' && method === 'POST') {
      const body = await readJson(request, 4096);
      if (body.token !== room.host) return send(403, { error: 'Only the host can rename the table.' });
      room.title = clean(body.title, 28);
      await this.save();
      this.broadcast('roster', this.roster());
      return send(200, { title: room.title });
    }

    // POST /api/rooms/:code/piece -> claim a playing piece in the lobby, first come first served
    if (action === 'piece' && method === 'POST') {
      const body = await readJson(request, 4096);
      const seat = seatFor(body.token);
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      if (room.state) return send(409, { error: 'The game has already started.' });
      const piece = clean(body.piece, 16);
      const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? body.color : null;
      if (room.players.some(p => p.pid !== seat.pid && p.piece === piece)) {
        return send(409, { error: 'Someone already took that piece.', roster: this.roster() });
      }
      if (color && room.players.some(p => p.pid !== seat.pid && p.color === color)) {
        return send(409, { error: 'Someone already took that colour.', roster: this.roster() });
      }
      seat.piece = piece;
      if (color) seat.color = color;
      await this.save();
      this.broadcast('roster', this.roster());
      return send(200, { roster: this.roster() });
    }

    // POST /api/rooms/:code/say -> table chat, kept out of the game state
    if (action === 'say' && method === 'POST') {
      const body = await readJson(request, 4096);
      const seat = seatFor(body.token);
      if (!seat) return send(403, { error: 'Not a member of this table.' });
      const text = clean(body.text, 140);
      if (!text) return send(400, { error: 'Nothing to say.' });
      this.touch();
      this.broadcast('say', { pid: seat.pid, name: seat.name, text, at: Date.now() });
      return send(200, { ok: true });
    }

    // GET /api/rooms/:code -> snapshot (used on reconnect)
    if (!action && method === 'GET') return send(200, { code, v: room.v, state: room.state, roster: this.roster() });

    return send(404, { error: 'Unknown endpoint.' });
  }
}

/* ═══════════ Hub: the whole server ═══════════ */
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.started = Date.now();
  }

  async claimCode(max) {
    const used = await this.ctx.storage.list({ prefix: 'room:' });
    if (used.size >= max) return null;
    let code;
    do { code = newCode(); } while (used.has('room:' + code));
    await this.ctx.storage.put('room:' + code, Date.now());
    return code;
  }
  async release(code) {
    await this.ctx.storage.delete('room:' + code);
  }
  async codes() {
    return [...(await this.ctx.storage.list({ prefix: 'room:' })).keys()].map(k => k.slice(5));
  }

  // Newest-first, latest 200. Each report is its own key so none hits the 2MB value cap.
  async fileReport(entry) {
    const index = (await this.ctx.storage.get('reports')) || [];
    const key = `report:${Date.now()}:${newToken().slice(0, 6)}`;
    index.unshift(key);
    await this.ctx.storage.put(key, entry);
    while (index.length > 200) await this.ctx.storage.delete(index.pop());
    await this.ctx.storage.put('reports', index);
    return index.length;
  }
  async reports() {
    const index = (await this.ctx.storage.get('reports')) || [];
    const out = [];
    for (let i = 0; i < index.length; i += 128) {   // storage.get takes at most 128 keys at once
      const keys = index.slice(i, i + 128);
      const got = await this.ctx.storage.get(keys);
      for (const k of keys) if (got.has(k)) out.push(got.get(k));
    }
    return out;
  }
  async stats() {
    const rooms = (await this.ctx.storage.list({ prefix: 'room:' })).size;
    const reports = ((await this.ctx.storage.get('reports')) || []).length;
    return { rooms, reports, up: Math.round((Date.now() - this.started) / 1000) };
  }
}
