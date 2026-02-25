const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const { createWorld, loadState, saveState, getViewportSnapshot, WORLD_SIZE } = require('./world');
const { processTick } = require('./engine');
const { createRouter } = require('./api');

// ── Config ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TICK_INTERVAL = process.env.TICK_INTERVAL || 5000;

// ── World initialization ──────────────────────────────────────
let world = loadState() || createWorld();
console.log(`🌍 World ready: ${world.worldSize}x${world.worldSize} (tick ${world.tick}, ${Object.keys(world.agents).length} agents)`);

// ── Express app ───────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', createRouter(world));

// ── HTTP + WebSocket server ───────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  // Default viewport: center of the world, 120x120 tiles
  ws.viewport = {
    x: Math.floor(world.worldSize / 2) - 60,
    y: Math.floor(world.worldSize / 2) - 60,
    w: 120,
    h: 120,
  };
  clients.add(ws);
  console.log(`📡 Dashboard connected (${clients.size} total)`);

  // Send initial state
  ws.send(JSON.stringify({
    type: 'world_state',
    data: getViewportSnapshot(world, ws.viewport),
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'viewport') {
        ws.viewport = {
          x: Math.round(msg.x || 0),
          y: Math.round(msg.y || 0),
          w: Math.min(Math.round(msg.w || 120), 500), // cap at 500 tiles wide
          h: Math.min(Math.round(msg.h || 120), 500),
        };
        // Send immediate update for new viewport
        ws.send(JSON.stringify({
          type: 'world_state',
          data: getViewportSnapshot(world, ws.viewport),
        }));
      }
    } catch (e) { /* ignore bad messages */ }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`📡 Dashboard disconnected (${clients.size} total)`);
  });
});

// Per-client broadcast with viewport-scoped data
function broadcastTick(tickResult) {
  for (const client of clients) {
    if (client.readyState !== 1) continue;
    try {
      client.send(JSON.stringify({
        type: 'tick',
        data: {
          ...tickResult,
          world: getViewportSnapshot(world, client.viewport),
        },
      }));
    } catch (e) { /* skip broken clients */ }
  }
}

// ── Game loop ─────────────────────────────────────────────────
const tickInterval = setInterval(() => {
  const result = processTick(world);
  broadcastTick(result);

  // Auto-save every 10 ticks
  if (world.tick % 10 === 0) saveState(world);
}, TICK_INTERVAL);

// ── Startup ───────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║            🌍  AI WORLD SIMULATION  🌍               ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  World:      ${world.worldSize}x${world.worldSize} tiles (${Math.ceil(world.worldSize / 32)}x${Math.ceil(world.worldSize / 32)} chunks)       ║
║  Dashboard:  http://localhost:${PORT}                  ║
║  API:        http://localhost:${PORT}/api/info          ║
║  Tick:       ${TICK_INTERVAL / 1000}s                                        ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`);
});

// ── Graceful shutdown ─────────────────────────────────────────
function shutdown() {
  console.log('\n💾 Saving world state...');
  clearInterval(tickInterval);
  saveState(world);
  wss.close();
  server.close();
  console.log('👋 Server shut down. World state saved.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
