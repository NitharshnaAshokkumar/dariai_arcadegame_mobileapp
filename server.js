/**
 * DaRI AI Arcade — Lightweight Local Development & Game Server
 * Dependency-free Node.js HTTP server.
 * Serves the 'www' directory on http://127.0.0.1:8765
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let PORT = parseInt(process.env.PORT, 10) || 8765;
const HOST = '0.0.0.0';
const WWW_DIR = path.join(__dirname, 'www');
const CONFIG_DIR = path.join(os.homedir(), '.pixel_mirror');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const PLAYERS_PATH = path.join(CONFIG_DIR, 'players.json');
const TOURNAMENTS_PATH = path.join(CONFIG_DIR, 'tournaments.json');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return fallback;
}

function writeJsonFile(filePath, data) {
  ensureConfigDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers for local LAN play
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Handlers ---
  if (pathname.startsWith('/api/')) {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      let body = {};
      try {
        if (bodyData) body = JSON.parse(bodyData);
      } catch (e) {}

      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (pathname === '/api/health') {
        return sendJson({ ok: true, name: 'DaRI AI Arcade', time: Date.now() });
      }

      if (pathname === '/api/key') {
        if (req.method === 'GET') {
          const cfg = readJsonFile(CONFIG_PATH, {});
          const key = cfg.openai_api_key || '';
          return sendJson({ has_key: !!key, api_key: key });
        }
        if (req.method === 'POST') {
          const key = (body.api_key || '').trim();
          if (!key) return sendJson({ ok: false, error: 'Please paste a valid API key.' }, 400);
          const cfg = readJsonFile(CONFIG_PATH, {});
          cfg.openai_api_key = key;
          writeJsonFile(CONFIG_PATH, cfg);
          return sendJson({ ok: true });
        }
      }

      if (pathname === '/api/key/clear') {
        const cfg = readJsonFile(CONFIG_PATH, {});
        delete cfg.openai_api_key;
        writeJsonFile(CONFIG_PATH, cfg);
        return sendJson({ ok: true });
      }

      if (pathname === '/api/players' && req.method === 'GET') {
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        const list = Object.values(pdata.players || {});
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return sendJson({ players: list });
      }

      if (pathname.startsWith('/api/players/') && req.method === 'GET') {
        const queryId = decodeURIComponent(pathname.replace('/api/players/', '')).split('?')[0].trim();
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        const players = pdata.players || {};
        let p = players[queryId] || players[queryId.toUpperCase()];
        if (!p) {
          p = Object.values(players).find(x => (x.name || '').toLowerCase() === queryId.toLowerCase());
        }
        if (!p && queryId) {
          // Auto-provision player if accessed by name
          const pid = 'P' + Math.floor(1000 + Math.random() * 9000);
          p = { id: pid, name: queryId, role: 'participant', createdAt: Date.now() / 1000, games: {} };
          pdata.players = pdata.players || {};
          pdata.players[pid] = p;
          writeJsonFile(PLAYERS_PATH, pdata);
        }
        if (p) return sendJson({ ok: true, player: p });
        return sendJson({ ok: false, error: 'Unknown player ID.' }, 404);
      }

      if (pathname === '/api/players/resolve' && req.method === 'POST') {
        const name = (body.name || '').trim();
        if (!name) return sendJson({ ok: false, error: 'Name is required.' }, 400);
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        let p = Object.values(pdata.players).find(x => x.name.toLowerCase() === name.toLowerCase());
        if (!p) {
          const pid = 'P' + Math.floor(1000 + Math.random() * 9000);
          p = { id: pid, name: name, role: 'participant', createdAt: Date.now() / 1000, games: {} };
          pdata.players[pid] = p;
          writeJsonFile(PLAYERS_PATH, pdata);
        }
        return sendJson({ ok: true, player: p });
      }

      if (pathname === '/api/players/create' && req.method === 'POST') {
        const name = (body.name || '').trim();
        const role = body.role === 'admin' ? 'admin' : 'participant';
        if (!name) return sendJson({ ok: false, error: 'Name is required.' }, 400);
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        const pid = 'P' + Math.floor(1000 + Math.random() * 9000);
        const p = { id: pid, name: name, role: role, createdAt: Date.now() / 1000, games: {} };
        pdata.players[pid] = p;
        writeJsonFile(PLAYERS_PATH, pdata);
        return sendJson({ ok: true, player: p });
      }

      if (pathname === '/api/players/login' && req.method === 'POST') {
        const pid = (body.id || '').trim().toUpperCase();
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        const p = pdata.players[pid];
        if (!p) return sendJson({ ok: false, error: 'Unknown player ID.' }, 404);
        return sendJson({ ok: true, player: p });
      }

      if (pathname === '/api/players/logout') {
        return sendJson({ ok: true });
      }

      if (pathname === '/api/players/event' && req.method === 'POST') {
        const pid = (body.playerId || '').trim().toUpperCase();
        const game = body.game || 'prompt-mirror';
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        const p = pdata.players[pid];
        if (p) {
          if (!p.games[game]) p.games[game] = { solo: { roundsPlayed: 0, highScores: {} } };
          if (body.type === 'solo-round-finished') {
            p.games[game].solo.roundsPlayed = (p.games[game].solo.roundsPlayed || 0) + 1;
            const score = Math.round(Number(body.score) || 0);
            const lvl = String(body.level || 1);
            p.games[game].solo.highScores[lvl] = Math.max(p.games[game].solo.highScores[lvl] || 0, score);
          }
          writeJsonFile(PLAYERS_PATH, pdata);
          return sendJson({ ok: true, player: p });
        }
        return sendJson({ ok: false, error: 'Player not found' }, 404);
      }

      if (pathname === '/api/tournaments' && req.method === 'GET') {
        const tdata = readJsonFile(TOURNAMENTS_PATH, { tournaments: {} });
        return sendJson({ tournaments: Object.values(tdata.tournaments) });
      }

      if (pathname === '/api/tournaments/create' && req.method === 'POST') {
        const tdata = readJsonFile(TOURNAMENTS_PATH, { tournaments: {} });
        const tid = 'T' + Math.floor(1000 + Math.random() * 9000);
        const t = { id: tid, name: body.name || 'Tournament', game: body.game || 'prompt-mirror', createdAt: Date.now() / 1000, status: 'ready', bracket: body.bracket || [], players: body.players || {}, levels: body.levels || [1] };
        tdata.tournaments[tid] = t;
        writeJsonFile(TOURNAMENTS_PATH, tdata);
        return sendJson({ ok: true, tournament: t });
      }

      return sendJson({ ok: false, error: 'Not found' }, 404);
    });
    return;
  }

  // --- Static File Serving ---
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';
  const filePath = path.join(WWW_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`\n[i] Port ${PORT} is currently in use (another DaRI AI instance is already running).`);
    PORT++;
    if (PORT <= 8775) {
      console.log(`    Trying next available port: http://127.0.0.1:${PORT} ...\n`);
      setTimeout(() => {
        server.listen(PORT, HOST);
      }, 300);
    } else {
      console.error(`[!] Unable to find a free port between 8765 and 8775.`);
      console.error(`    To free up port 8765, run: npm run stop\n`);
      process.exit(1);
    }
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`  DaRI AI Arcade Server Running!`);
  console.log(`  Local URL:   http://127.0.0.1:${PORT}`);
  console.log(`  LAN URL:     http://0.0.0.0:${PORT}`);
  console.log(`======================================================\n`);
});
