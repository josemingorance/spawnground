const fs = require('fs');
const path = require('path');
const cm = require('./chunk-manager');

const WORLD_SIZE = 1024;
const SAVE_DIR = path.join(__dirname, '..', 'world-data');
const META_FILE = path.join(SAVE_DIR, 'meta.json');
const CHUNKS_DIR = path.join(SAVE_DIR, 'chunks');

const AGENT_DEFAULTS = {
  health: 100,
  energy: 80,
  wealth: 10,
};

// ── World creation ────────────────────────────────────────────
function createWorld() {
  const worldSeed = Date.now();
  // Pre-generate biome seed points (cached in chunk-manager)
  cm.getBiomeSeedPoints(worldSeed, WORLD_SIZE);

  return {
    worldSeed,
    worldSize: WORLD_SIZE,
    chunkSize: cm.CHUNK_SIZE,
    agents: {},
    players: {},
    nextAgentId: 1,
    nextPlayerId: 1,
    tick: 0,
    createdAt: Date.now(),
  };
}

// ── Tile access (delegates to chunk manager) ──────────────────
function getTileAt(world, x, y) {
  return cm.getTile(x, y, world.worldSeed, world.worldSize);
}

// ── Agent local tiles (5-tile radius) ─────────────────────────
function getAgentLocalTiles(world, agentId) {
  const agent = world.agents[agentId];
  if (!agent) return [];

  const VIEW_RADIUS = 5;
  const tiles = [];
  for (let dy = -VIEW_RADIUS; dy <= VIEW_RADIUS; dy++) {
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      const nx = agent.x + dx;
      const ny = agent.y + dy;
      const tile = getTileAt(world, nx, ny);
      if (tile) {
        tiles.push({ x: nx, y: ny, ...tile });
      }
    }
  }
  return tiles;
}

// ── Nearby agents (within 5 tiles) ────────────────────────────
function getNearbyAgents(world, agentId) {
  const agent = world.agents[agentId];
  if (!agent) return [];

  const VIEW_RADIUS = 5;
  const nearby = [];
  for (const [id, other] of Object.entries(world.agents)) {
    if (Number(id) === agentId) continue;
    const dist = Math.abs(other.x - agent.x) + Math.abs(other.y - agent.y);
    if (dist <= VIEW_RADIUS) {
      nearby.push({
        id: Number(id),
        x: other.x,
        y: other.y,
        health: other.health,
        energy: other.energy,
        wealth: other.wealth,
      });
    }
  }
  return nearby;
}

// ── Player state for AI agents ────────────────────────────────
function getPlayerState(world, playerId) {
  const player = world.players[playerId];
  if (!player) return null;

  const controlledAgents = player.agentIds
    .map((id) => world.agents[id])
    .filter(Boolean)
    .map((a) => ({ id: a.id, x: a.x, y: a.y, health: a.health, energy: a.energy, wealth: a.wealth }));

  const localTilesMap = new Map();
  for (const agentId of player.agentIds) {
    for (const tile of getAgentLocalTiles(world, agentId)) {
      localTilesMap.set(`${tile.x},${tile.y}`, tile);
    }
  }

  const nearbyAgentsMap = new Map();
  for (const agentId of player.agentIds) {
    for (const a of getNearbyAgents(world, agentId)) {
      nearbyAgentsMap.set(a.id, a);
    }
  }

  const allAgents = Object.values(world.agents);
  const avgHealth = allAgents.length > 0
    ? Math.round(allAgents.reduce((s, a) => s + a.health, 0) / allAgents.length) : 0;
  const avgWealth = allAgents.length > 0
    ? Math.round(allAgents.reduce((s, a) => s + a.wealth, 0) / allAgents.length) : 0;

  return {
    tick: world.tick,
    controlled_agents: controlledAgents,
    nearby_agents: Array.from(nearbyAgentsMap.values()),
    local_tiles: Array.from(localTilesMap.values()),
    global_state_summary: {
      total_agents: allAgents.length,
      avg_health: avgHealth,
      avg_wealth: avgWealth,
      world_size: world.worldSize,
    },
    available_actions: ['move', 'farm', 'gather', 'build_solar', 'trade'],
  };
}

// ── Register player (anonymous, dev mode) ────────────────────
function registerPlayer(world, name) {
  const playerId = `p${world.nextPlayerId++}`;
  const token = generateToken();
  world.players[playerId] = {
    id: playerId,
    name: name || `Player-${playerId}`,
    token,
    agentIds: [],
    joinedAt: Date.now(),
  };
  return { playerId, token };
}

// ── Register or find player by GitHub identity ───────────────
function registerOrFindPlayer(world, { githubId, githubLogin, avatarUrl }) {
  // Find existing player by GitHub ID
  const existing = Object.values(world.players).find((p) => p.githubId === githubId);
  if (existing) {
    // Update in case username/avatar changed
    existing.name = githubLogin;
    existing.githubLogin = githubLogin;
    existing.avatarUrl = avatarUrl;
    return existing;
  }

  // Create new player
  const playerId = `p${world.nextPlayerId++}`;
  const token = generateToken();
  world.players[playerId] = {
    id: playerId,
    githubId,
    githubLogin,
    avatarUrl,
    name: githubLogin,
    token,
    agentIds: [],
    joinedAt: Date.now(),
  };
  return world.players[playerId];
}

// ── Spawn agent ───────────────────────────────────────────────
function spawnAgent(world, playerId, nickname) {
  const player = world.players[playerId];
  if (!player) return null;
  if (player.agentIds.length >= 3) {
    return { error: 'Maximum 3 agents per player' };
  }

  const agentId = world.nextAgentId++;
  let x, y, attempts = 0;
  do {
    x = Math.floor(Math.random() * world.worldSize);
    y = Math.floor(Math.random() * world.worldSize);
    attempts++;
  } while (attempts < 50 && Object.values(world.agents).some((a) => a.x === x && a.y === y));

  const displayName = player.githubLogin
    ? `@${player.githubLogin}`
    : player.name;

  const agent = {
    id: agentId,
    playerId,
    playerName: displayName,
    nickname: nickname || `Agent-${agentId}`,
    githubLogin: player.githubLogin || null,
    avatarUrl: player.avatarUrl || null,
    x, y,
    ...AGENT_DEFAULTS,
  };
  world.agents[agentId] = agent;
  player.agentIds.push(agentId);
  return { agent };
}

// ── Find player by token ──────────────────────────────────────
function getPlayerByToken(world, token) {
  return Object.values(world.players).find((p) => p.token === token) || null;
}

// ── Viewport-scoped world snapshot (for dashboard) ────────────
function getViewportSnapshot(world, viewport) {
  const { x = 0, y = 0, w = 100, h = 100 } = viewport || {};

  // Clamp viewport to world bounds
  const vx = Math.max(0, Math.min(x, world.worldSize - w));
  const vy = Math.max(0, Math.min(y, world.worldSize - h));
  const vw = Math.min(w, world.worldSize - vx);
  const vh = Math.min(h, world.worldSize - vy);

  return {
    tick: world.tick,
    world_size: world.worldSize,
    chunk_size: world.chunkSize,
    viewport: { x: vx, y: vy, w: vw, h: vh },
    agents: cm.getAgentsInRect(world.agents, vx, vy, vw, vh),
    all_agents_summary: Object.values(world.agents).map((a) => ({
      id: a.id, playerName: a.playerName, nickname: a.nickname,
      githubLogin: a.githubLogin, avatarUrl: a.avatarUrl,
      x: a.x, y: a.y,
    })),
    players: Object.values(world.players).map((p) => ({
      id: p.id, name: p.name, githubLogin: p.githubLogin,
      avatarUrl: p.avatarUrl, agentCount: p.agentIds.length,
    })),
    biome_map: cm.buildBiomeMapRect(world.worldSeed, world.worldSize, vx, vy, vw, vh),
    solar_map: cm.buildSolarMapRect(world.worldSeed, world.worldSize, vx, vy, vw, vh),
    resource_summary: cm.downsampleResourcesRect(world.worldSeed, world.worldSize, vx, vy, vw, vh),
    chunk_stats: cm.getChunkStats(),
  };
}

// ── Leaderboard ───────────────────────────────────────────────
function getLeaderboard(world) {
  return Object.values(world.agents)
    .map((a) => ({
      id: a.id, playerName: a.playerName, nickname: a.nickname,
      githubLogin: a.githubLogin, avatarUrl: a.avatarUrl,
      health: a.health, energy: a.energy, wealth: a.wealth,
      score: a.health + a.energy + a.wealth,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

// ── Token generation ──────────────────────────────────────────
function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// ── Persistence (split: meta + dirty chunks) ──────────────────
function saveState(world) {
  try {
    if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
    if (!fs.existsSync(CHUNKS_DIR)) fs.mkdirSync(CHUNKS_DIR, { recursive: true });

    // Save meta (agents, players, tick, seed)
    const meta = {
      worldSeed: world.worldSeed,
      worldSize: world.worldSize,
      chunkSize: world.chunkSize,
      agents: world.agents,
      players: world.players,
      nextAgentId: world.nextAgentId,
      nextPlayerId: world.nextPlayerId,
      tick: world.tick,
      createdAt: world.createdAt,
    };
    fs.writeFileSync(META_FILE, JSON.stringify(meta));

    // Save dirty chunks
    const dirty = cm.getDirtyChunks();
    for (const chunk of dirty) {
      const file = path.join(CHUNKS_DIR, `${chunk.cx}_${chunk.cy}.json`);
      fs.writeFileSync(file, JSON.stringify(chunk.tiles));
    }
    cm.clearDirtyFlags();

    if (dirty.length > 0) {
      console.log(`💾 Saved meta + ${dirty.length} dirty chunk(s)`);
    }
  } catch (err) {
    console.error('Failed to save:', err.message);
  }
}

function loadState() {
  try {
    // Try new split format
    if (fs.existsSync(META_FILE)) {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
      const world = {
        ...meta,
        worldSize: meta.worldSize || WORLD_SIZE,
        chunkSize: meta.chunkSize || cm.CHUNK_SIZE,
      };

      // Load saved chunks
      if (fs.existsSync(CHUNKS_DIR)) {
        const files = fs.readdirSync(CHUNKS_DIR);
        for (const file of files) {
          const match = file.match(/^(\d+)_(\d+)\.json$/);
          if (match) {
            const cx = parseInt(match[1]);
            const cy = parseInt(match[2]);
            const tiles = JSON.parse(fs.readFileSync(path.join(CHUNKS_DIR, file), 'utf-8'));
            cm.loadChunkData(cx, cy, tiles);
          }
        }
        console.log(`Loaded ${files.length} saved chunk(s)`);
      }

      console.log(`Loaded world (seed ${world.worldSeed}, ${world.worldSize}x${world.worldSize})`);
      return world;
    }
  } catch (err) {
    console.error('Failed to load:', err.message);
  }
  return null;
}

module.exports = {
  WORLD_SIZE,
  createWorld,
  getTileAt,
  getAgentLocalTiles,
  getNearbyAgents,
  getPlayerState,
  registerPlayer,
  registerOrFindPlayer,
  spawnAgent,
  getPlayerByToken,
  getViewportSnapshot,
  getLeaderboard,
  saveState,
  loadState,
};
