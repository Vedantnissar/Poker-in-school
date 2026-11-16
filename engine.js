/* 200 Club — No-Limit Hold'em engine. Pure functions over a plain-JSON table object.
   Every function mutates the table it is given; callers clone first. */
(function (root) {
  'use strict';

  var RANKS = '23456789TJQKA';
  var SUITS = 'shdc';
  var RV = {};
  for (var i = 0; i < 13; i++) RV[RANKS[i]] = i + 2;
  var WORD = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace' };
  var PLURAL = { 2: 'twos', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes', 7: 'sevens', 8: 'eights', 9: 'nines', 10: 'tens', 11: 'jacks', 12: 'queens', 13: 'kings', 14: 'aces' };

  var TIMING = {
    GRACE_MS: 1500,    // slack on top of the turn timer
    ABSENT_MS: 12000,  // turn limit for a player whose app is closed
    RUNOUT_MS: 1300,   // pause between streets when everyone is all in
    RESULT_MS: 6000,   // pause after a showdown before the next hand
    QUICK_MS: 2600     // pause after an uncontested pot
  };

  /* ---------------- cards ---------------- */
  function freshDeck() {
    var d = [];
    for (var r = 0; r < 13; r++) for (var s = 0; s < 4; s++) d.push(RANKS[r] + SUITS[s]);
    return d;
  }
  function shuffle(arr, randInt) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function cryptoRandInt(n) {
    var max = Math.floor(4294967296 / n) * n;
    var buf = new Uint32Array(1), x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= max);
    return x % n;
  }

  /* ---------------- hand evaluation ---------------- */
  function rank5(c) {
    var rs = [], ss = [], k;
    for (k = 0; k < 5; k++) { rs.push(RV[c[k][0]]); ss.push(c[k][1]); }
    rs.sort(function (a, b) { return b - a; });
    var flush = ss[0] === ss[1] && ss[0] === ss[2] && ss[0] === ss[3] && ss[0] === ss[4];
    var cnt = {};
    for (k = 0; k < 5; k++) cnt[rs[k]] = (cnt[rs[k]] || 0) + 1;
    var groups = Object.keys(cnt).map(function (r) { return [+r, cnt[r]]; })
      .sort(function (a, b) { return b[1] - a[1] || b[0] - a[0]; });
    var straightHigh = 0;
    if (groups.length === 5) {
      if (rs[0] - rs[4] === 4) straightHigh = rs[0];
      else if (rs[0] === 14 && rs[1] === 5 && rs[4] === 2) straightHigh = 5;
    }
    var cat, tb;
    if (straightHigh && flush) { cat = 8; tb = [straightHigh]; }
    else if (groups[0][1] === 4) { cat = 7; tb = [groups[0][0], groups[1][0]]; }
    else if (groups[0][1] === 3 && groups[1][1] === 2) { cat = 6; tb = [groups[0][0], groups[1][0]]; }
    else if (flush) { cat = 5; tb = rs.slice(); }
    else if (straightHigh) { cat = 4; tb = [straightHigh]; }
    else if (groups[0][1] === 3) { cat = 3; tb = groups.map(function (g) { return g[0]; }); }
    else if (groups[0][1] === 2 && groups[1][1] === 2) { cat = 2; tb = [groups[0][0], groups[1][0], groups[2][0]]; }
    else if (groups[0][1] === 2) { cat = 1; tb = groups.map(function (g) { return g[0]; }); }
    else { cat = 0; tb = rs.slice(); }
    var score = cat;
    for (k = 0; k < 5; k++) score = score * 15 + (tb[k] || 0);
    return { score: score, cat: cat, tb: tb };
  }
  function best(cards) {
    var n = cards.length, top = null;
    if (n < 5) return null;
    for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) for (var c = b + 1; c < n; c++)
      for (var d = c + 1; d < n; d++) for (var e = d + 1; e < n; e++) {
        var five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
        var r = rank5(five);
        if (!top || r.score > top.score) { r.five = five; top = r; }
      }
    return top;
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function handName(r) {
    if (!r) return '';
    var a = r.tb[0], b = r.tb[1];
    switch (r.cat) {
      case 8: return a === 14 ? 'Royal flush' : 'Straight flush, ' + WORD[a] + ' high';
      case 7: return 'Four ' + PLURAL[a];
      case 6: return 'Full house, ' + PLURAL[a] + ' full of ' + PLURAL[b];
      case 5: return 'Flush, ' + WORD[a] + ' high';
      case 4: return 'Straight, ' + WORD[a] + ' high';
      case 3: return 'Three ' + PLURAL[a];
      case 2: return 'Two pair, ' + PLURAL[a] + ' and ' + PLURAL[b];
      case 1: return 'Pair of ' + PLURAL[a];
      default: return cap(WORD[a]) + ' high';
    }
  }
  /* What you hold right now, for the hint under your cards (works with 2+ cards). */
  function describe(cards) {
    if (!cards || cards.length < 2) return '';
    if (cards.length >= 5) return handName(best(cards));
    var rs = cards.map(function (c) { return RV[c[0]]; }).sort(function (x, y) { return y - x; });
    var cnt = {};
    rs.forEach(function (r) { cnt[r] = (cnt[r] || 0) + 1; });
    var g = Object.keys(cnt).map(function (r) { return [+r, cnt[r]]; }).sort(function (x, y) { return y[1] - x[1] || y[0] - x[0]; });
    if (g[0][1] === 2) return 'Pair of ' + PLURAL[g[0][0]];
    return cap(WORD[rs[0]]) + ' high';
  }

  /* ---------------- table helpers ---------------- */
  function ledgerOf(T, pid) {
    if (!T.ledger) T.ledger = {};
    if (!T.ledger[pid]) T.ledger[pid] = { b: 0, c: 0, h: 0, w: 0, x: 0 };
    return T.ledger[pid];
  }
  function seated(T) {
    return Object.keys(T.players).sort(function (a, b) { return T.players[a].seat - T.players[b].seat; });
  }
  function eligible(T) {
    return seated(T).filter(function (pid) {
      var p = T.players[pid];
      return !p.out && !p.leaving && p.stack > 0;
    });
  }
  function potTotal(H) {
    var s = 0;
    for (var pid in H.p) s += H.p[pid].total;
    return s;
  }
  function newTable(o) {
    return {
      code: o.code, name: o.name || 'Poker night', host: o.host, priv: !!o.priv,
      createdAt: o.now,
      cfg: { sb: o.sb || 1, bb: o.bb || 2, buyIn: o.buyIn || 200, timer: o.timer || 30, max: o.max || 8 },
      pend: null, paused: false, season: o.season || 'base',
      v: 0, t: o.now, dealer: null,
      players: {}, ledger: {}, ack: {},
      button: -1, handNo: 0, nextHandAt: 0, hand: null, hist: []
    };
  }
  function cashOut(T, pid) {
    var p = T.players[pid];
    if (!p) return;
    ledgerOf(T, pid).c += p.stack;
    delete T.players[pid];
  }
  function handLive(T) { return !!(T.hand && !T.hand.done); }

  /* ---------------- hand flow ---------------- */
  function pay(T, H, pid, amt) {
    var pl = T.players[pid], q = H.p[pid];
    var a = Math.max(0, Math.min(amt, pl.stack));
    pl.stack -= a; q.bet += a; q.total += a;
    if (pl.stack === 0) q.allIn = true;
    return a;
  }
  function needsAction(H, pid) {
    var q = H.p[pid];
    return !q.folded && !q.allIn && (!q.acted || q.bet < H.cur);
  }
  function startHand(T, now, randInt) {
    if (T.pend) {
      for (var k in T.pend) T.cfg[k] = T.pend[k];
      T.pend = null;
    }
    var order = eligible(T);
    if (order.length < 2) return false;
    var n = order.length;
    var bi = -1;
    for (var i = 0; i < n; i++) if (T.players[order[i]].seat > T.button) { bi = i; break; }
    if (bi < 0) bi = 0;
    T.button = T.players[order[bi]].seat;
    var sbI = n === 2 ? bi : (bi + 1) % n;
    var bbI = n === 2 ? (bi + 1) % n : (bi + 2) % n;
    var deck = shuffle(freshDeck(), randInt);
    var p = {};
    order.forEach(function (pid) {
      p[pid] = { cards: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, last: null };
    });
    for (var r = 0; r < 2; r++) for (var j = 1; j <= n; j++) p[order[(bi + j) % n]].cards.push(deck.pop());
    var H = {
      no: T.handNo + 1, order: order, btn: bi, sb: order[sbI], bb: order[bbI],
      deck: deck, board: [], p: p, street: 0, cur: T.cfg.bb, minR: T.cfg.bb,
      seq: 0, toAct: null, turnAt: now, runout: false, runoutAt: 0, reveal: false,
      done: false, result: null, startedAt: now, doneAt: 0
    };
    T.handNo = H.no;
    T.hand = H;
    order.forEach(function (pid) { ledgerOf(T, pid).h += 1; });
    pay(T, H, H.sb, T.cfg.sb); p[H.sb].last = { a: 'sb', amt: p[H.sb].bet };
    pay(T, H, H.bb, T.cfg.bb); p[H.bb].last = { a: 'bb', amt: p[H.bb].bet };
    H.log = [{ p: H.sb, a: 'sb', amt: p[H.sb].bet }, { p: H.bb, a: 'bb', amt: p[H.bb].bet }];
    var first = n === 2 ? bi : (bbI + 1) % n;
    progress(T, now, first, true);
    return true;
  }
  /* Decide what happens next after any change: next player, next street, or end of hand. */
  function progress(T, now, fromIdx, inclusive) {
    var H = T.hand;
    var alive = H.order.filter(function (pid) { return !H.p[pid].folded; });
    if (alive.length <= 1) { finishUncontested(T, alive[0], now); return; }
    var actors = alive.filter(function (pid) { return !H.p[pid].allIn; });
    var pending = actors.filter(function (pid) { return needsAction(H, pid); });
    if (!pending.length || !actors.length || (actors.length === 1 && H.p[actors[0]].bet >= H.cur)) {
      endStreet(T, now);
      return;
    }
    var n = H.order.length;
    var start = inclusive ? fromIdx : fromIdx + 1;
    for (var k = 0; k < n; k++) {
      var pid = H.order[(((start + k) % n) + n) % n];
      if (needsAction(H, pid)) {
        if (H.toAct !== pid) { H.toAct = pid; H.turnAt = now; }
        return;
      }
    }
  }
  function dealStreet(H) {
    H.street += 1;
    var k = H.street === 1 ? 3 : 1;
    for (var i = 0; i < k; i++) H.board.push(H.deck.pop());
    (H.log || (H.log = [])).push({ st: H.street, c: H.board.slice(-k) });
  }
  function endStreet(T, now) {
    var H = T.hand;
    H.order.forEach(function (pid) {
      var q = H.p[pid];
      q.bet = 0; q.acted = false;
      if (!q.folded && !q.allIn) q.last = null;
    });
    H.cur = 0; H.minR = T.cfg.bb; H.toAct = null;
    if (H.street >= 3) { showdown(T, now); return; }
    var actors = H.order.filter(function (pid) { return !H.p[pid].folded && !H.p[pid].allIn; });
    if (actors.length < 2) {
      H.runout = true; H.reveal = true; H.runoutAt = now + TIMING.RUNOUT_MS;
      return;
    }
    dealStreet(H);
    progress(T, now, H.btn, false);
  }
  function runoutStep(T, now) {
    var H = T.hand;
    if (H.street < 3) { dealStreet(H); H.runoutAt = now + TIMING.RUNOUT_MS; }
    else showdown(T, now);
  }
  function buildPots(H) {
    var contrib = H.order.map(function (pid) { return { pid: pid, amt: H.p[pid].total, live: !H.p[pid].folded }; });
    var levels = [];
    contrib.forEach(function (c) { if (c.live && levels.indexOf(c.amt) < 0) levels.push(c.amt); });
    levels.sort(function (a, b) { return a - b; });
    var pots = [], prev = 0;
    levels.forEach(function (L) {
      var amt = 0;
      contrib.forEach(function (c) { amt += Math.max(0, Math.min(c.amt, L) - prev); });
      var elig = contrib.filter(function (c) { return c.live && c.amt >= L; }).map(function (c) { return c.pid; });
      if (amt > 0) {
        var last = pots[pots.length - 1];
        if (last && last.elig.length === elig.length && last.elig.every(function (x, i) { return x === elig[i]; })) last.amt += amt;
        else pots.push({ amt: amt, elig: elig });
      }
      prev = L;
    });
    var extra = 0;
    contrib.forEach(function (c) { extra += Math.max(0, c.amt - prev); });
    if (extra > 0 && pots.length) pots[pots.length - 1].amt += extra;
    return pots;
  }
  function fromButton(H, pids) {
    var n = H.order.length;
    return pids.slice().sort(function (a, b) {
      var ia = (H.order.indexOf(a) - H.btn - 1 + n) % n;
      var ib = (H.order.indexOf(b) - H.btn - 1 + n) % n;
      return ia - ib;
    });
  }
  function showdown(T, now) {
    var H = T.hand;
    while (H.board.length < 5) H.board.push(H.deck.pop());
    H.street = 4;
    var alive = H.order.filter(function (pid) { return !H.p[pid].folded; });
    var ev = {};
    alive.forEach(function (pid) { ev[pid] = best(H.p[pid].cards.concat(H.board)); });
    var pots = buildPots(H), won = {}, potWon = {}, results = [];
    pots.forEach(function (pot) {
      var top = -1, winners = [];
      pot.elig.forEach(function (pid) {
        var s = ev[pid].score;
        if (s > top) { top = s; winners = [pid]; } else if (s === top) winners.push(pid);
      });
      winners = fromButton(H, winners);
      var share = Math.floor(pot.amt / winners.length), rem = pot.amt - share * winners.length;
      winners.forEach(function (pid) {
        var extra = rem > 0 ? 1 : 0; rem -= extra;
        won[pid] = (won[pid] || 0) + share + extra;
        if (pot.elig.length > 1) potWon[pid] = (potWon[pid] || 0) + share + extra;
      });
      results.push({ amt: pot.amt, win: winners, name: pot.elig.length > 1 ? handName(ev[winners[0]]) : '' });
    });
    var shown = {}, names = {};
    alive.forEach(function (pid) { shown[pid] = H.p[pid].cards.slice(); names[pid] = handName(ev[pid]); });
    finish(T, won, results, shown, names, now, false, potWon);
  }
  function finishUncontested(T, pid, now) {
    var H = T.hand;
    var won = {}, potWon = {}, total = potTotal(H);
    if (pid) {
      var others = 0;
      H.order.forEach(function (o) { if (o !== pid) others = Math.max(others, H.p[o].total); });
      won[pid] = total;
      potWon[pid] = total - Math.max(0, H.p[pid].total - others);
    }
    finish(T, won, [{ amt: pid ? potWon[pid] : total, win: pid ? [pid] : [], name: '' }], {}, {}, now, true, potWon);
  }
  function finish(T, won, pots, shown, names, now, uncontested, potWon) {
    var H = T.hand;
    H.done = true; H.doneAt = now; H.toAct = null; H.runout = false;
    potWon = potWon || {};
    H.result = { won: won, pot: potWon, pots: pots, shown: shown, names: names, un: uncontested };
    Object.keys(won).forEach(function (pid) {
      if (T.players[pid]) T.players[pid].stack += won[pid];
      else ledgerOf(T, pid).c += won[pid];
    });
    Object.keys(potWon).forEach(function (pid) {
      if (potWon[pid] > 0) { var L = ledgerOf(T, pid); L.w += 1; L.x = Math.max(L.x, potWon[pid]); }
    });
    T.hist = [{ no: H.no, board: H.board.slice(), won: won, pot: potWon, pots: pots, shown: shown, names: names, un: uncontested, at: now }]
      .concat(T.hist || []).slice(0, 12);
    Object.keys(T.players).forEach(function (pid) { if (T.players[pid].leaving) cashOut(T, pid); });
    T.nextHandAt = now + (uncontested ? TIMING.QUICK_MS : TIMING.RESULT_MS);
  }

  /* ---------------- player actions ---------------- */
  function legal(T, pid) {
    var H = T.hand;
    if (!H || H.done || H.runout || H.toAct !== pid) return null;
    var q = H.p[pid], pl = T.players[pid];
    if (!q || !pl) return null;
    var toCall = Math.max(0, H.cur - q.bet);
    var maxTo = q.bet + pl.stack;
    return {
      toCall: toCall,
      callAmt: Math.min(toCall, pl.stack),
      canCheck: toCall === 0,
      canRaise: !q.acted && maxTo > H.cur,
      minTo: Math.min(H.cur + H.minR, maxTo),
      maxTo: maxTo,
      isBet: H.cur === 0,
      bet: q.bet, cur: H.cur, pot: potTotal(H), stack: pl.stack,
      callAllIn: toCall > 0 && toCall >= pl.stack
    };
  }
  /* a: fold | check | call | raise (to = total bet for this street). Returns an error code or null. */
  function act(T, pid, a, to, now, auto) {
    var H = T.hand;
    if (!H || H.done || H.runout) return 'no_hand';
    if (H.toAct !== pid) return 'not_your_turn';
    var q = H.p[pid], pl = T.players[pid];
    if (!q || !pl) return 'not_in_hand';
    var toCall = Math.max(0, H.cur - q.bet);
    if (a === 'fold') {
      q.folded = true; q.last = { a: 'fold' };
    } else if (a === 'check') {
      if (toCall > 0) return 'cannot_check';
      q.acted = true; q.last = { a: 'check' };
    } else if (a === 'call') {
      if (toCall === 0) { q.acted = true; q.last = { a: 'check' }; }
      else {
        pay(T, H, pid, toCall); q.acted = true;
        q.last = { a: q.allIn ? 'allin' : 'call', amt: q.bet };
      }
    } else if (a === 'raise') {
      to = Math.floor(Number(to));
      var maxTo = q.bet + pl.stack;
      if (!isFinite(to) || to <= H.cur) return 'too_small';
      if (to > maxTo) return 'too_big';
      if (q.acted) return 'cannot_reraise';
      var allIn = to === maxTo;
      var by = to - H.cur;
      if (by < H.minR && !allIn) return 'below_min';
      var wasBet = H.cur === 0;
      pay(T, H, pid, to - q.bet);
      if (by >= H.minR) {
        H.minR = by;
        H.order.forEach(function (o) {
          if (o !== pid && !H.p[o].folded && !H.p[o].allIn) H.p[o].acted = false;
        });
      }
      H.cur = to; q.acted = true;
      q.last = { a: q.allIn ? 'allin' : (wasBet ? 'bet' : 'raise'), amt: to };
    } else return 'bad_action';
    if (auto) q.last.t = 1; else pl.missed = 0;
    (H.log || (H.log = [])).push({ p: pid, a: q.last.a, amt: q.last.amt || 0, t: auto ? 1 : 0 });
    H.seq += 1;
    progress(T, now, H.order.indexOf(pid), false);
    return null;
  }
  function autoAct(T, pid, now, countMiss) {
    var H = T.hand, q = H.p[pid];
    var a = q && H.cur - q.bet > 0 ? 'fold' : 'check';
    act(T, pid, a, 0, now, true);
    var pl = T.players[pid];
    if (pl && countMiss) {
      pl.missed = (pl.missed || 0) + 1;
      if (pl.missed >= 2) pl.out = true;
    }
  }

  /* ---------------- seat changes ---------------- */
  function join(T, pid, seatPref, now) {
    var cur = T.players[pid];
    if (cur) { cur.leaving = false; return null; }
    var taken = {};
    var count = 0;
    for (var k in T.players) { taken[T.players[k].seat] = 1; count++; }
    if (count >= T.cfg.max) return 'full';
    var seat = -1;
    if (typeof seatPref === 'number' && seatPref >= 0 && seatPref < T.cfg.max && !taken[seatPref]) seat = seatPref;
    for (var s = 0; seat < 0 && s < T.cfg.max; s++) if (!taken[s]) seat = s;
    T.players[pid] = { seat: seat, stack: T.cfg.buyIn, out: false, missed: 0, at: now, leaving: false };
    ledgerOf(T, pid).b += T.cfg.buyIn;
    if (!handLive(T)) T.nextHandAt = Math.max(T.nextHandAt || 0, now + 2500);
    return null;
  }
  function leave(T, pid, now) {
    var p = T.players[pid];
    if (!p) return 'not_seated';
    var H = T.hand;
    if (handLive(T) && H.p[pid] && !H.p[pid].folded) {
      p.leaving = true;
      if (H.p[pid].allIn || H.runout) return null;
      H.p[pid].folded = true; H.p[pid].last = { a: 'fold' };
      (H.log || (H.log = [])).push({ p: pid, a: 'fold', left: 1 });
      H.seq += 1;
      var ref = H.toAct === pid ? H.order.indexOf(pid) : H.order.indexOf(H.toAct);
      progress(T, now, ref, H.toAct !== pid);
      return null;
    }
    cashOut(T, pid);
    return null;
  }
  function rebuy(T, pid, now) {
    var p = T.players[pid];
    if (!p) return 'not_seated';
    if (p.stack > 0) return 'has_chips';
    var H = T.hand;
    if (handLive(T) && H.p[pid] && !H.p[pid].folded) return 'in_hand';
    p.stack += T.cfg.buyIn; p.out = false; p.missed = 0;
    ledgerOf(T, pid).b += T.cfg.buyIn;
    if (!handLive(T)) T.nextHandAt = Math.max(T.nextHandAt || 0, now + 1500);
    return null;
  }
  var BLINDS = [[1, 2], [2, 4], [5, 10], [10, 20], [25, 50]];
  var TIMERS = [15, 20, 30, 45, 60];
  function configure(T, pid, it, now) {
    if (pid !== T.host) return 'not_host';
    var change = {};
    if (typeof it.bb === 'number') {
      var pair = BLINDS.filter(function (b) { return b[1] === it.bb; })[0];
      if (pair) { change.sb = pair[0]; change.bb = pair[1]; }
    }
    if (typeof it.timer === 'number' && TIMERS.indexOf(it.timer) >= 0) change.timer = it.timer;
    if (Object.keys(change).length) {
      if (handLive(T)) T.pend = Object.assign(T.pend || {}, change);
      else Object.assign(T.cfg, change);
    }
    if (typeof it.paused === 'boolean' && it.paused !== T.paused) {
      T.paused = it.paused;
      if (!T.paused && !handLive(T)) T.nextHandAt = now + 2000;
    }
    if (typeof it.priv === 'boolean') T.priv = it.priv;
    if (typeof it.name === 'string') T.name = cleanText(it.name, 28) || T.name;
    return null;
  }
  function cleanText(s, max) {
    return String(s || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function applyIntent(T, pid, it, now) {
    switch (it.k) {
      case 'join': return join(T, pid, it.seat, now);
      case 'leave': return leave(T, pid, now);
      case 'rebuy': return rebuy(T, pid, now);
      case 'sitout':
        if (!T.players[pid]) return 'not_seated';
        T.players[pid].out = true; return null;
      case 'sitin':
        if (!T.players[pid]) return 'not_seated';
        T.players[pid].out = false; T.players[pid].missed = 0;
        if (!handLive(T)) T.nextHandAt = Math.max(T.nextHandAt || 0, now + 1500);
        return null;
      case 'act':
        if (!T.hand || it.h !== T.hand.no || it.s !== T.hand.seq) return 'stale';
        return act(T, pid, it.a, it.to, now, false);
      case 'cfg': return configure(T, pid, it, now);
      case 'kick':
        if (pid !== T.host || typeof it.who !== 'string' || it.who === pid) return 'not_host';
        return leave(T, it.who, now);
      default: return 'unknown';
    }
  }

  function rebase(T, now) {
    var H = T.hand;
    if (H && !H.done) {
      if (H.toAct) H.turnAt = now;
      if (H.runout) H.runoutAt = now + 800;
    }
    if (T.nextHandAt) T.nextHandAt = Math.min(Math.max(T.nextHandAt, now + 1500), now + 6000);
  }
  function newSeason(T, season) {
    T.season = season;
    var L = {};
    Object.keys(T.players).forEach(function (pid) { L[pid] = { b: T.players[pid].stack, c: 0, h: 0, w: 0, x: 0 }; });
    T.ledger = L;
  }

  /* The automatic dealer: apply queued intents, then any timed steps that are due.
     docs: [{pid, q:[{n, k, ...}]}]. ctx: {holder, season, randInt, absent(pid)}. Returns true if T changed. */
  function dealerStep(T, docs, now, ctx) {
    var changed = false;
    if (T.dealer !== ctx.holder) { T.dealer = ctx.holder; rebase(T, now); changed = true; }
    if (ctx.season && T.season !== ctx.season) { newSeason(T, ctx.season); changed = true; }
    var items = [];
    (docs || []).forEach(function (d) {
      if (!d || typeof d.pid !== 'string' || !Array.isArray(d.q)) return;
      var ack = T.ack[d.pid] || 0;
      d.q.forEach(function (it) {
        if (it && typeof it === 'object' && typeof it.n === 'number' && it.n > ack) items.push({ pid: d.pid, it: it });
      });
    });
    items.sort(function (a, b) { return (a.it.at || 0) - (b.it.at || 0) || a.it.n - b.it.n; });
    items.forEach(function (x) {
      if ((T.ack[x.pid] || 0) >= x.it.n) return;
      T.ack[x.pid] = x.it.n;
      try { applyIntent(T, x.pid, x.it, now); } catch (e) { /* malformed intent: ignore */ }
      changed = true;
    });
    var hp = T.players[T.host];
    if (!hp || (hp.out && ctx.absent && ctx.absent(T.host))) {
      var s = Object.keys(T.players).filter(function (pid) { return pid !== T.host && !(ctx.absent && ctx.absent(pid)); })
        .sort(function (a, b) { return T.players[a].at - T.players[b].at; });
      if (s.length) { T.host = s[0]; changed = true; }
      else if (!hp) {
        var any = Object.keys(T.players).sort(function (a, b) { return T.players[a].at - T.players[b].at; });
        if (any.length && T.host !== any[0]) { T.host = any[0]; changed = true; }
      }
    }
    for (var g = 0; g < 16; g++) {
      var H = T.hand;
      if (H && !H.done) {
        if (H.runout) {
          if (now >= H.runoutAt) { runoutStep(T, now); changed = true; continue; }
          break;
        }
        var pid = H.toAct;
        if (!pid) break;
        var pl = T.players[pid];
        var instant = !pl || pl.out || pl.leaving;
        var lim = T.cfg.timer * 1000 + TIMING.GRACE_MS;
        if (ctx.absent && ctx.absent(pid)) lim = Math.min(lim, pl && pl.missed ? 2500 : TIMING.ABSENT_MS);
        if (instant || now >= H.turnAt + lim) { autoAct(T, pid, now, !instant); changed = true; continue; }
        break;
      }
      if (!T.paused && now >= (T.nextHandAt || 0) && eligible(T).length >= 2) {
        if (startHand(T, now, ctx.randInt)) { changed = true; continue; }
      }
      break;
    }
    return changed;
  }
  /* When the dealer should next wake up for this table (ms timestamp), or 0. */
  function nextWake(T) {
    var H = T.hand;
    if (H && !H.done) {
      if (H.runout) return H.runoutAt;
      if (H.toAct) return H.turnAt + T.cfg.timer * 1000 + TIMING.GRACE_MS;
      return 0;
    }
    if (!T.paused && eligible(T).length >= 2) return T.nextHandAt || 1;
    return 0;
  }

  var api = {
    RANKS: RANKS, SUITS: SUITS, BLINDS: BLINDS, TIMERS: TIMERS, TIMING: TIMING,
    freshDeck: freshDeck, shuffle: shuffle, cryptoRandInt: cryptoRandInt,
    rank5: rank5, best: best, handName: handName, describe: describe,
    newTable: newTable, seated: seated, eligible: eligible, potTotal: potTotal, ledgerOf: ledgerOf,
    startHand: startHand, legal: legal, act: act, autoAct: autoAct, buildPots: buildPots,
    join: join, leave: leave, rebuy: rebuy, configure: configure, applyIntent: applyIntent,
    dealerStep: dealerStep, nextWake: nextWake, cleanText: cleanText, handLive: handLive, newSeason: newSeason
  };
  root.PokerEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
