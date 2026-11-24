/**
 * DaRI AI Arcade — Lightweight Local Development & Game Server
 * Dependency-free Node.js HTTP server.
 * Serves the 'www' directory on http://127.0.0.1:8765
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load environment variables from .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const rawLine of envLines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (e) {
    console.warn('[!] Error reading .env file:', e.message);
  }
}

let PORT = parseInt(process.env.PORT, 10) || 8787;
const HOST = '0.0.0.0';
const WWW_DIR = path.join(__dirname, 'www');
const CONFIG_DIR = path.join(os.homedir(), '.pixel_mirror');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const PLAYERS_PATH = path.join(CONFIG_DIR, 'players.json');
const TOURNAMENTS_PATH = path.join(CONFIG_DIR, 'tournaments.json');
const verificationCodes = new Map(); // email -> { code, expires }

// ============================================================================
// GOOGLE OAUTH CONFIGURATION
// Credentials loaded dynamically from .env (GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET)
// ============================================================================
const GOOGLE_AUTH_CONFIG_FILE = path.join(__dirname, 'google-auth-config.json');

function getGoogleClientId() {
  if (process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_CLIENT_ID.includes('YOUR_GOOGLE_CLIENT_ID')) {
    return process.env.GOOGLE_CLIENT_ID.trim();
  }
  const fileCfg = readJsonFile(GOOGLE_AUTH_CONFIG_FILE, {});
  if (fileCfg.client_id && !fileCfg.client_id.includes('YOUR_GOOGLE_CLIENT_ID')) {
    return fileCfg.client_id.trim();
  }
  const userCfg = readJsonFile(CONFIG_PATH, {});
  return (userCfg.google_client_id || '').trim();
}

function getGoogleClientSecret() {
  if (process.env.GOOGLE_CLIENT_SECRET && !process.env.GOOGLE_CLIENT_SECRET.includes('YOUR_GOOGLE_CLIENT_SECRET')) {
    return process.env.GOOGLE_CLIENT_SECRET.trim();
  }
  const fileCfg = readJsonFile(GOOGLE_AUTH_CONFIG_FILE, {});
  if (fileCfg.client_secret && !fileCfg.client_secret.includes('YOUR_GOOGLE_CLIENT_SECRET')) {
    return fileCfg.client_secret.trim();
  }
  const userCfg = readJsonFile(CONFIG_PATH, {});
  return (userCfg.google_client_secret || '').trim();
}

// Backend-configured Admin Emails (set via ADMIN_EMAILS in .env, e.g. ADMIN_EMAILS=admin@dariai.tech,...)
function getAdminEmails() {
  const envEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return envEmails;
}

// Resolve user role: if email is configured in backend ADMIN_EMAILS, role is admin; otherwise participant
function resolveUserRole(email, existingRole = 'participant') {
  const cleanEmail = (email || '').trim().toLowerCase();
  const adminEmails = getAdminEmails();
  if (cleanEmail && adminEmails.includes(cleanEmail)) {
    return 'admin';
  }
  if (existingRole === 'admin' && adminEmails.length === 0) {
    return 'admin';
  }
  return 'participant';
}

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

const server = http.createServer(async (req, res) => {
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

  // --- Direct Google OAuth Flow Handlers (Redirect & Callback) ---
  if ((pathname === '/auth/google' || pathname === '/api/auth/google/login') && req.method === 'GET') {
    const clientId = getGoogleClientId();
    const redirectUri = 'http://127.0.0.1:8787/auth/callback';
    const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=email%20profile&prompt=select_account`;
    res.writeHead(302, { Location: googleUrl });
    return res.end();
  }

  if ((pathname === '/auth/callback' || pathname === '/api/auth/google/callback') && req.method === 'GET') {
    const code = parsedUrl.searchParams.get('code');
    const error = parsedUrl.searchParams.get('error');
    if (error || !code) {
      res.writeHead(302, { Location: `/?auth_error=${encodeURIComponent(error || 'Google sign-in was cancelled.')}` });
      return res.end();
    }
    const clientId = getGoogleClientId();
    const clientSecret = getGoogleClientSecret();
    const redirectUri = 'http://127.0.0.1:8787/auth/callback';

    try {
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri
        })
      });
      const tokenData = await tokenResp.json();
      if (tokenData.error) {
        res.writeHead(302, { Location: `/?auth_error=${encodeURIComponent(tokenData.error_description || tokenData.error)}` });
        return res.end();
      }

      const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const userData = await userResp.json();
      const cleanEmail = (userData.email || '').trim().toLowerCase();
      const isEmailVerified = userData.verified_email === true || userData.verified_email === 'true';

      if (!cleanEmail || !isEmailVerified) {
        res.writeHead(302, { Location: `/?auth_error=${encodeURIComponent('Google email is not verified or accessible.')}` });
        return res.end();
      }

      const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
      let player = Object.values(pdata.players || {}).find(p => 
        (p.googleId && p.googleId === userData.id) || (p.email && p.email.toLowerCase() === cleanEmail)
      );

      if (player) {
        player.emailVerified = true;
        player.role = resolveUserRole(cleanEmail, player.role);
        if (userData.id && !player.googleId) player.googleId = userData.id;
        if (userData.picture && !player.avatar) player.avatar = userData.picture;
        writeJsonFile(PLAYERS_PATH, pdata);
        res.writeHead(302, { Location: `/?auth_player=${encodeURIComponent(JSON.stringify(player))}` });
        return res.end();
      }

      // New user -> auto-create player as participant (or admin if configured in backend)
      const pid = 'P' + Math.floor(1000 + Math.random() * 9000);
      const assignedRole = resolveUserRole(cleanEmail);
      player = {
        id: pid,
        name: userData.name || cleanEmail.split('@')[0],
        email: cleanEmail,
        role: assignedRole,
        googleId: userData.id,
        avatar: userData.picture || '',
        emailVerified: true,
        authProvider: 'google',
        createdAt: Date.now() / 1000,
        games: {}
      };
      pdata.players = pdata.players || {};
      pdata.players[pid] = player;
      writeJsonFile(PLAYERS_PATH, pdata);
      res.writeHead(302, { Location: `/?auth_player=${encodeURIComponent(JSON.stringify(player))}` });
      return res.end();
    } catch (err) {
      res.writeHead(302, { Location: `/?auth_error=${encodeURIComponent(err.message)}` });
      return res.end();
    }
  }

  // --- API Handlers ---
  if (pathname.startsWith('/api/')) {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', async () => {
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

      // --- Authentication & Google OAuth API Handlers ---
      if (pathname === '/api/auth/google/verify-token' && req.method === 'POST') {
        const { credential } = body;
        if (!credential) {
          return sendJson({ ok: false, error: 'Google credential missing.' }, 400);
        }
        try {
          const tokenResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
          const tokenInfo = await tokenResp.json();
          if (tokenInfo.error || !tokenInfo.email) {
            return sendJson({ ok: false, error: tokenInfo.error_description || 'Invalid Google token' }, 401);
          }
          if (tokenInfo.email_verified !== 'true' && tokenInfo.email_verified !== true) {
            return sendJson({ ok: false, error: 'Google email is not verified by Google.' }, 403);
          }
          const cleanEmail = tokenInfo.email.trim().toLowerCase();
          const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
          let player = Object.values(pdata.players || {}).find(p => 
            (p.googleId && p.googleId === tokenInfo.sub) || (p.email && p.email.toLowerCase() === cleanEmail)
          );
          if (player) {
            if (!player.googleId && tokenInfo.sub) player.googleId = tokenInfo.sub;
            if (tokenInfo.picture && !player.avatar) player.avatar = tokenInfo.picture;
            player.emailVerified = true;
            player.role = resolveUserRole(cleanEmail, player.role);
            writeJsonFile(PLAYERS_PATH, pdata);
            return sendJson({ ok: true, isNew: false, player });
          }
          const pid = 'P' + Math.floor(1000 + Math.random() * 9000);
          const assignedRole = resolveUserRole(cleanEmail);
          const newPlayer = {
            id: pid,
            name: tokenInfo.name || cleanEmail.split('@')[0],
            email: cleanEmail,
            role: assignedRole,
            googleId: tokenInfo.sub,
            avatar: tokenInfo.picture || '',
            emailVerified: true,
            authProvider: 'google',
            createdAt: Date.now() / 1000,
            games: {}
          };
          pdata.players = pdata.players || {};
          pdata.players[pid] = newPlayer;
          writeJsonFile(PLAYERS_PATH, pdata);
          return sendJson({ ok: true, isNew: false, player: newPlayer });
        } catch (e) {
          return sendJson({ ok: false, error: e.message }, 500);
        }
      }

      if (pathname === '/api/auth/google/config') {
        if (req.method === 'GET') {
          return sendJson({ ok: true, clientId: getGoogleClientId() });
        }
        if (req.method === 'POST') {
          const cid = (body.clientId || '').trim();
          const cfg = readJsonFile(CONFIG_PATH, {});
          cfg.google_client_id = cid;
          writeJsonFile(CONFIG_PATH, cfg);
          try {
            writeJsonFile(GOOGLE_AUTH_CONFIG_FILE, {
              client_id: cid,
              client_secret: getGoogleClientSecret(),
              _instructions: "Google OAuth Credentials"
            });
          } catch (e) {}
          return sendJson({ ok: true, clientId: cid });
        }
      }

      if (pathname === '/api/auth/check-email' && req.method === 'POST') {
        const email = (body.email || '').trim().toLowerCase();
        if (!email) return sendJson({ ok: false, error: 'Email is required' }, 400);
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        const player = Object.values(pdata.players || {}).find(p => (p.email || '').toLowerCase() === email);
        return sendJson({ ok: true, exists: !!player, player: player || null });
      }

      if (pathname === '/api/auth/send-verification' && req.method === 'POST') {
        const email = (body.email || '').trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) {
          return sendJson({ ok: false, error: 'Please enter a valid email address.' }, 400);
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        verificationCodes.set(email, { code, expires: Date.now() + 10 * 60 * 1000 });
        return sendJson({
          ok: true,
          code: code,
          message: `Verification code generated for ${email}`
        });
      }

      if (pathname === '/api/auth/verify-code' && req.method === 'POST') {
        const email = (body.email || '').trim().toLowerCase();
        const code = (body.code || '').trim();
        const record = verificationCodes.get(email);
        if (!record) {
          return sendJson({ ok: false, error: 'No verification code found. Please request a new code.' }, 400);
        }
        if (Date.now() > record.expires) {
          verificationCodes.delete(email);
          return sendJson({ ok: false, error: 'Verification code has expired. Please request a new code.' }, 400);
        }
        if (record.code !== code) {
          return sendJson({ ok: false, error: 'Invalid verification code. Please check and try again.' }, 400);
        }
        return sendJson({ ok: true, verified: true });
      }

      if (pathname === '/api/auth/signup' && req.method === 'POST') {
        const name = (body.name || '').trim();
        const email = (body.email || '').trim().toLowerCase();
        const role = resolveUserRole(email);
        const googleId = body.googleId || null;
        const avatar = body.avatar || null;

        if (!name) return sendJson({ ok: false, error: 'Name is required.' }, 400);
        if (!email) return sendJson({ ok: false, error: 'Email is required.' }, 400);

        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        const existing = Object.values(pdata.players || {}).find(p => 
          (p.email && p.email.toLowerCase() === email) || (googleId && p.googleId === googleId)
        );
        if (existing) {
          existing.role = resolveUserRole(email, existing.role);
          writeJsonFile(PLAYERS_PATH, pdata);
          return sendJson({ ok: false, error: 'An account with this email already exists. Please log in.', player: existing, exists: true }, 409);
        }

        const pid = 'P' + Math.floor(1000 + Math.random() * 9000);
        const player = {
          id: pid,
          name,
          email,
          role,
          googleId,
          avatar,
          emailVerified: true,
          authProvider: googleId ? 'google' : 'email',
          createdAt: Date.now() / 1000,
          games: {}
        };
        pdata.players = pdata.players || {};
        pdata.players[pid] = player;
        writeJsonFile(PLAYERS_PATH, pdata);
        return sendJson({ ok: true, player });
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const email = (body.email || '').trim().toLowerCase();
        const pid = (body.id || '').trim().toUpperCase();
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        let player = null;
        if (email) {
          player = Object.values(pdata.players || {}).find(p => (p.email || '').toLowerCase() === email);
        }
        if (!player && pid) {
          player = pdata.players[pid] || Object.values(pdata.players || {}).find(p => (p.name || '').toLowerCase() === pid.toLowerCase());
        }
        if (!player) {
          return sendJson({ ok: false, notFound: true, error: 'No account found. Please sign up first.' }, 404);
        }
        player.role = resolveUserRole(player.email, player.role);
        writeJsonFile(PLAYERS_PATH, pdata);
        return sendJson({ ok: true, player });
      }

      if (pathname === '/api/auth/google' && req.method === 'POST') {
        const { credential, email, name, picture, sub } = body;
        
        // If a Google GIS credential token is provided, verify directly with Google
        if (credential) {
          try {
            const tokenResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
            const tokenInfo = await tokenResp.json();
            if (tokenInfo.error || !tokenInfo.email) {
              return sendJson({ ok: false, error: tokenInfo.error_description || 'Invalid Google credential.' }, 401);
            }
            if (tokenInfo.email_verified !== 'true' && tokenInfo.email_verified !== true) {
              return sendJson({ ok: false, error: 'Google email is not verified by Google.' }, 403);
            }
            const cleanEmail = tokenInfo.email.trim().toLowerCase();
            const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
            let player = Object.values(pdata.players || {}).find(p => 
              (p.googleId && p.googleId === tokenInfo.sub) || (p.email && p.email.toLowerCase() === cleanEmail)
            );
            if (player) {
              if (!player.googleId && tokenInfo.sub) player.googleId = tokenInfo.sub;
              if (tokenInfo.picture && !player.avatar) player.avatar = tokenInfo.picture;
              player.emailVerified = true;
              player.role = resolveUserRole(cleanEmail, player.role);
              writeJsonFile(PLAYERS_PATH, pdata);
              return sendJson({ ok: true, isNew: false, player });
            }
            const pid = 'P' + Math.floor(1000 + Math.random() * 9000);
            const assignedRole = resolveUserRole(cleanEmail);
            const newPlayer = {
              id: pid,
              name: tokenInfo.name || cleanEmail.split('@')[0],
              email: cleanEmail,
              role: assignedRole,
              googleId: tokenInfo.sub,
              avatar: tokenInfo.picture || '',
              emailVerified: true,
              authProvider: 'google',
              createdAt: Date.now() / 1000,
              games: {}
            };
            pdata.players = pdata.players || {};
            pdata.players[pid] = newPlayer;
            writeJsonFile(PLAYERS_PATH, pdata);
            return sendJson({ ok: true, isNew: false, player: newPlayer });
          } catch (e) {
            return sendJson({ ok: false, error: e.message }, 500);
          }
        }

        const cleanEmail = (email || '').trim().toLowerCase();
        if (!cleanEmail) {
          return sendJson({ ok: false, error: 'Google account email missing.' }, 400);
        }
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        let player = Object.values(pdata.players || {}).find(p => 
          (p.googleId && p.googleId === sub) || (p.email && p.email.toLowerCase() === cleanEmail)
        );

        if (player) {
          if (!player.googleId && sub) player.googleId = sub;
          if (picture && !player.avatar) player.avatar = picture;
          player.role = resolveUserRole(cleanEmail, player.role);
          writeJsonFile(PLAYERS_PATH, pdata);
          return sendJson({ ok: true, isNew: false, player });
        }

        // Only verified accounts can be created: require Google OAuth verification
        return sendJson({
          ok: false,
          error: 'Account not found. Please click "Sign in with Google" to verify and create your account.'
        }, 401);
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

      if (pathname === '/api/players/role' && req.method === 'POST') {
        const pid = (body.id || '').trim().toUpperCase();
        const role = body.role === 'admin' ? 'admin' : 'participant';
        const password = body.password || '';
        if (role === 'admin') {
          const adminPassword = process.env.ADMIN_PASSWORD || '1234';
          if (password !== adminPassword) {
            return sendJson({ ok: false, error: 'Incorrect admin password.' }, 403);
          }
        }
        const pdata = readJsonFile(PLAYERS_PATH, { players: {} });
        const p = pdata.players[pid];
        if (p) {
          p.role = role;
          writeJsonFile(PLAYERS_PATH, pdata);
          return sendJson({ ok: true, player: p });
        }
        return sendJson({ ok: false, error: 'Player not found.' }, 404);
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
    if (PORT <= 8795) {
      console.log(`    Trying next available port: http://127.0.0.1:${PORT} ...\n`);
      setTimeout(() => {
        server.listen(PORT, HOST);
      }, 300);
    } else {
      console.error(`[!] Unable to find a free port between 8765 and 8795.`);
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
  console.log(`  Local URL:       http://127.0.0.1:${PORT}`);
  console.log(`  Google Callback: http://127.0.0.1:${PORT}/auth/callback`);
  console.log(`======================================================\n`);

  // If running on 8787, optionally redirect requests from 8765 to 8787
  if (PORT === 8787) {
    try {
      const helperServer = http.createServer((hReq, hRes) => {
        hRes.writeHead(302, { Location: `http://127.0.0.1:8787${hReq.url}` });
        hRes.end();
      });
      helperServer.on('error', () => { /* port in use, ignore */ });
      helperServer.listen(8765, HOST);
    } catch (e) {}
  }
});
