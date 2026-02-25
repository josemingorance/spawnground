const { getTileAt } = require('./world');
const cm = require('./chunk-manager');

// Action costs
const COSTS = {
  move: { energy: 5 },
  farm: { energy: 10 },
  gather: { energy: 5 },
  build_solar: { energy: 20, materials: 30 },
  trade: { energy: 3 },
};

// Action queue: playerId -> array of tick_actions
const actionQueue = new Map();

function queueActions(playerId, tickActions) {
  if (!actionQueue.has(playerId)) actionQueue.set(playerId, []);
  actionQueue.get(playerId).push(...tickActions);
}

function processTick(world) {
  const results = [];

  // 1. Process all queued actions
  for (const [playerId, actions] of actionQueue.entries()) {
    for (const action of actions) {
      const result = executeAction(world, action);
      results.push({ playerId, ...action, result });
    }
  }
  actionQueue.clear();

  // 2. Natural regeneration for all agents
  for (const agent of Object.values(world.agents)) {
    const tile = getTileAt(world, agent.x, agent.y);
    if (!tile) continue;

    // Energy regen: base + solar bonus
    const solarBonus = tile.solar * 2;
    agent.energy = Math.min(100, agent.energy + 3 + solarBonus);

    // Health regen if food on tile
    if (tile.food > 0) {
      const foodConsumed = Math.min(2, tile.food);
      tile.food -= foodConsumed;
      agent.health = Math.min(100, agent.health + 5);
    } else {
      agent.health = Math.max(0, agent.health - 2);
    }

    // Slow resource regen
    tile.energy = Math.min(100, tile.energy + 1);
    tile.food = Math.min(100, tile.food + 1);
    tile.materials = Math.min(100, tile.materials + 0.5);

    // Mark chunk as dirty since tile was modified
    cm.markDirty(agent.x, agent.y);
  }

  // 3. Remove dead agents
  for (const [id, agent] of Object.entries(world.agents)) {
    if (agent.health <= 0) {
      const player = world.players[agent.playerId];
      if (player) player.agentIds = player.agentIds.filter((aid) => aid !== Number(id));
      delete world.agents[id];
      results.push({ agent_id: Number(id), event: 'agent_died' });
    }
  }

  // 4. Evict inactive chunks
  const activeKeys = cm.getActiveChunkKeys(world.agents);
  cm.evictInactiveChunks(activeKeys);

  // 5. Increment tick
  world.tick++;

  return { tick: world.tick, actions_processed: results.length, results };
}

function executeAction(world, action) {
  const { agent_id, action: actionType, parameters } = action;
  const agent = world.agents[agent_id];
  if (!agent) return { success: false, error: 'Agent not found' };

  const cost = COSTS[actionType];
  if (!cost) return { success: false, error: `Unknown action: ${actionType}` };
  if (cost.energy && agent.energy < cost.energy) {
    return { success: false, error: `Not enough energy (need ${cost.energy}, have ${agent.energy})` };
  }

  switch (actionType) {
    case 'move': return handleMove(world, agent, parameters);
    case 'farm': return handleFarm(world, agent);
    case 'gather': return handleGather(world, agent);
    case 'build_solar': return handleBuildSolar(world, agent);
    case 'trade': return handleTrade(world, agent, parameters);
    default: return { success: false, error: `Unhandled action: ${actionType}` };
  }
}

function handleMove(world, agent, params) {
  if (!params || params.destination === undefined) {
    return { success: false, error: 'Missing destination parameter' };
  }
  const [destX, destY] = Array.isArray(params.destination)
    ? params.destination : [params.destination.x, params.destination.y];

  if (destX < 0 || destX >= world.worldSize || destY < 0 || destY >= world.worldSize) {
    return { success: false, error: 'Destination out of bounds' };
  }
  const dist = Math.abs(destX - agent.x) + Math.abs(destY - agent.y);
  if (dist > 3) {
    return { success: false, error: `Too far (max 3, tried ${dist})` };
  }

  agent.energy -= COSTS.move.energy;
  agent.x = destX;
  agent.y = destY;
  return { success: true, message: `Moved to [${destX}, ${destY}]` };
}

function handleFarm(world, agent) {
  const tile = getTileAt(world, agent.x, agent.y);
  if (!tile) return { success: false, error: 'Invalid tile' };
  agent.energy -= COSTS.farm.energy;
  const foodGain = 10 + Math.floor(Math.random() * 10);
  tile.food = Math.min(100, tile.food + foodGain);
  cm.markDirty(agent.x, agent.y);
  return { success: true, message: `Farmed +${foodGain} food (tile now ${tile.food})` };
}

function handleGather(world, agent) {
  const tile = getTileAt(world, agent.x, agent.y);
  if (!tile) return { success: false, error: 'Invalid tile' };
  agent.energy -= COSTS.gather.energy;
  const gathered = { energy: Math.min(10, tile.energy), materials: Math.min(5, tile.materials) };
  tile.energy -= gathered.energy;
  tile.materials -= gathered.materials;
  const wealthGain = Math.floor((gathered.energy + gathered.materials) / 2);
  agent.wealth = Math.min(100, agent.wealth + wealthGain);
  agent.energy = Math.min(100, agent.energy + Math.floor(gathered.energy / 2));
  cm.markDirty(agent.x, agent.y);
  return { success: true, message: `Gathered ${gathered.energy} energy, ${gathered.materials} materials (+${wealthGain} wealth)` };
}

function handleBuildSolar(world, agent) {
  const tile = getTileAt(world, agent.x, agent.y);
  if (!tile) return { success: false, error: 'Invalid tile' };
  if (tile.materials < COSTS.build_solar.materials) {
    return { success: false, error: `Not enough materials on tile (need ${COSTS.build_solar.materials}, have ${Math.floor(tile.materials)})` };
  }
  agent.energy -= COSTS.build_solar.energy;
  tile.materials -= COSTS.build_solar.materials;
  tile.solar += 1;
  agent.wealth += 5;
  cm.markDirty(agent.x, agent.y);
  return { success: true, message: `Built solar panel #${tile.solar} (tile energy regen +2/tick)` };
}

function handleTrade(world, agent, params) {
  if (!params || !params.target_agent_id) {
    return { success: false, error: 'Missing target_agent_id' };
  }
  const target = world.agents[params.target_agent_id];
  if (!target) return { success: false, error: 'Target agent not found' };
  const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
  if (dist > 2) return { success: false, error: `Target too far (distance ${dist}, max 2)` };

  agent.energy -= COSTS.trade.energy;
  const offer = params.offer || 'energy';
  const amount = Math.min(params.amount || 10, 20);

  if (offer === 'energy' && agent.energy >= amount) {
    agent.energy -= amount;
    target.energy = Math.min(100, target.energy + amount);
    agent.wealth = Math.min(100, agent.wealth + Math.floor(amount / 2));
    target.wealth = Math.min(100, target.wealth + Math.floor(amount / 2));
  } else if (offer === 'wealth' && agent.wealth >= amount) {
    agent.wealth -= amount;
    target.wealth = Math.min(100, target.wealth + amount);
  } else {
    return { success: false, error: `Cannot offer ${amount} ${offer}` };
  }
  return { success: true, message: `Traded ${amount} ${offer} with agent #${target.id}` };
}

module.exports = { queueActions, processTick, COSTS };
