// ═══════════════════════════════════════════════════════════════
// Chunk Manager — Lazy-loaded, deterministic chunk system
// ═══════════════════════════════════════════════════════════════

const CHUNK_SIZE = 32;

// Biome definitions (shared with world.js)
const BIOMES = {
  forest: { energy: 0.3, food: 1.5, materials: 1.2 },
  desert: { energy: 1.8, food: 0.2, materials: 0.5 },
  plains: { energy: 0.8, food: 1.2, materials: 0.6 },
  mountains: { energy: 0.5, food: 0.3, materials: 2.0 },
  lake: { energy: 0.6, food: 1.8, materials: 0.3 },
};

const RESOURCE_RANGES = {
  energy: { min: 5, max: 60 },
  food: { min: 5, max: 60 },
  materials: { min: 5, max: 60 },
};

const BIOME_NAMES = Object.keys(BIOMES);

// ── Seeded PRNG (Mulberry32) ──────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRange(rng, min, max) {
  return min + rng() * (max - min);
}

// ── Chunk storage ─────────────────────────────────────────────
const chunks = new Map(); // key "cx,cy" -> { tiles, lastAccessed, dirty }

function getChunkKey(cx, cy) {
  return `${cx},${cy}`;
}

function toChunkCoords(x, y) {
  return {
    cx: Math.floor(x / CHUNK_SIZE),
    cy: Math.floor(y / CHUNK_SIZE),
    lx: ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
    ly: ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
  };
}

// ── Biome seed points (generated once from worldSeed) ─────────
let cachedBiomeSeedPoints = null;
let cachedWorldSeed = null;

function generateBiomeSeedPoints(worldSeed, worldSize) {
  const rng = mulberry32(worldSeed);
  // ~1 seed per 50x50 area
  const count = Math.max(20, Math.ceil((worldSize / 50) ** 2));
  const seeds = [];
  for (let i = 0; i < count; i++) {
    seeds.push({
      x: Math.floor(rng() * worldSize),
      y: Math.floor(rng() * worldSize),
      biome: BIOME_NAMES[Math.floor(rng() * BIOME_NAMES.length)],
    });
  }
  return seeds;
}

function getBiomeSeedPoints(worldSeed, worldSize) {
  if (cachedWorldSeed !== worldSeed) {
    cachedBiomeSeedPoints = generateBiomeSeedPoints(worldSeed, worldSize);
    cachedWorldSeed = worldSeed;
  }
  return cachedBiomeSeedPoints;
}

// ── Find nearest biome (Manhattan distance for speed) ─────────
function findNearestBiome(wx, wy, seedPoints) {
  let minDist = Infinity;
  let bestBiome = 'plains';
  for (const seed of seedPoints) {
    const dist = Math.abs(wx - seed.x) + Math.abs(wy - seed.y);
    if (dist < minDist) {
      minDist = dist;
      bestBiome = seed.biome;
    }
  }
  return bestBiome;
}

// ── Generate a single chunk deterministically ─────────────────
function generateChunk(cx, cy, worldSeed, worldSize) {
  const seedPoints = getBiomeSeedPoints(worldSeed, worldSize);
  // Unique RNG per chunk
  const rng = mulberry32(worldSeed ^ (cx * 73856093) ^ (cy * 19349663));
  const tiles = [];
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    tiles[ly] = [];
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = baseX + lx;
      const wy = baseY + ly;
      const biome = findNearestBiome(wx, wy, seedPoints);
      const mult = BIOMES[biome];
      tiles[ly][lx] = {
        energy: Math.floor(seededRange(rng, RESOURCE_RANGES.energy.min, RESOURCE_RANGES.energy.max) * mult.energy),
        food: Math.floor(seededRange(rng, RESOURCE_RANGES.food.min, RESOURCE_RANGES.food.max) * mult.food),
        materials: Math.floor(seededRange(rng, RESOURCE_RANGES.materials.min, RESOURCE_RANGES.materials.max) * mult.materials),
        solar: 0,
        biome,
      };
    }
  }

  return tiles;
}

// ── Get or create a chunk ─────────────────────────────────────
function getOrCreateChunk(cx, cy, worldSeed, worldSize) {
  const key = getChunkKey(cx, cy);
  let chunk = chunks.get(key);
  if (chunk) {
    chunk.lastAccessed = Date.now();
    return chunk;
  }

  // Generate new chunk
  const tiles = generateChunk(cx, cy, worldSeed, worldSize);
  chunk = {
    cx,
    cy,
    tiles,
    lastAccessed: Date.now(),
    dirty: false,
  };
  chunks.set(key, chunk);
  return chunk;
}

// ── Tile access ───────────────────────────────────────────────
function getTile(x, y, worldSeed, worldSize) {
  if (x < 0 || x >= worldSize || y < 0 || y >= worldSize) return null;
  const { cx, cy, lx, ly } = toChunkCoords(x, y);
  const chunk = getOrCreateChunk(cx, cy, worldSeed, worldSize);
  return chunk.tiles[ly][lx];
}

// Mark a chunk as dirty (tile was modified)
function markDirty(x, y) {
  const { cx, cy } = toChunkCoords(x, y);
  const key = getChunkKey(cx, cy);
  const chunk = chunks.get(key);
  if (chunk) chunk.dirty = true;
}

// ── Evict inactive chunks ─────────────────────────────────────
function evictInactiveChunks(activeChunkKeys) {
  const now = Date.now();
  const EVICT_AGE = 60000; // 60 seconds

  for (const [key, chunk] of chunks) {
    if (activeChunkKeys.has(key)) continue;
    if (now - chunk.lastAccessed > EVICT_AGE) {
      chunks.delete(key);
    }
  }
}

// ── Compute active chunks from agent positions ────────────────
function getActiveChunkKeys(agents) {
  const keys = new Set();
  for (const agent of Object.values(agents)) {
    const { cx, cy } = toChunkCoords(agent.x, agent.y);
    // Agent's chunk + 1-ring neighbors (for view radius crossing)
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcy = -1; dcy <= 1; dcy++) {
        keys.add(getChunkKey(cx + dcx, cy + dcy));
      }
    }
  }
  return keys;
}

// ── Viewport-scoped data builders ─────────────────────────────

// Build biome map for a rect: returns array of strings (one per row)
function buildBiomeMapRect(worldSeed, worldSize, vx, vy, vw, vh) {
  const map = [];
  for (let y = vy; y < vy + vh && y < worldSize; y++) {
    let row = '';
    for (let x = vx; x < vx + vw && x < worldSize; x++) {
      const tile = getTile(x, y, worldSeed, worldSize);
      row += tile ? tile.biome.charAt(0) : 'p';
    }
    map.push(row);
  }
  return map;
}

// Build solar map for a rect: sparse array
function buildSolarMapRect(worldSeed, worldSize, vx, vy, vw, vh) {
  const panels = [];
  for (let y = vy; y < vy + vh && y < worldSize; y++) {
    for (let x = vx; x < vx + vw && x < worldSize; x++) {
      const tile = getTile(x, y, worldSeed, worldSize);
      if (tile && tile.solar > 0) {
        panels.push({ x: x - vx, y: y - vy, s: tile.solar });
      }
    }
  }
  return panels;
}

// Downsample resources for a rect
function downsampleResourcesRect(worldSeed, worldSize, vx, vy, vw, vh) {
  const step = 4;
  const summary = [];
  for (let y = vy; y < vy + vh && y < worldSize; y += step) {
    const row = [];
    for (let x = vx; x < vx + vw && x < worldSize; x += step) {
      const tile = getTile(x, y, worldSeed, worldSize);
      if (tile) {
        row.push({
          x: x - vx,
          y: y - vy,
          e: Math.round(tile.energy),
          f: Math.round(tile.food),
          m: Math.round(tile.materials),
        });
      }
    }
    summary.push(row);
  }
  return summary;
}

// Get agents within a rect
function getAgentsInRect(agents, vx, vy, vw, vh) {
  const result = [];
  for (const a of Object.values(agents)) {
    if (a.x >= vx && a.x < vx + vw && a.y >= vy && a.y < vy + vh) {
      result.push({
        id: a.id,
        playerName: a.playerName,
        nickname: a.nickname,
        githubLogin: a.githubLogin,
        avatarUrl: a.avatarUrl,
        x: a.x - vx, // relative to viewport
        y: a.y - vy,
        ax: a.x,      // absolute coords too
        ay: a.y,
        health: a.health,
        energy: a.energy,
        wealth: a.wealth,
      });
    }
  }
  return result;
}

// ── Stats ─────────────────────────────────────────────────────
function getChunkStats() {
  return {
    loaded: chunks.size,
    dirty: Array.from(chunks.values()).filter(c => c.dirty).length,
  };
}

// Get/set dirty chunks for persistence
function getDirtyChunks() {
  const dirty = [];
  for (const [key, chunk] of chunks) {
    if (chunk.dirty) {
      dirty.push({ key, cx: chunk.cx, cy: chunk.cy, tiles: chunk.tiles });
    }
  }
  return dirty;
}

function loadChunkData(cx, cy, tiles) {
  const key = getChunkKey(cx, cy);
  chunks.set(key, {
    cx,
    cy,
    tiles,
    lastAccessed: Date.now(),
    dirty: false,
  });
}

function clearDirtyFlags() {
  for (const chunk of chunks.values()) {
    chunk.dirty = false;
  }
}

module.exports = {
  CHUNK_SIZE,
  BIOMES,
  toChunkCoords,
  getChunkKey,
  getOrCreateChunk,
  getTile,
  markDirty,
  evictInactiveChunks,
  getActiveChunkKeys,
  buildBiomeMapRect,
  buildSolarMapRect,
  downsampleResourcesRect,
  getAgentsInRect,
  getChunkStats,
  getDirtyChunks,
  loadChunkData,
  clearDirtyFlags,
  getBiomeSeedPoints,
};
