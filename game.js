'use strict';
/* 200 Club game server. One endpoint, POST /api/game {op, tok, ...}.
   The server is the dealer: it shuffles, deals, runs timers and only ever sends
   each player their own hole cards. State lives in Upstash Redis (REST API). */
const nodeCrypto = require('crypto');
const E = require('../lib/engine.js');

// Works with Vercel's Upstash integration (any env prefix) or a database made at upstash.com.
function envEnding(ends) {
  for (const k of Object.keys(process.env)) {
    if (/READ_ONLY/.test(k)) continue;
    if (ends.some(e => k.endsWith(e)) && process.env[k]) return process.env[k];
  }
  return '';
}
const RURL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envEnding(['_REST_API_URL', 'REDIS_REST_URL'])).replace(/\/$/, '');
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envEnding(['_REST_API_TOKEN', 'REDIS_REST_TOKEN']);
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMOJI = ['\uD83D\uDC4F', '\uD83D\uDE02', '\uD83D\uDE2C', '\uD83D\uDD25', '\uD83E\uDD21', '\uD83D\uDC80'];
const ABSENT_AFTER = 15000;          // no heartbeat for this long = away
const TABLE_TTL = String(30 * 86400); // idle tables expire after 30 days
const RELEASE = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

function fail(code) { const e = new Error(code); e.code = code; return e; }
async function pipe(cmds) {
  const r = await fetch(RURL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw fail('storage');
  const out = await r.json();
  return out.map(x => { if (x && x.error) throw fail('storage'); return x ? x.result : null; });
}
const cmd = async (...c) => (await pipe([c]))[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pidOf = tok => 'p' + nodeCrypto.createHash('sha256').update(tok).digest('hex').slice(0, 16);
function hash(arr) {
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  else if (arr && typeof arr === 'object') Object.assign(o, arr);
  return o;
}
function parse(s) { try { return typeof s === 'string' ? JSON.parse(s) : null; } catch (e) { return null; } }
function cleanCode(c) { c = String(c || '').toUpperCase(); return /^[A-Z0-9]{5}$/.test(c) ? c : null; }
function int(v) { v = Number(v); return Number.isFinite(v) ? Math.floor(v) : undefined; }
function randCode() { let s = ''; for (let i = 0; i < 5; i++) s += CODE_ALPHA[nodeCrypto.randomInt(CODE_ALPHA.length)]; return s; }

async function withLock(code, fn) {
  const key = 'lk:' + code, val = nodeCrypto.randomUUID();
  for (let i = 0; i < 60; i++) {
    if (await cmd('SET', key, val, 'NX', 'PX', '5000') === 'OK') {
      try { return await fn(); } finally { await cmd('EVAL', RELEASE, '1', key, val).catch(() => {}); }
    }
    await sleep(30 + Math.random() * 70);
  }
  throw fail('busy');
}

/* Elo for poker: after each hand, every player who won chips is scored against every
   player who lost chips. The swing is scaled by the pot: 50 big blinds or more counts in full. */
const START = 1200, K = 24;
function ratingOf(raw) {
  const r = parse(raw);
  return r && Number.isFinite(+r.r) ? r : { r: START, n: 0, pk: START };
}
function eloDeltas(H, bb, R) {
  const net = {}, d = {};
  for (const p of H.order) { net[p] = ((H.result.won || {})[p] || 0) - H.p[p].total; d[p] = 0; }
  const W = H.order.filter(p => net[p] > 0), L = H.order.filter(p => net[p] < 0);
  for (const l of L) {
    const share = -net[l] / W.length;
    const weight = Math.min(1, share / (50 * bb));
    for (const w of W) {
      const expect = 1 / (1 + Math.pow(10, (R[l] - R[w]) / 400));
      const x = K * weight * (1 - expect);
      d[w] += x; d[l] -= x;
    }
  }
  return d;
}
async function rateFinishedHand(T) {
  const H = T.hand;
  if (!H || !H.done || H.rated || !H.result) return null;
  const pids = H.order;
  const vals = await cmd('HMGET', 'rating', ...pids);
  const rec = {}, R = {};
  pids.forEach((p, i) => { rec[p] = ratingOf(vals && vals[i]); R[p] = +rec[p].r; });
  const d = eloDeltas(H, T.cfg.bb, R);
  const args = ['HSET', 'rating'], rd = {};
  for (const p of pids) {
    const r = rec[p];
    r.r = R[p] + d[p]; r.n = (r.n || 0) + 1; r.pk = Math.max(+r.pk || START, r.r); r.d = d[p];
    args.push(p, JSON.stringify(r));
    rd[p] = Math.round(d[p] * 10) / 10;
    if (T.players[p]) T.players[p].rt = Math.round(r.r);
    E.ledgerOf(T, p).rt = Math.round(r.r);
  }
  H.rated = 1; H.result.rd = rd;
  if (T.hist && T.hist[0] && T.hist[0].no === H.no) T.hist[0].rd = rd;
  return args;
}

function lobbyEntry(T) {
  const pids = Object.keys(T.players);
  const rts = pids.map(p => +T.players[p].rt || START);
  const avg = rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : 0;
  return { code: T.code, name: T.name, priv: !!T.priv, seated: pids.length, max: T.cfg.max, sb: T.cfg.sb, bb: T.cfg.bb, pids, avg, live: E.handLive(T), paused: !!T.paused, u: Date.now() };
}
function boardEntry(T) {
  const rows = {};
  for (const pid of Object.keys(T.ledger || {})) {
    const L = T.ledger[pid];
    rows[pid] = { b: L.b, c: L.c, s: T.players[pid] ? T.players[pid].stack : 0, h: L.h, w: L.w, x: L.x };
  }
  return { season: T.season, code: T.code, rows };
}
function aggregate(entries, season) {
  const agg = {};
  for (const doc of entries) {
    if (!doc || doc.season !== season || !doc.rows) continue;
    for (const pid of Object.keys(doc.rows)) {
      const r = doc.rows[pid] || {};
      const a = agg[pid] || (agg[pid] = { pid, net: 0, h: 0, w: 0, x: 0 });
      a.net += (+r.c || 0) + (+r.s || 0) - (+r.b || 0);
      a.h += +r.h || 0; a.w += +r.w || 0; a.x = Math.max(a.x, +r.x || 0);
    }
  }
  return Object.values(agg).filter(a => a.h > 0 || a.net !== 0).sort((a, b) => b.net - a.net || b.h - a.h);
}
async function nickMap(pids) {
  pids = [...new Set(pids)].filter(Boolean).slice(0, 300);
  if (!pids.length) return {};
  const vals = await cmd('HMGET', 'nicks', ...pids);
  const out = {};
  pids.forEach((p, i) => { if (vals && vals[i]) out[p] = vals[i]; });
  return out;
}

/* What one player is allowed to see: no deck, nobody else's hole cards until they're shown. */
function viewOf(T, pid) {
  const V = JSON.parse(JSON.stringify(T));
  delete V.ack;
  const H = V.hand;
  if (H) {
    delete H.deck;
    const shown = (H.done && H.result && H.result.shown) || {};
    for (const p of Object.keys(H.p)) {
      const q = H.p[p];
      const visible = p === pid || shown[p] || (H.reveal && !q.folded && !H.done);
      if (!visible) q.cards = [];
    }
  }
  return V;
}
async function respond(T, pid, since, seen, wantNicks) {
  const out = { now: Date.now(), v: T.v };
  if (seen) out.seen = seen;
  if (since !== undefined && +since === T.v) return out;
  out.T = viewOf(T, pid);
  if (wantNicks) out.nicks = await nickMap([pid, ...Object.keys(T.players), ...Object.keys(T.ledger || {})]);
  return out;
}

/* Load, change and save a table under its lock. The automatic dealer runs on every change. */
async function mutate(code, pid, intent, extra) {
  return withLock(code, async () => {
    const first = [['GET', 't:' + code], ['GET', 'meta:season'], ['HGETALL', 'seen:' + code]];
    if (intent && intent.k === 'join' && pid) first.push(['HGET', 'rating', pid]);
    const [raw, season, seenRaw, myRating] = await pipe(first);
    const T = parse(raw);
    if (!T) return { error: 'no_table' };
    const now = Date.now();
    const seen = hash(seenRaw);
    if (pid) seen[pid] = String(now);
    const before = JSON.stringify(T);
    let err = null;
    if (intent) { try { err = E.applyIntent(T, pid, intent, now); } catch (e) { err = 'bad_request'; } }
    if (intent && intent.k === 'join' && T.players[pid] && !T.players[pid].rt) {
      T.players[pid].rt = Math.round(+ratingOf(myRating).r);
      E.ledgerOf(T, pid).rt = T.players[pid].rt;
    }
    if (extra) extra(T, now);
    E.dealerStep(T, [], now, {
      holder: 'server', season: season || 'base', randInt: n => nodeCrypto.randomInt(n),
      absent: p => now - (+seen[p] || 0) > ABSENT_AFTER
    });
    const rated = await rateFinishedHand(T);
    const cmds = pid ? [['HSET', 'seen:' + code, pid, String(now)]] : [];
    if (rated) cmds.push(rated);
    if (JSON.stringify(T) !== before) {
      T.v = (+T.v || 0) + 1; T.t = now;
      cmds.push(['SET', 't:' + code, JSON.stringify(T), 'EX', TABLE_TTL], ['HSET', 'lobby', code, JSON.stringify(lobbyEntry(T))]);
      if (!E.handLive(T) && Object.keys(T.ledger || {}).length) cmds.push(['HSET', 'board:' + T.season, code, JSON.stringify(boardEntry(T))]);
    }
    if (cmds.length) await pipe(cmds);
    return { T, err, seen };
  });
}
function due(T, now, seen) {
  const w = E.nextWake(T);
  if (w && now >= w) return true;
  const H = T.hand;
  if (H && !H.done && !H.runout && H.toAct) {
    const pl = T.players[H.toAct];
    if (!pl || pl.out || pl.leaving) return true;
    if (seen && now - (+seen[H.toAct] || 0) > ABSENT_AFTER && now >= H.turnAt + (pl.missed ? 2500 : E.TIMING.ABSENT_MS)) return true;
  }
  return false;
}
function sanitizeIntent(it) {
  if (!it || typeof it !== 'object') return null;
  const k = it.k;
  if (!['join', 'leave', 'rebuy', 'sitout', 'sitin', 'act', 'cfg', 'kick'].includes(k)) return null;
  const out = { k };
  if (k === 'join') out.seat = int(it.seat);
  if (k === 'act') {
    if (!['fold', 'check', 'call', 'raise'].includes(it.a)) return null;
    out.a = it.a; out.h = int(it.h); out.s = int(it.s); out.to = int(it.to) || 0;
  }
  if (k === 'cfg') {
    if (int(it.bb) !== undefined) out.bb = int(it.bb);
    if (int(it.timer) !== undefined) out.timer = int(it.timer);
    if (typeof it.priv === 'boolean') out.priv = it.priv;
    if (typeof it.paused === 'boolean') out.paused = it.paused;
  }
  if (k === 'kick') { if (typeof it.who !== 'string' || it.who.length > 40) return null; out.who = it.who; }
  return out;
}

const OPS = {
  async lobby(pid) {
    const [season, seasonAt, lob] = await pipe([['GET', 'meta:season'], ['GET', 'meta:seasonAt'], ['HGETALL', 'lobby']]);
    const s = season || 'base';
    const [boardRaw, ratingRaw] = await pipe([['HGETALL', 'board:' + s], ['HGETALL', 'rating']]);
    const now = Date.now();
    const tables = Object.values(hash(lob)).map(parse).filter(x => x && x.code);
    const open = tables.filter(x => !x.priv && x.seated > 0 && now - (+x.u || 0) < 12 * 3600e3)
      .sort((a, b) => b.seated - a.seated || b.u - a.u).slice(0, 30);
    const mine = tables.filter(x => Array.isArray(x.pids) && x.pids.includes(pid) && now - (+x.u || 0) < 7 * 86400e3);
    const chips = {};
    aggregate(Object.values(hash(boardRaw)).map(parse), s).forEach(r => { chips[r.pid] = r; });
    const ratings = hash(ratingRaw);
    const pids = new Set([...Object.keys(chips), ...Object.keys(ratings)]);
    const board = [...pids].map(p => {
      const c = chips[p] || {}, r = ratingOf(ratings[p]);
      return { pid: p, rt: Math.round(+r.r), n: r.n || 0, pk: Math.round(+r.pk || START), net: c.net || 0, h: c.h || 0, w: c.w || 0, x: c.x || 0 };
    }).filter(r => r.n > 0 || r.h > 0).sort((a, b) => b.rt - a.rt || b.net - a.net).slice(0, 200);
    const meR = ratingOf(ratings[pid]);
    const nicks = await nickMap([pid, ...board.map(r => r.pid)]);
    return { open, mine, board, me: { rt: Math.round(+meR.r), n: meR.n || 0 }, nicks, season: s, seasonAt: +seasonAt || 0, canReset: !!process.env.ADMIN_PIN, now };
  },
  async exists(pid, b) {
    const code = cleanCode(b.code);
    return { exists: !!(code && await cmd('EXISTS', 't:' + code)) };
  },
  async nick(pid, b) {
    const v = E.cleanText(b.nick, 18);
    if (!v) return { error: 'bad_request' };
    await cmd('HSET', 'nicks', pid, v);
    return { nicks: { [pid]: v } };
  },
  async create(pid, b) {
    const [nick, season, myRating] = await pipe([['HGET', 'nicks', pid], ['GET', 'meta:season'], ['HGET', 'rating', pid]]);
    if (!nick) return { error: 'no_nick' };
    const pair = E.BLINDS.find(x => x[1] === int(b.bb)) || [1, 2];
    const timer = [20, 30, 45].includes(int(b.timer)) ? int(b.timer) : 30;
    const max = int(b.max) === 6 ? 6 : 8;
    for (let i = 0; i < 8; i++) {
      const code = randCode(), now = Date.now();
      const T = E.newTable({ code, name: E.cleanText(b.name, 28) || 'Poker night', host: pid, priv: !!b.priv, sb: pair[0], bb: pair[1], timer, max, now, season: season || 'base' });
      E.join(T, pid, 0, now);
      T.players[pid].rt = Math.round(+ratingOf(myRating).r);
      E.ledgerOf(T, pid).rt = T.players[pid].rt;
      T.dealer = 'server'; T.v = 1; T.t = now;
      if (await cmd('SET', 't:' + code, JSON.stringify(T), 'NX', 'EX', TABLE_TTL) === 'OK') {
        await pipe([['HSET', 'lobby', code, JSON.stringify(lobbyEntry(T))], ['HSET', 'seen:' + code, pid, String(now)], ['PEXPIRE', 'seen:' + code, '86400000']]);
        return { code };
      }
    }
    return { error: 'busy' };
  },
  async state(pid, b) {
    const code = cleanCode(b.code);
    if (!code) return { error: 'no_table' };
    const now = Date.now();
    const cmds = [['GET', 't:' + code]];
    if (b.hb) cmds.push(['HSET', 'seen:' + code, pid, String(now)], ['HGETALL', 'seen:' + code]);
    const out = await pipe(cmds);
    let T = parse(out[0]);
    if (!T) return { error: 'no_table' };
    let seen = b.hb ? hash(out[2]) : null;
    if (due(T, Date.now(), seen)) {
      const r = await mutate(code, null, null);
      if (r.T) { T = r.T; if (seen) seen = r.seen; }
    }
    return respond(T, pid, b.since, seen, !!b.nk);
  },
  async act(pid, b) {
    const code = cleanCode(b.code), it = sanitizeIntent(b.intent);
    if (!code || !it) return { error: 'bad_request' };
    if (it.k === 'join' && !(await cmd('HGET', 'nicks', pid))) return { error: 'no_nick' };
    const r = await mutate(code, pid, it);
    if (r.error) return r;
    const out = await respond(r.T, pid, undefined, r.seen, !!b.nk);
    out.err = r.err || null;
    return out;
  },
  async react(pid, b) {
    const code = cleanCode(b.code);
    if (!code || !EMOJI.includes(b.e)) return { error: 'bad_request' };
    const r = await mutate(code, pid, null, (T, now) => {
      const fx = Array.isArray(T.fx) ? T.fx : [];
      if (!T.players[pid] && Object.keys(T.players).length) { /* watchers can react too */ }
      if (fx[0] && fx[0].pid === pid && now - fx[0].at < 1000) return;
      T.fx = [{ id: nodeCrypto.randomBytes(4).toString('hex'), e: b.e, pid, at: now }].concat(fx).slice(0, 8);
    });
    if (r.error) return r;
    return respond(r.T, pid, undefined, r.seen, !!b.nk);
  },
  async reset(pid, b) {
    const pin = process.env.ADMIN_PIN;
    const given = String(b.pin || '');
    if (!pin || given.length !== pin.length || !nodeCrypto.timingSafeEqual(Buffer.from(given), Buffer.from(pin))) return { error: 'bad_pin' };
    const now = Date.now();
    await pipe([['SET', 'meta:season', 's' + now.toString(36)], ['SET', 'meta:seasonAt', String(now)]]);
    return { ok: true };
  }
};

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 20000) req.destroy(); });
    req.on('end', () => resolve(parse(buf) || {}));
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!RURL || !RTOK) return send(res, 500, { error: 'no_storage' });
  let b = req.body;
  if (typeof b === 'string') b = parse(b);
  if (!b || typeof b !== 'object') b = await readJson(req);
  const tok = typeof b.tok === 'string' && b.tok.length >= 20 && b.tok.length <= 100 ? b.tok : null;
  if (!tok) return send(res, 400, { error: 'no_token' });
  const op = OPS[b.op];
  if (!op) return send(res, 400, { error: 'unknown_op' });
  try {
    const out = await op(pidOf(tok), b);
    return send(res, out && out.error ? (out.error === 'no_table' ? 404 : 400) : 200, out);
  } catch (e) {
    return send(res, e.code === 'busy' ? 503 : 500, { error: e.code || 'server' });
  }
};
