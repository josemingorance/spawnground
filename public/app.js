// ═══════════════════════════════════════════════════════════════
// SPAWNGROUND — Dashboard Renderer (Chunk-based, viewport-aware)
// ═══════════════════════════════════════════════════════════════

const canvas = document.getElementById('world-canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');

let worldState = null;
let prevAgentPositions = {};
let animFrame = 0;
let particles = [];
let ws = null;

// ── Auth / Token management ──────────────────────────────────
(function initAuth() {
  // Read token from ?token= URL param (OAuth callback)
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem('sg_token', urlToken);
    // Clean URL without reloading
    window.history.replaceState({}, '', '/');
  }

  // Check auth status and update UI
  fetch('/auth/info')
    .then((r) => r.json())
    .then((info) => {
      const loginBtn = document.getElementById('login-btn');
      const userInfo = document.getElementById('user-info');
      const token = localStorage.getItem('sg_token');

      if (info.enabled && !token) {
        // OAuth enabled, user not logged in — show login button
        loginBtn.classList.remove('hidden');
      } else if (token) {
        // User has token — try to get their identity from server
        fetch('/api/state', { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => r.ok ? r.json() : null)
          .then((state) => {
            if (!state) {
              // Invalid token
              localStorage.removeItem('sg_token');
              if (info.enabled) loginBtn.classList.remove('hidden');
              return;
            }
            // Find our player info from controlled agents
            if (state.controlled_agents && state.controlled_agents.length > 0) {
              // We have agents — but state doesn't include player-level info
              // Use world state which has players array
            }
          })
          .catch(() => {});

        // Also check via world state once connected
        window._sgToken = token;
      }
    })
    .catch(() => {
      // Auth endpoint not available (older server) — no-op
    });
})();

function updateAuthUI(worldStateData) {
  if (!worldStateData || !worldStateData.players) return;
  const token = localStorage.getItem('sg_token');
  if (!token) return;

  // Find our player in the players list by checking if we match any token
  // Since tokens aren't exposed in world state, we use a separate fetch
  // But we can also check if we already set user info
  const userInfo = document.getElementById('user-info');
  const loginBtn = document.getElementById('login-btn');
  if (userInfo.dataset.loaded) return;

  fetch('/api/state', { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.ok ? r.json() : null)
    .then((state) => {
      if (!state) return;
      // The /api/state response doesn't include player identity directly
      // Let's use a simpler approach — find player in world state players list
      // We'll match by checking each player's agents against our controlled agents
      if (state.controlled_agents && state.controlled_agents.length > 0) {
        const myAgentIds = state.controlled_agents.map((a) => a.id);
        const myPlayer = worldStateData.players.find((p) => {
          // Check if any of our agents belong to this player by looking at agent data
          return worldStateData.all_agents_summary &&
            worldStateData.all_agents_summary.some((a) =>
              myAgentIds.includes(a.id) && a.githubLogin
            );
        });

        // Simpler: find agent with our ID and get its githubLogin
        const myAgent = (worldStateData.all_agents_summary || []).find((a) =>
          myAgentIds.includes(a.id)
        );

        if (myAgent && myAgent.githubLogin) {
          const avatarEl = document.getElementById('user-avatar');
          const nameEl = document.getElementById('user-name');
          avatarEl.src = myAgent.avatarUrl || '';
          nameEl.textContent = `@${myAgent.githubLogin}`;
          userInfo.classList.remove('hidden');
          loginBtn.classList.add('hidden');
          userInfo.dataset.loaded = 'true';
        }
      }
    })
    .catch(() => {});
}

// Viewport state (in world tile coordinates)
let worldSize = 1024;
let vpX = 0, vpY = 0;   // top-left tile of viewport
let vpW = 120, vpH = 120; // viewport dimensions in tiles
let zoomLevel = 1;        // 1 = default, <1 = zoomed out, >1 = zoomed in

// Drag state
let isDragging = false;
let dragStartMouse = { x: 0, y: 0 };
let dragStartVP = { x: 0, y: 0 };

// ── Biome palette ─────────────────────────────────────────────
const BIOME_COLORS = {
  f: { base: '#1a4a12', light: '#2a6a22', dark: '#0e2a08', name: 'Forest', emoji: '🌲' },
  d: { base: '#8a7020', light: '#b09030', dark: '#5a4810', name: 'Desert', emoji: '🏜️' },
  p: { base: '#3a6a1a', light: '#4a8a2a', dark: '#1a3a08', name: 'Plains', emoji: '🌿' },
  m: { base: '#5a5a6a', light: '#7a7a8a', dark: '#3a3a4a', name: 'Mountains', emoji: '⛰️' },
  l: { base: '#1a4a6a', light: '#2a6a8a', dark: '#0a2a4a', name: 'Lake', emoji: '💧' },
};

// Agent colors
const PLAYER_COLORS = [
  { fill: '#4ecdc4', glow: '#4ecdc480', ring: '#7eeee6' },
  { fill: '#ff6b6b', glow: '#ff6b6b80', ring: '#ff9999' },
  { fill: '#ffd93d', glow: '#ffd93d80', ring: '#ffe680' },
  { fill: '#6c5ce7', glow: '#6c5ce780', ring: '#9b8ff0' },
  { fill: '#a8e6cf', glow: '#a8e6cf80', ring: '#c8f6df' },
  { fill: '#ff8a5c', glow: '#ff8a5c80', ring: '#ffb08a' },
  { fill: '#ea8685', glow: '#ea868580', ring: '#f0a8a8' },
  { fill: '#81ecec', glow: '#81ecec80', ring: '#a0f4f4' },
];
const playerColorMap = {};
let colorIndex = 0;

function getPlayerColor(playerName) {
  if (!playerColorMap[playerName]) {
    playerColorMap[playerName] = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
    colorIndex++;
  }
  return playerColorMap[playerName];
}

// ── Canvas sizing ─────────────────────────────────────────────
function resizeCanvas() {
  const container = document.getElementById('canvas-container');
  const size = Math.min(container.clientWidth - 40, container.clientHeight - 40);
  canvas.width = size;
  canvas.height = size;
  if (worldState) render();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Viewport management ───────────────────────────────────────
function sendViewport() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'viewport',
      x: Math.round(vpX),
      y: Math.round(vpY),
      w: Math.round(vpW),
      h: Math.round(vpH),
    }));
  }
}

let viewportTimeout = null;
function sendViewportDebounced() {
  clearTimeout(viewportTimeout);
  viewportTimeout = setTimeout(sendViewport, 100);
}

function setZoom(newZoom) {
  const oldZoom = zoomLevel;
  zoomLevel = Math.max(0.25, Math.min(3, newZoom));

  // Base viewport at zoom=1 is 120x120
  const baseSize = 120;
  const newSize = Math.round(baseSize / zoomLevel);

  // Zoom toward center
  const centerX = vpX + vpW / 2;
  const centerY = vpY + vpH / 2;
  vpW = Math.min(newSize, worldSize);
  vpH = Math.min(newSize, worldSize);
  vpX = Math.max(0, Math.min(centerX - vpW / 2, worldSize - vpW));
  vpY = Math.max(0, Math.min(centerY - vpH / 2, worldSize - vpH));

  sendViewportDebounced();
}

// Pan the viewport
function panViewport(dx, dy) {
  vpX = Math.max(0, Math.min(vpX + dx, worldSize - vpW));
  vpY = Math.max(0, Math.min(vpY + dy, worldSize - vpH));
  sendViewportDebounced();
}

// Zoom controls
document.getElementById('zoom-in').onclick = () => setZoom(zoomLevel * 1.4);
document.getElementById('zoom-out').onclick = () => setZoom(zoomLevel / 1.4);
document.getElementById('zoom-reset').onclick = () => {
  zoomLevel = 1;
  vpW = 120; vpH = 120;
  vpX = Math.floor(worldSize / 2) - 60;
  vpY = Math.floor(worldSize / 2) - 60;
  sendViewportDebounced();
};

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(zoomLevel * (e.deltaY > 0 ? 0.85 : 1.18));
});

// Drag to pan
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    isDragging = true;
    dragStartMouse = { x: e.clientX, y: e.clientY };
    dragStartVP = { x: vpX, y: vpY };
    canvas.style.cursor = 'grabbing';
  }
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const cellSize = canvas.width / vpW;
  const dx = -(e.clientX - dragStartMouse.x) / cellSize;
  const dy = -(e.clientY - dragStartMouse.y) / cellSize;
  vpX = Math.max(0, Math.min(dragStartVP.x + dx, worldSize - vpW));
  vpY = Math.max(0, Math.min(dragStartVP.y + dy, worldSize - vpH));
  sendViewportDebounced();
});

window.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    canvas.style.cursor = 'crosshair';
  }
});

// ── Particles ─────────────────────────────────────────────────
function spawnParticles(x, y, color, count = 5) {
  for (let i = 0; i < count; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2 - 1,
      life: 1, decay: 0.02 + Math.random() * 0.03,
      size: 1 + Math.random() * 2, color,
    });
  }
}

function updateAndDrawParticles() {
  particles = particles.filter((p) => {
    p.x += p.vx; p.y += p.vy; p.life -= p.decay;
    return p.life > 0;
  });
  for (const p of particles) {
    ctx.globalAlpha = p.life * 0.8;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ── Biome buffer (cached offscreen canvas) ────────────────────
let biomeBuffer = null;
let lastBiomeMap = null;

function renderBiomeBuffer(biomeMap, canvasSize) {
  const buf = document.createElement('canvas');
  buf.width = canvasSize;
  buf.height = canvasSize;
  const bctx = buf.getContext('2d');
  const rows = biomeMap.length;
  const cols = biomeMap[0] ? biomeMap[0].length : 0;
  const cellW = canvasSize / cols;
  const cellH = canvasSize / rows;

  for (let y = 0; y < rows; y++) {
    const row = biomeMap[y];
    for (let x = 0; x < cols; x++) {
      const biome = BIOME_COLORS[row[x]] || BIOME_COLORS.p;
      bctx.fillStyle = biome.base;
      bctx.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5);

      // Texture noise
      if ((x + y) % 3 === 0) {
        bctx.fillStyle = biome.light + '18';
        bctx.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5);
      }
      if ((x * 3 + y * 7) % 11 === 0) {
        bctx.fillStyle = biome.dark + '25';
        bctx.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5);
      }
    }
  }

  // Biome border edges
  bctx.globalCompositeOperation = 'source-atop';
  for (let y = 1; y < rows; y++) {
    for (let x = 1; x < cols; x++) {
      if (biomeMap[y][x] !== biomeMap[y - 1][x] || biomeMap[y][x] !== biomeMap[y][x - 1]) {
        bctx.fillStyle = 'rgba(0,0,0,0.12)';
        bctx.fillRect(x * cellW - 0.5, y * cellH - 0.5, cellW + 1, cellH + 1);
      }
    }
  }
  bctx.globalCompositeOperation = 'source-over';
  return buf;
}

// ── Main render ───────────────────────────────────────────────
function render() {
  if (!worldState) return;
  const { biome_map, solar_map, resource_summary, agents, viewport } = worldState;
  if (!viewport) return;

  const w = canvas.width;
  const h = canvas.height;
  const cellW = w / viewport.w;
  const cellH = h / viewport.h;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#06060f';
  ctx.fillRect(0, 0, w, h);

  // ── Terrain ─────────────────────────────────────
  if (biome_map && biome_map.length > 0) {
    if (biome_map !== lastBiomeMap || !biomeBuffer) {
      biomeBuffer = renderBiomeBuffer(biome_map, w);
      lastBiomeMap = biome_map;
    }
    ctx.drawImage(biomeBuffer, 0, 0, w, h);
  }

  // ── Resource brightness ─────────────────────────
  if (resource_summary) {
    const step = 4;
    const tilePxW = cellW * step;
    const tilePxH = cellH * step;
    for (const row of resource_summary) {
      for (const tile of row) {
        const totalRes = tile.e + tile.f + tile.m;
        if (totalRes > 60) {
          const intensity = Math.min((totalRes - 60) / 250, 0.2);
          ctx.fillStyle = `rgba(255, 255, 255, ${intensity})`;
          ctx.fillRect(tile.x * cellW, tile.y * cellH, tilePxW, tilePxH);
        }
      }
    }
  }

  // ── Solar panels ────────────────────────────────
  if (solar_map) {
    for (const panel of solar_map) {
      const cx = panel.x * cellW + cellW / 2;
      const cy = panel.y * cellH + cellH / 2;
      const glowR = cellW * (2 + panel.s * 0.8);
      const pulse = 0.35 + Math.sin(animFrame * 0.05 + panel.x * 0.3) * 0.15;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      grad.addColorStop(0, `rgba(255, 221, 0, ${pulse})`);
      grad.addColorStop(0.5, `rgba(255, 180, 0, ${pulse * 0.3})`);
      grad.addColorStop(1, 'rgba(255, 221, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
      ctx.fillStyle = `rgba(255, 221, 0, 0.7)`;
      ctx.font = `${Math.max(7, cellW * 1.4)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('☀', cx, cy);
    }
  }

  // ── Grid lines ──────────────────────────────────
  if (cellW > 3) {
    ctx.strokeStyle = 'rgba(255,255,255,0.025)';
    ctx.lineWidth = 0.3;
    const step = cellW > 6 ? 10 : 20;
    for (let i = 0; i <= viewport.w; i += step) {
      ctx.beginPath(); ctx.moveTo(i * cellW, 0); ctx.lineTo(i * cellW, h); ctx.stroke();
    }
    for (let i = 0; i <= viewport.h; i += step) {
      ctx.beginPath(); ctx.moveTo(0, i * cellH); ctx.lineTo(w, i * cellH); ctx.stroke();
    }
  }

  // ── Agents ──────────────────────────────────────
  if (agents && agents.length > 0) {
    for (const agent of agents) {
      const color = getPlayerColor(agent.playerName);
      const radius = Math.max(cellW * 1.8, 5);
      // Agents have relative coords (x,y) within viewport
      const drawX = agent.x * cellW + cellW / 2;
      const drawY = agent.y * cellH + cellH / 2;

      // Glow
      const pulseR = radius + 6 + Math.sin(animFrame * 0.06 + agent.id) * 3;
      const gGrad = ctx.createRadialGradient(drawX, drawY, radius * 0.3, drawX, drawY, pulseR);
      gGrad.addColorStop(0, color.glow);
      gGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = gGrad;
      ctx.beginPath(); ctx.arc(drawX, drawY, pulseR, 0, Math.PI * 2); ctx.fill();

      // Body
      const bGrad = ctx.createRadialGradient(drawX - radius * 0.2, drawY - radius * 0.2, 0, drawX, drawY, radius);
      bGrad.addColorStop(0, color.ring);
      bGrad.addColorStop(0.7, color.fill);
      bGrad.addColorStop(1, color.fill + 'cc');
      ctx.beginPath(); ctx.arc(drawX, drawY, radius, 0, Math.PI * 2);
      ctx.fillStyle = bGrad; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.2; ctx.stroke();

      // ID
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(8, cellW * 1.4)}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 4;
      ctx.fillText(`${agent.id}`, drawX, drawY);
      ctx.shadowBlur = 0;

      // Name (nickname if available, otherwise playerName)
      const displayLabel = agent.nickname && agent.nickname !== `Agent-${agent.id}`
        ? agent.nickname
        : (agent.playerName || '');
      ctx.font = `600 ${Math.max(7, cellW * 1)}px 'Inter', sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 3;
      ctx.fillText(displayLabel, drawX, drawY - radius - 8);
      // Owner line (smaller, muted)
      if (agent.githubLogin) {
        ctx.font = `500 ${Math.max(6, cellW * 0.75)}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText(`@${agent.githubLogin}`, drawX, drawY - radius - 18);
      }
      ctx.shadowBlur = 0;

      // Health + Energy bars
      const barW = radius * 2.5, barH = 2.5;
      const barX = drawX - barW / 2, barY = drawY + radius + 5;
      ctx.fillStyle = '#1a1a2e88';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = agent.health > 60 ? '#44dd88' : agent.health > 30 ? '#ffaa33' : '#ff4466';
      ctx.fillRect(barX, barY, barW * (agent.health / 100), barH);
      ctx.fillStyle = '#1a1a2e88';
      ctx.fillRect(barX, barY + barH + 1.5, barW, barH);
      ctx.fillStyle = '#ffaa33';
      ctx.fillRect(barX, barY + barH + 1.5, barW * (agent.energy / 100), barH);
    }
  }

  // ── Particles ───────────────────────────────────
  updateAndDrawParticles();

  // ── Viewport info overlay ───────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`[${viewport.x},${viewport.y}] ${viewport.w}x${viewport.h}`, 8, 8);
}

// ── Minimap ───────────────────────────────────────────────────
function renderMinimap() {
  if (!worldState || !worldState.all_agents_summary) return;
  const minimap = document.getElementById('minimap-canvas');
  if (!minimap) return;
  const mctx = minimap.getContext('2d');
  const size = minimap.width;

  mctx.fillStyle = '#0a0a1a';
  mctx.fillRect(0, 0, size, size);

  // Draw agents as dots
  const scale = size / worldSize;
  for (const a of worldState.all_agents_summary) {
    const color = getPlayerColor(a.playerName);
    mctx.fillStyle = color.fill;
    mctx.beginPath();
    mctx.arc(a.x * scale, a.y * scale, 2, 0, Math.PI * 2);
    mctx.fill();
  }

  // Draw viewport rect
  if (worldState.viewport) {
    const vp = worldState.viewport;
    mctx.strokeStyle = '#4ecdc4';
    mctx.lineWidth = 1;
    mctx.strokeRect(vp.x * scale, vp.y * scale, vp.w * scale, vp.h * scale);
  }
}

// ── Animation loop ────────────────────────────────────────────
function animate() {
  animFrame++;
  if (worldState) {
    render();
    renderMinimap();
  }
  requestAnimationFrame(animate);
}
animate();

// ── Tooltip ───────────────────────────────────────────────────
canvas.addEventListener('mousemove', (e) => {
  if (!worldState || isDragging || !worldState.viewport) return;

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const vp = worldState.viewport;
  const cellW = canvas.width / vp.w;
  const cellH = canvas.height / vp.h;

  const localX = Math.floor(mx / cellW);
  const localY = Math.floor(my / cellH);
  const worldTileX = vp.x + localX;
  const worldTileY = vp.y + localY;

  if (localX < 0 || localX >= vp.w || localY < 0 || localY >= vp.h) {
    tooltip.classList.add('hidden');
    return;
  }

  // Biome from biome_map
  let biomeLetter = null;
  if (worldState.biome_map && worldState.biome_map[localY]) {
    biomeLetter = worldState.biome_map[localY][localX];
  }

  // Resources (from downsampled)
  let resInfo = null;
  if (worldState.resource_summary) {
    const snapX = Math.floor(localX / 4) * 4;
    const snapY = Math.floor(localY / 4) * 4;
    const rowIdx = snapY / 4;
    const colIdx = snapX / 4;
    if (worldState.resource_summary[rowIdx]) {
      resInfo = worldState.resource_summary[rowIdx][colIdx];
    }
  }

  const solarHere = (worldState.solar_map || []).find((s) => s.x === localX && s.y === localY);
  const agentsHere = (worldState.agents || []).filter((a) =>
    Math.abs(a.x - localX) <= 1 && Math.abs(a.y - localY) <= 1
  );

  const biome = biomeLetter ? (BIOME_COLORS[biomeLetter] || BIOME_COLORS.p) : null;
  let html = `<span class="tt-coord">[${worldTileX}, ${worldTileY}]</span>`;
  if (biome) {
    html += `<span class="tt-biome" style="background:${biome.base}">${biome.emoji} ${biome.name}</span>`;
    if (resInfo) {
      html += `<div class="tt-resources">`;
      html += `<span class="tt-res">⚡${resInfo.e}</span>`;
      html += `<span class="tt-res">🌾${resInfo.f}</span>`;
      html += `<span class="tt-res">🪨${resInfo.m}</span>`;
      if (solarHere) html += `<span class="tt-res">☀️${solarHere.s}</span>`;
      html += `</div>`;
    }
  }
  for (const a of agentsHere) {
    const c = getPlayerColor(a.playerName);
    const nick = a.nickname || `Agent-${a.id}`;
    const owner = a.githubLogin ? `@${a.githubLogin}` : (a.playerName || '');
    html += `<div class="tt-agent">`;
    html += `<strong style="color:${c.fill}">🤖 ${nick}</strong> <span style="color:#888">${owner}</span>`;
    html += `<div class="tt-resources">`;
    html += `<span class="tt-res">❤️${a.health}</span>`;
    html += `<span class="tt-res">⚡${a.energy}</span>`;
    html += `<span class="tt-res">💰${a.wealth}</span>`;
    html += `</div></div>`;
  }

  tooltip.innerHTML = html;
  tooltip.classList.remove('hidden');
  let left = e.clientX - rect.left + 15;
  let top = e.clientY - rect.top - 10;
  const ttRect = tooltip.getBoundingClientRect();
  if (left + 220 > rect.width) left -= 240;
  tooltip.style.left = Math.max(0, left) + 'px';
  tooltip.style.top = Math.max(0, top) + 'px';
});

canvas.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));

// Minimap click to jump viewport
document.addEventListener('click', (e) => {
  const minimap = document.getElementById('minimap-canvas');
  if (!minimap || e.target !== minimap) return;
  const rect = minimap.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const scale = minimap.width / worldSize;
  vpX = Math.max(0, Math.min(mx / scale - vpW / 2, worldSize - vpW));
  vpY = Math.max(0, Math.min(my / scale - vpH / 2, worldSize - vpH));
  sendViewportDebounced();
});

// ── UI Updates ────────────────────────────────────────────────
function updateUI(state) {
  document.getElementById('tick-counter').textContent = state.tick;
  document.getElementById('agent-count').textContent = (state.all_agents_summary || state.agents || []).length;
  document.getElementById('player-count').textContent = (state.players || []).length;

  const wsEl = document.getElementById('world-size');
  if (wsEl) wsEl.textContent = `${state.world_size || '?'}²`;

  const csEl = document.getElementById('chunks-loaded');
  if (csEl && state.chunk_stats) csEl.textContent = state.chunk_stats.loaded;
}

function updateLeaderboard(agents) {
  const list = document.getElementById('leaderboard-list');
  if (!agents || agents.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🌍</div>Waiting for agents...</div>';
    return;
  }
  const sorted = [...agents].sort((a, b) =>
    (b.health + b.energy + b.wealth) - (a.health + a.energy + a.wealth)
  );
  list.innerHTML = sorted.slice(0, 8).map((a, i) => {
    const score = a.health + a.energy + a.wealth;
    const medals = ['🥇', '🥈', '🥉'];
    const medal = medals[i] || `<span style="color:#555">${i + 1}</span>`;
    const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const color = getPlayerColor(a.playerName);
    const nick = a.nickname || `Agent-${a.id}`;
    const avatarHtml = a.avatarUrl
      ? `<img class="lb-avatar" src="${a.avatarUrl}&s=44" alt="">`
      : '';
    const ownerHtml = a.githubLogin
      ? `<div class="lb-owner">@${a.githubLogin}</div>`
      : '';
    return `<div class="lb-entry ${rankClass}">
      <div class="lb-rank">${medal}</div>
      ${avatarHtml}
      <div class="lb-info">
        <div class="lb-name" style="color:${color.fill}">${nick}</div>
        ${ownerHtml}
        <div class="lb-bar"><div class="lb-bar-fill wealth" style="width:${(score / 300) * 100}%"></div></div>
      </div>
      <div class="lb-score">${score}</div>
    </div>`;
  }).join('');
}

function updateAgentCards(agents) {
  const list = document.getElementById('agents-list');
  if (!agents || agents.length === 0) return;
  list.innerHTML = agents.map((a) => {
    const color = getPlayerColor(a.playerName);
    const nick = a.nickname || `Agent-${a.id}`;
    const ownerTag = a.githubLogin ? `<span class="agent-owner">@${a.githubLogin}</span>` : '';
    return `<div class="agent-card" style="border-left:3px solid ${color.fill}">
      <div class="agent-top">
        <span class="agent-id" style="color:${color.fill}">${nick} ${ownerTag}</span>
        <span class="agent-pos">[${a.ax},${a.ay}]</span>
      </div>
      <div class="agent-bars">
        <div class="mini-bar"><div class="mini-bar-fill h" style="width:${a.health}%"></div></div>
        <div class="mini-bar"><div class="mini-bar-fill e" style="width:${a.energy}%"></div></div>
        <div class="mini-bar"><div class="mini-bar-fill w" style="width:${a.wealth}%"></div></div>
      </div>
    </div>`;
  }).join('');
}

function addEvent(text, type = 'action') {
  const list = document.getElementById('events-list');
  const item = document.createElement('div');
  item.className = `event-item ${type}`;
  const tick = worldState ? worldState.tick : '?';
  item.innerHTML = `<span class="event-tick">T${tick}</span> ${text}`;
  list.prepend(item);
  while (list.children.length > 60) list.removeChild(list.lastChild);
}

function classifyEvent(action) {
  const map = { move: 'move', farm: 'farm', gather: 'gather', build_solar: 'build', trade: 'trade' };
  return map[action] || 'action';
}

// ── WebSocket ─────────────────────────────────────────────────
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    document.querySelector('.pulse-dot').classList.add('connected');
    document.getElementById('connection-status').textContent = 'Live';
    addEvent('Dashboard connected');
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'world_state' || msg.type === 'tick') {
      const state = msg.type === 'tick' ? msg.data.world : msg.data;
      worldState = state;

      if (state.world_size) worldSize = state.world_size;
      if (state.viewport) {
        vpX = state.viewport.x;
        vpY = state.viewport.y;
        vpW = state.viewport.w;
        vpH = state.viewport.h;
      }

      updateUI(state);
      updateAuthUI(state);
      updateLeaderboard(state.agents);
      updateAgentCards(state.agents);

      if (msg.type === 'tick' && msg.data.results) {
        for (const r of msg.data.results) {
          if (r.event === 'agent_died') {
            addEvent(`💀 Agent #${r.agent_id} has fallen!`, 'death');
          } else if (r.result && r.result.success) {
            const emoji = { farm: '🌾', gather: '⛏️', move: '🏃', build_solar: '☀️', trade: '🤝' }[r.action] || '▶';
            addEvent(`${emoji} #${r.agent_id} ${r.result.message}`, classifyEvent(r.action));
          }
        }
      }
    }
  };

  ws.onclose = () => {
    document.querySelector('.pulse-dot').classList.remove('connected');
    document.getElementById('connection-status').textContent = 'Reconnecting...';
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

connect();
