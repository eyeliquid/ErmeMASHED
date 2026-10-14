'use strict';
/*
 * ErmeMASHED backend
 *  - WebSocket rooms per baan voor online rijden (tot 20 spelers per baan)
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
      let players = 0; for (const r of rooms.values()) players += r.size;
      return send(res, 200, { ok: true, players, rooms: rooms.size });
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

/* ---------------- websocket rooms ----------------
 * client -> server  {t:'join', room}            één keer, direct na verbinden
 *                   {t:'p', d:{...}}            eigen status (positie, naam, race), ~15x per seconde
 * server -> client  {t:'welcome', id, peers:[{peer, presence}]}
 *                   {t:'p', peer, d}            status van een andere speler
 *                   {t:'left', peer}
 *                   {t:'full'}                  baan zit vol
 */
const rooms = new Map(); // room -> Map(id -> client)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.values()) if (c !== except && c.ws.readyState === 1) c.ws.send(data);
}
function leave(c) {
  if (!c.room) return;
  const room = rooms.get(c.room);
  if (room) {
    room.delete(c.id);
    broadcast(room, { t: 'left', peer: c.id });
    if (!room.size) rooms.delete(c.room);
  }
  c.room = null;
}

wss.on('connection', (ws, req) => {
  const c = { id: crypto.randomBytes(6).toString('hex'), ws, room: null, presence: {}, bucket: 40, last: Date.now() };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', buf => {
    // eenvoudige rate limit: 30 berichten per seconde, burst 40
    const now = Date.now();
    c.bucket = Math.min(40, c.bucket + (now - c.last) * 0.03); c.last = now;
    if (c.bucket < 1) return; c.bucket -= 1;
    let m; try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      if (c.room || typeof m.room !== 'string' || !ROOM_RE.test(m.room)) return;
      let room = rooms.get(m.room);
      if (!room) rooms.set(m.room, room = new Map());
      if (room.size >= ROOM_MAX) { ws.send(JSON.stringify({ t: 'full' })); return ws.close(); }
      c.room = m.room; room.set(c.id, c);
      ws.send(JSON.stringify({ t: 'welcome', id: c.id, peers: [...room.values()].filter(o => o !== c).map(o => ({ peer: o.id, presence: o.presence })) }));
      log(`join ${m.room} (${room.size} op de baan)`);
    } else if (m.t === 'p') {
      if (!c.room || !m.d || typeof m.d !== 'object' || Array.isArray(m.d)) return;
      const d = { ...m.d, n: cleanName(m.d.n) || 'Speler' };
      c.presence = d;
      const room = rooms.get(c.room);
      if (room) broadcast(room, { t: 'p', peer: c.id, d }, c);
    }
  });
  ws.on('close', () => leave(c));
  ws.on('error', () => leave(c));
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
