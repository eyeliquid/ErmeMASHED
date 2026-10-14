'use strict';
/*
 * ErmeMASHED backend
 *  - Lobby's voor samen spelen (max 6 spelers per potje, bots vullen aan tot 4)
 *  - Scorebord met snelste rondes per baan, opgeslagen in DATA_DIR/scores.json
 *  - Deel-link: het publieke adres van de Cloudflare-tunnel
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATIC_DIR = process.env.STATIC_DIR || '';            // alleen voor lokaal testen zonder nginx
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim();   // vaste link bij een named tunnel
const QUICKTUNNEL_METRICS = (process.env.QUICKTUNNEL_METRICS || '').trim(); // bv. http://quicktunnel:2000/quicktunnel

const TRACKS = ['polar', 'angel', 'ventura'];
const ROOM_RE = /^erme-(polar|angel|ventura)$/;
const ROOM_MAX = 30;           // 20 rijders + een paar kijkers
const BOARD_SIZE = 10;
const KEEP_PER_TRACK = 200;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- names ---------------- */
function cleanName(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
}

/* ---------------- scores ---------------- */
const SCORE_FILE = path.join(DATA_DIR, 'scores.json');
let scores = { laps: Object.fromEntries(TRACKS.map(t => [t, []])) };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(SCORE_FILE, 'utf8'));
  for (const t of TRACKS) if (Array.isArray(raw?.laps?.[t])) scores.laps[t] = raw.laps[t];
  log('scorebord geladen');
} catch (e) {
  if (e.code !== 'ENOENT') log('scorebord niet gelezen:', e.message);
}
let saveTimer = null;
function saveScores() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = SCORE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(scores), err => {
      if (err) return log('opslaan mislukt:', err.message);
      fs.rename(tmp, SCORE_FILE, e2 => e2 && log('opslaan mislukt:', e2.message));
    });
  }, 500);
}
function board(track) {
  return scores.laps[track].slice(0, BOARD_SIZE).map((r, i) => ({ rank: i + 1, name: r.name, time: r.time, at: r.at }));
}
function addLap(name, track, time) {
  const list = scores.laps[track];
  const key = name.toLowerCase();
  const i = list.findIndex(r => r.name.toLowerCase() === key);
  let improved = false;
  if (i === -1) { list.push({ name, time, at: Date.now() }); improved = true; }
  else if (time < list[i].time) { list[i] = { name, time, at: Date.now() }; improved = true; }
  if (improved) {
    list.sort((a, b) => a.time - b.time);
    list.length = Math.min(list.length, KEEP_PER_TRACK);
    saveScores();
  }
  const rank = list.findIndex(r => r.name.toLowerCase() === key) + 1;
  return { improved, rank, best: rank ? list[rank - 1].time : time };
}

/* ---------------- share link ---------------- */
let quickUrl = '';
async function pollQuickTunnel() {
  if (!QUICKTUNNEL_METRICS) return;
  try {
    const r = await fetch(QUICKTUNNEL_METRICS, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const h = String(j.hostname || '').trim();
    if (h) {
      const url = /^https?:\/\//.test(h) ? h : 'https://' + h;
      if (url !== quickUrl) log('tunnel-link:', url);
      quickUrl = url;
    }
  } catch { /* tunnel nog niet klaar */ }
}
if (QUICKTUNNEL_METRICS) { pollQuickTunnel(); setInterval(pollQuickTunnel, 10000).unref(); }

/* ---------------- http ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const rate = new Map(); // ip -> last lap post
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(data);
}
function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('te groot')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') {
      let players = 0; for (const c of clients) if (c.name) players++;
      return send(res, 200, { ok: true, players, lobbies: lobbies.size });
    }
    if (p === '/api/share') return send(res, 200, { url: PUBLIC_URL || quickUrl || '' });
    if (p === '/api/leaderboard' && req.method === 'GET') {
      const track = url.searchParams.get('track');
      if (!TRACKS.includes(track)) return send(res, 400, { error: 'Onbekende baan' });
      return send(res, 200, { track, laps: board(track) });
    }
    if (p === '/api/laps' && req.method === 'POST') {
      const ip = clientIp(req), now = Date.now();
      if (now - (rate.get(ip) || 0) < 1500) return send(res, 429, { error: 'Even rustig aan' });
      rate.set(ip, now);
      if (rate.size > 5000) rate.clear();
      const b = await readJson(req);
      const name = cleanName(b.name), track = b.track, time = Number(b.time);
      if (!name) return send(res, 400, { error: 'Naam ontbreekt' });
      if (!TRACKS.includes(track)) return send(res, 400, { error: 'Onbekende baan' });
      if (!Number.isFinite(time) || time < 5 || time > 600) return send(res, 400, { error: 'Ongeldige rondetijd' });
      const r = addLap(name, track, Math.round(time * 100) / 100);
      return send(res, 200, { ...r, laps: board(track) });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Niet gevonden' });

    if (STATIC_DIR) {
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
      const root = path.resolve(STATIC_DIR), file = path.resolve(root, path.normalize(rel));
      if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Verboden');
      return fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, 'Niet gevonden');
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    }
    send(res, 404, 'Niet gevonden');
  } catch (e) {
    send(res, 400, { error: 'Ongeldig verzoek' });
  }
});

/* ---------------- lobby's ----------------
 * Eén lobby = één potje, maximaal 6 spelers. De maker is host: zijn browser rekent het spel uit
 * (ook de bots) en stuurt ~20x per seconde een snapshot. De andere spelers sturen alleen hun input.
 *
 * client -> server  {t:'hello', name}                 nickname zetten (verplicht voor de rest)
 *                   {t:'list'}                        lobbylijst opvragen
 *                   {t:'create', name, settings}      nieuwe lobby, jij bent host
 *                   {t:'join', id} / {t:'leave'}
 *                   {t:'settings', settings}          host: modus, baan, AI-niveau, punten
 *                   {t:'start'} / {t:'end'}           host: potje starten / terug naar de lobby
 *                   {t:'in', i}                       speler -> host: stuur-input
 *                   {t:'snap', s} / {t:'ev', e, to?}  host -> spelers: spelstatus en gebeurtenissen
 *                   {t:'ping', ts}
 * server -> client  welcome, lobbies, lobby, start, in, snap, ev, ended, hostleft, gone, err, pong
 */
const LOBBY_MAX = 6;
const MAX_LOBBIES = 60;
const MODES = ['battle', 'race'];
const lobbies = new Map(); // code -> lobby
const clients = new Set();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

const cleanLobbyName = s => String(s == null ? '' : s)
  .replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿<>]/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, 24);
function lobbyCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s;
  do { s = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (lobbies.has(s));
  return s;
}
function cleanSettings(x, base) {
  const o = { ...base };
  if (x && typeof x === 'object') {
    if (MODES.includes(x.mode)) o.mode = x.mode;
    if (Number.isInteger(x.track) && x.track >= 0 && x.track < TRACKS.length) o.track = x.track;
    if (Number.isInteger(x.ai) && x.ai >= 0 && x.ai <= 3) o.ai = x.ai;
    if (x.pts === 10 || x.pts === 12) o.pts = x.pts;
  }
  return o;
}
const DEFAULTS = { mode: 'battle', track: 0, ai: 1, pts: 10 };

function sendTo(c, msg) { if (c.ws.readyState === 1) c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function summary(l) {
  const h = l.members.get(l.hostId);
  return { id: l.id, name: l.name, host: h ? h.name : '', players: l.members.size, max: LOBBY_MAX, mode: l.settings.mode, track: l.settings.track, state: l.state };
}
function lobbyView(l) {
  return { id: l.id, name: l.name, hostId: l.hostId, max: LOBBY_MAX, settings: l.settings, state: l.state,
    members: [...l.members.values()].map(m => ({ id: m.id, name: m.name })) };
}
let listTimer = null;
function pushList() {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const msg = JSON.stringify({ t: 'lobbies', list: [...lobbies.values()].map(summary) });
    for (const c of clients) if (c.name && !c.lobby) sendTo(c, msg);
  }, 80);
}
function pushLobby(l) {
  const msg = JSON.stringify({ t: 'lobby', lobby: lobbyView(l) });
  for (const m of l.members.values()) sendTo(m, msg);
}
function leaveLobby(c) {
  const l = c.lobby;
  if (!l) return;
  l.members.delete(c.id);
  c.lobby = null;
  if (!l.members.size) { lobbies.delete(l.id); log(`lobby ${l.id} opgeheven`); pushList(); return; }
  if (l.hostId === c.id) {
    l.hostId = l.members.keys().next().value;
    if (l.state === 'playing') { l.state = 'waiting'; for (const m of l.members.values()) sendTo(m, { t: 'hostleft' }); }
  } else if (l.state === 'playing') {
    const h = l.members.get(l.hostId);
    if (h) sendTo(h, { t: 'gone', id: c.id });
  }
  pushLobby(l); pushList();
}
const err = (c, msg) => sendTo(c, { t: 'err', msg });

wss.on('connection', ws => {
  const c = { id: crypto.randomBytes(6).toString('hex'), ws, name: '', lobby: null, bucket: 120, last: Date.now() };
  clients.add(c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', buf => {
    // rate limit: 80 berichten per seconde, burst 120 (host stuurt snapshots, spelers input)
    const now = Date.now();
    c.bucket = Math.min(120, c.bucket + (now - c.last) * 0.08); c.last = now;
    if (c.bucket < 1) return; c.bucket -= 1;
    const raw = buf.toString('utf8');
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const l = c.lobby, isHost = !!l && l.hostId === c.id;

    switch (m.t) {
      case 'ping': return sendTo(c, { t: 'pong', ts: m.ts });
      case 'hello': {
        const name = cleanName(m.name);
        if (!name) return err(c, 'Vul een nickname in.');
        c.name = name;
        sendTo(c, { t: 'welcome', id: c.id });
        if (l) pushLobby(l);
        sendTo(c, { t: 'lobbies', list: [...lobbies.values()].map(summary) });
        return;
      }
    }
    if (!c.name) return err(c, 'Vul eerst een nickname in.');

    switch (m.t) {
      case 'list':
        return sendTo(c, { t: 'lobbies', list: [...lobbies.values()].map(summary) });
      case 'create': {
        if (lobbies.size >= MAX_LOBBIES) return err(c, 'Er zijn nu te veel lobby’s. Doe mee met een bestaande.');
        leaveLobby(c);
        const lob = { id: lobbyCode(), name: cleanLobbyName(m.name) || 'Lobby van ' + c.name, hostId: c.id,
          members: new Map([[c.id, c]]), settings: cleanSettings(m.settings, DEFAULTS), state: 'waiting' };
        lobbies.set(lob.id, lob); c.lobby = lob;
        log(`lobby ${lob.id} "${lob.name}" door ${c.name}`);
        pushLobby(lob); pushList();
        return;
      }
      case 'join': {
        const lob = lobbies.get(String(m.id || '').toUpperCase());
        if (!lob) return err(c, 'Deze lobby bestaat niet meer.');
        if (lob === l) return pushLobby(lob);
        if (lob.state !== 'waiting') return err(c, 'Deze lobby is al aan het spelen. Wacht tot het potje klaar is.');
        if (lob.members.size >= LOBBY_MAX) return err(c, 'Deze lobby is vol (6 spelers).');
        leaveLobby(c);
        lob.members.set(c.id, c); c.lobby = lob;
        pushLobby(lob); pushList();
        return;
      }
      case 'leave':
        leaveLobby(c);
        return sendTo(c, { t: 'lobbies', list: [...lobbies.values()].map(summary) });
      case 'settings':
        if (!isHost || l.state !== 'waiting') return;
        l.settings = cleanSettings(m.settings, l.settings);
        pushLobby(l); pushList();
        return;
      case 'start': {
        if (!isHost) return;
        l.state = 'playing';
        const players = [l.members.get(l.hostId), ...[...l.members.values()].filter(x => x.id !== l.hostId)].map(x => ({ id: x.id, name: x.name }));
        const msg = JSON.stringify({ t: 'start', hostId: l.hostId, settings: l.settings, players, seed: crypto.randomInt(1e9) });
        for (const x of l.members.values()) sendTo(x, msg);
        log(`lobby ${l.id} start: ${players.length} speler(s), ${l.settings.mode}`);
        pushLobby(l); pushList();
        return;
      }
      case 'end':
        if (!isHost || l.state !== 'playing') return;
        l.state = 'waiting';
        for (const x of l.members.values()) sendTo(x, { t: 'ended' });
        pushLobby(l); pushList();
        return;
      case 'in': {
        if (!l || isHost || l.state !== 'playing' || !m.i || typeof m.i !== 'object') return;
        const h = l.members.get(l.hostId);
        if (h) sendTo(h, { t: 'in', from: c.id, i: m.i });
        return;
      }
      case 'snap':
        if (!isHost || l.state !== 'playing') return;
        for (const x of l.members.values()) if (x !== c) sendTo(x, raw);
        return;
      case 'ev':
        if (!isHost || l.state !== 'playing') return;
        if (m.to) { const x = l.members.get(m.to); if (x) sendTo(x, raw); }
        else for (const x of l.members.values()) if (x !== c) sendTo(x, raw);
        return;
    }
  });
  const bye = () => { if (!clients.has(c)) return; clients.delete(c); leaveLobby(c); };
  ws.on('close', bye);
  ws.on('error', bye);
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* al dicht */ }
  }
}, 20000);
heartbeat.unref();

server.listen(PORT, () => log(`ErmeMASHED backend luistert op :${PORT}`));
const stop = () => { log('stoppen'); clearTimeout(saveTimer); try { fs.writeFileSync(SCORE_FILE, JSON.stringify(scores)); } catch { } process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
