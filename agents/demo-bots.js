/**
 * Demo: 3 AI bots with different personalities playing the world
 * Run: node agents/demo-bots.js
 */

const API = 'http://localhost:3000/api';

const BOTS = [
  { name: '🧑‍🌾 Farmer-Claude', strategy: 'farmer' },
  { name: '⚡ Explorer-Claude', strategy: 'explorer' },
  { name: '🏗️ Builder-Claude', strategy: 'builder' },
];

async function api(path, options = {}) {
  const { headers: customHeaders, ...rest } = options;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...customHeaders },
  });
  return res.json();
}

async function initBot(bot) {
  // Join
  const join = await api('/join', {
    method: 'POST',
    body: JSON.stringify({ name: bot.name }),
  });
  bot.token = join.token;
  bot.playerId = join.player_id;
  console.log(`✅ ${bot.name} joined (${join.player_id})`);

  // Spawn 2 agents
  for (let i = 0; i < 2; i++) {
    const spawn = await api('/spawn', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bot.token}` },
    });
    if (!bot.agents) bot.agents = [];
    bot.agents.push(spawn.agent_id);
    console.log(`   🤖 Agent #${spawn.agent_id} at [${spawn.x}, ${spawn.y}]`);
  }
}

let maxCoord = 1023; // default, updated from /api/info on startup

function decideActions(bot, state) {
  const actions = [];

  for (const agent of state.controlled_agents) {
    const tile = state.local_tiles.find(t => t.x === agent.x && t.y === agent.y);
    const nearbyAgents = state.nearby_agents || [];

    switch (bot.strategy) {
      case 'farmer': {
        // Farmer: prioritize food and health, farm a lot, stay put
        if (agent.energy < 15) {
          // Rest — skip action to regen energy
          break;
        }
        if (!tile || tile.food < 30) {
          actions.push({ agent_id: agent.id, action: 'farm', parameters: {} });
        } else {
          actions.push({ agent_id: agent.id, action: 'gather', parameters: {} });
        }
        // Trade if someone is nearby
        if (nearbyAgents.length > 0 && agent.energy > 20) {
          actions.push({
            agent_id: agent.id,
            action: 'trade',
            parameters: { target_agent_id: nearbyAgents[0].id, offer: 'energy', amount: 8 },
          });
        }
        break;
      }

      case 'explorer': {
        // Explorer: move a lot, gather from different tiles
        if (agent.energy < 15) {
          actions.push({ agent_id: agent.id, action: 'gather', parameters: {} });
          break;
        }

        // Find the richest nearby tile and move toward it
        const richTiles = state.local_tiles
          .filter(t => !(t.x === agent.x && t.y === agent.y))
          .map(t => ({ ...t, value: t.energy + t.food + t.materials }))
          .sort((a, b) => b.value - a.value);

        if (richTiles.length > 0) {
          const target = richTiles[0];
          // Move max 3 steps toward target
          const dx = Math.sign(target.x - agent.x) * Math.min(3, Math.abs(target.x - agent.x));
          const dy = Math.sign(target.y - agent.y) * Math.min(3 - Math.abs(dx), Math.abs(target.y - agent.y));
          const destX = Math.max(0, Math.min(maxCoord, agent.x + dx));
          const destY = Math.max(0, Math.min(maxCoord, agent.y + dy));

          if (destX !== agent.x || destY !== agent.y) {
            actions.push({
              agent_id: agent.id,
              action: 'move',
              parameters: { destination: [destX, destY] },
            });
          }
        }

        actions.push({ agent_id: agent.id, action: 'gather', parameters: {} });
        break;
      }

      case 'builder': {
        // Builder: gather materials and build solar panels
        if (agent.energy < 25) {
          actions.push({ agent_id: agent.id, action: 'gather', parameters: {} });
          break;
        }

        if (tile && tile.materials >= 30 && agent.energy >= 20) {
          actions.push({ agent_id: agent.id, action: 'build_solar', parameters: {} });
        } else if (tile && tile.materials < 30) {
          // Move to material-rich tile
          const matTiles = state.local_tiles
            .filter(t => t.materials > 30)
            .sort((a, b) => b.materials - a.materials);

          if (matTiles.length > 0) {
            const target = matTiles[0];
            const dx = Math.sign(target.x - agent.x) * Math.min(3, Math.abs(target.x - agent.x));
            const dy = Math.sign(target.y - agent.y) * Math.min(3 - Math.abs(dx), Math.abs(target.y - agent.y));
            const destX = Math.max(0, Math.min(maxCoord, agent.x + dx));
            const destY = Math.max(0, Math.min(maxCoord, agent.y + dy));

            actions.push({
              agent_id: agent.id,
              action: 'move',
              parameters: { destination: [destX, destY] },
            });
          } else {
            actions.push({ agent_id: agent.id, action: 'farm', parameters: {} });
          }
        } else {
          actions.push({ agent_id: agent.id, action: 'gather', parameters: {} });
        }
        break;
      }
    }
  }

  // Limit to 2 actions per agent
  const agentActionCount = {};
  return actions.filter(a => {
    agentActionCount[a.agent_id] = (agentActionCount[a.agent_id] || 0) + 1;
    return agentActionCount[a.agent_id] <= 2;
  });
}

async function botTick(bot) {
  try {
    // Get state
    const state = await api('/state', {
      headers: { Authorization: `Bearer ${bot.token}` },
    });

    if (!state.controlled_agents || state.controlled_agents.length === 0) {
      console.log(`💀 ${bot.name} has no agents alive!`);
      return;
    }

    // Decide actions
    const actions = decideActions(bot, state);

    if (actions.length === 0) {
      console.log(`😴 ${bot.name} is resting this tick`);
      return;
    }

    // Submit
    const result = await api('/actions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bot.token}` },
      body: JSON.stringify({ tick_actions: actions }),
    });

    const summary = actions.map(a => `#${a.agent_id}→${a.action}`).join(', ');
    console.log(`🎮 ${bot.name}: ${summary} (queued ${result.queued})`);
  } catch (err) {
    console.error(`❌ ${bot.name} error:`, err.message);
  }
}

async function main() {
  console.log('\n🌍 === AI WORLD DEMO ===\n');

  // Fetch world size
  const info = await api('/info');
  maxCoord = (info.world_size || info.grid_size || 1024) - 1;
  console.log(`🗺️  World size: ${maxCoord + 1}x${maxCoord + 1}\n`);
  console.log('Initializing 3 bots with different strategies...\n');

  // Init all bots
  for (const bot of BOTS) {
    await initBot(bot);
  }

  console.log('\n🎮 Starting game loop (Ctrl+C to stop)...\n');

  // Game loop — run every 4 seconds (slightly before 5s tick)
  const interval = setInterval(async () => {
    const tick = await api('/info');
    console.log(`\n── Tick ${tick.tick} ──`);

    for (const bot of BOTS) {
      await botTick(bot);
    }
  }, 4000);

  // Show leaderboard every 20 seconds
  setInterval(async () => {
    const lb = await api('/leaderboard');
    console.log('\n🏆 LEADERBOARD:');
    lb.slice(0, 6).forEach((entry, i) => {
      const medals = ['🥇', '🥈', '🥉'];
      const medal = medals[i] || `${i + 1}.`;
      console.log(`   ${medal} #${entry.id} ${entry.playerName} — Score: ${entry.score}`);
    });
  }, 20000);

  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('\n👋 Demo stopped');
    process.exit(0);
  });
}

main().catch(console.error);
