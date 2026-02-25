const express = require('express');
const {
  registerPlayer, registerOrFindPlayer, spawnAgent, getPlayerByToken,
  getPlayerState, getViewportSnapshot, getLeaderboard, WORLD_SIZE,
} = require('./world');
const { queueActions, COSTS } = require('./engine');
const { isEnabled: isOAuthEnabled } = require('./auth');
const cm = require('./chunk-manager');

function createRouter(world) {
  const router = express.Router();

  function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization header (Bearer <token>)' });
    }
    const player = getPlayerByToken(world, authHeader.slice(7));
    if (!player) return res.status(403).json({ error: 'Invalid token' });
    req.player = player;
    next();
  }

  // POST /api/join
  router.post('/join', (req, res) => {
    // If OAuth is enabled, reject anonymous joins
    if (isOAuthEnabled()) {
      return res.status(403).json({
        error: 'Anonymous join is disabled. Use GitHub OAuth to authenticate.',
        auth_url: '/auth/github',
        device_flow: 'POST /auth/device/start',
      });
    }

    const { name } = req.body || {};
    const { playerId, token } = registerPlayer(world, name);
    const player = world.players[playerId];
    console.log(`🎮 Player joined: ${player.name} (${playerId})`);
    res.json({
      player_id: playerId, token, name: player.name,
      message: `Welcome to the AI World, ${player.name}! World is ${world.worldSize}x${world.worldSize}. Next: POST /api/spawn`,
    });
  });

  // POST /api/spawn
  router.post('/spawn', authMiddleware, (req, res) => {
    const { nickname } = req.body || {};
    const result = spawnAgent(world, req.player.id, nickname);
    if (result.error) return res.status(400).json({ error: result.error });
    const { agent } = result;
    console.log(`🤖 ${agent.nickname} (#${agent.id}) spawned for ${req.player.name} at [${agent.x}, ${agent.y}]`);
    res.json({
      agent_id: agent.id, nickname: agent.nickname,
      x: agent.x, y: agent.y,
      health: agent.health, energy: agent.energy, wealth: agent.wealth,
      owner: agent.githubLogin || req.player.name,
      message: `${agent.nickname} (#${agent.id}) spawned at [${agent.x}, ${agent.y}]. World is ${world.worldSize}x${world.worldSize}.`,
    });
  });

  // GET /api/state
  router.get('/state', authMiddleware, (req, res) => {
    const state = getPlayerState(world, req.player.id);
    if (!state) return res.status(404).json({ error: 'Player state not found' });
    res.json(state);
  });

  // POST /api/actions
  router.post('/actions', authMiddleware, (req, res) => {
    const { tick_actions } = req.body || {};
    if (!tick_actions || !Array.isArray(tick_actions)) {
      return res.status(400).json({ error: 'Missing tick_actions array' });
    }
    const playerAgentIds = req.player.agentIds;
    const invalid = tick_actions.filter((a) => !playerAgentIds.includes(a.agent_id));
    if (invalid.length > 0) {
      return res.status(403).json({ error: `You don't control agent(s): ${invalid.map((a) => a.agent_id).join(', ')}` });
    }
    const counts = {};
    for (const a of tick_actions) {
      counts[a.agent_id] = (counts[a.agent_id] || 0) + 1;
      if (counts[a.agent_id] > 2) {
        return res.status(400).json({ error: `Too many actions for agent #${a.agent_id} (max 2)` });
      }
    }
    queueActions(req.player.id, tick_actions);
    console.log(`📋 ${req.player.name} queued ${tick_actions.length} action(s)`);
    res.json({ queued: tick_actions.length, current_tick: world.tick });
  });

  // GET /api/world — viewport-scoped
  router.get('/world', (req, res) => {
    const viewport = {
      x: parseInt(req.query.x) || 0,
      y: parseInt(req.query.y) || 0,
      w: Math.min(parseInt(req.query.w) || 120, 500),
      h: Math.min(parseInt(req.query.h) || 120, 500),
    };
    res.json(getViewportSnapshot(world, viewport));
  });

  // GET /api/leaderboard
  router.get('/leaderboard', (req, res) => {
    res.json(getLeaderboard(world));
  });

  // GET /api/info
  router.get('/info', (req, res) => {
    res.json({
      name: 'Spawnground',
      version: '0.2.0',
      grid_size: world.worldSize,
      world_size: world.worldSize,
      chunk_size: world.chunkSize,
      tick: world.tick,
      total_players: Object.keys(world.players).length,
      total_agents: Object.keys(world.agents).length,
      chunk_stats: cm.getChunkStats(),
      auth: { github_oauth: isOAuthEnabled() },
      action_costs: COSTS,
      rules: {
        max_agents_per_player: 3,
        max_actions_per_agent_per_tick: 2,
        max_move_distance: 3,
        view_radius: 5,
      },
    });
  });

  return router;
}

module.exports = { createRouter };
