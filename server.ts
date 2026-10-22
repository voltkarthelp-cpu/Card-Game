import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RoomData {
  roomCode: string;
  hostId: string;
  rules: any;
  players: any[];
  tableState: any | null;
  actions: any[];
  version: number;
  lastUpdated: number;
}

const rooms = new Map<string, RoomData>();

function getLanIps(): string[] {
  const nets = os.networkInterfaces();
  const results: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('127.')) {
        results.push(net.address);
      }
    }
  }
  return results;
}

async function startServer() {
  const app = express();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

  // Server & LAN Network Info for Cross-Device Wi-Fi Play
  app.get('/api/server-info', (_req, res) => {
    const lanIps = getLanIps();
    res.json({
      lanIps,
      port,
      preferredLanUrl: lanIps.length > 0 ? `http://${lanIps[0]}:${port}` : null,
      appUrl: process.env.APP_URL || null,
    });
  });

  // --- MULTIPLAYER ROOM REST API FOR REAL WI-FI / MULTI-DEVICE PLAY ---

  // Create or register room
  app.post('/api/rooms/create', (req, res) => {
    const { roomCode, hostId, rules, player } = req.body;
    if (!roomCode || !hostId) {
      return res.status(400).json({ error: 'Missing roomCode or hostId' });
    }

    const upperCode = roomCode.toUpperCase();
    const existing = rooms.get(upperCode);

    const room: RoomData = {
      roomCode: upperCode,
      hostId,
      rules: rules || existing?.rules,
      players: player ? [player] : existing?.players || [],
      tableState: null,
      actions: [],
      version: (existing?.version || 0) + 1,
      lastUpdated: Date.now(),
    };

    rooms.set(upperCode, room);
    res.json({ success: true, room });
  });

  // Join existing room
  app.post('/api/rooms/:code/join', (req, res) => {
    const code = req.params.code.toUpperCase();
    const { player } = req.body;

    let room = rooms.get(code);
    if (!room) {
      // Auto-create room placeholder if not yet registered
      room = {
        roomCode: code,
        hostId: player.isHost ? player.id : '',
        rules: { playerLimit: 8 },
        players: [player],
        tableState: null,
        actions: [],
        version: 1,
        lastUpdated: Date.now(),
      };
      rooms.set(code, room);
      return res.json({ success: true, room, isNew: true });
    }

    // Add or update player in room
    const existingIndex = room.players.findIndex((p) => p.id === player.id);
    if (existingIndex >= 0) {
      room.players[existingIndex] = { ...room.players[existingIndex], ...player, isConnected: true };
    } else {
      if (room.players.length >= (room.rules?.playerLimit || 8)) {
        return res.status(400).json({ error: 'Room is full (max 8 players)' });
      }
      room.players.push(player);
    }

    room.version++;
    room.lastUpdated = Date.now();
    res.json({ success: true, room });
  });

  // Get current room state & pending actions
  app.get('/api/rooms/:code/state', (req, res) => {
    const code = req.params.code.toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    res.json(room);
  });

  // Host updates authoritative table state
  app.post('/api/rooms/:code/sync', (req, res) => {
    const code = req.params.code.toUpperCase();
    const { tableState, hostId } = req.body;
    const room = rooms.get(code);

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    room.tableState = tableState;
    if (tableState.players) {
      room.players = tableState.players;
    }
    room.version++;
    room.lastUpdated = Date.now();

    res.json({ success: true, version: room.version });
  });

  // Player posts move action (play, draw, uno, catch)
  app.post('/api/rooms/:code/action', (req, res) => {
    const code = req.params.code.toUpperCase();
    const { action } = req.body;
    const room = rooms.get(code);

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    room.actions.push({ ...action, id: Date.now() + Math.random().toString(36) });
    // Keep max 30 recent actions
    if (room.actions.length > 30) {
      room.actions = room.actions.slice(-30);
    }
    room.version++;
    room.lastUpdated = Date.now();

    res.json({ success: true, version: room.version });
  });

  // Host updates lobby player list directly
  app.post('/api/rooms/:code/lobby', (req, res) => {
    const code = req.params.code.toUpperCase();
    const { players, hostId } = req.body;
    const room = rooms.get(code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (players && Array.isArray(players)) room.players = players;
    if (hostId) room.hostId = hostId;
    room.version++;
    room.lastUpdated = Date.now();
    res.json({ success: true, version: room.version });
  });

  // Player leaves room
  app.post('/api/rooms/:code/leave', (req, res) => {
    const code = req.params.code.toUpperCase();
    const { playerId } = req.body;
    const room = rooms.get(code);
    if (room && playerId) {
      room.players = room.players.filter((p) => p.id !== playerId);
      room.version++;
      room.lastUpdated = Date.now();
    }
    res.json({ success: true });
  });

  // Poll for updates (lightweight 300ms poll)
  app.get('/api/rooms/:code/poll', (req, res) => {
    const code = req.params.code.toUpperCase();
    const clientVersion = parseInt(req.query.version as string, 10) || 0;
    const room = rooms.get(code);

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (room.version > clientVersion) {
      return res.json(room);
    }

    // Short wait for updates if already current
    let timeoutId: NodeJS.Timeout;
    const checkInterval = setInterval(() => {
      if (room.version > clientVersion) {
        clearInterval(checkInterval);
        clearTimeout(timeoutId);
        return res.json(room);
      }
    }, 250);

    timeoutId = setTimeout(() => {
      clearInterval(checkInterval);
      res.json({ version: room.version, noChange: true });
    }, 2500);
  });

  // Clean old rooms after 4 hours of inactivity
  setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms.entries()) {
      if (now - r.lastUpdated > 4 * 60 * 60 * 1000) {
        rooms.delete(code);
      }
    }
  }, 30 * 60 * 1000);

  // --- VITE MIDDLEWARE SETUP ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Guaranteed SPA fallback for any route/query params in dev
    app.use('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api/')) return next();
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        next(e);
      }
    });
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Card Clash Full-Stack server running on port ${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
