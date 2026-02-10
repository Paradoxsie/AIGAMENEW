/*
Typed-array map model:
- terrain[i]: 0 water, 1 plains, 2 mountain
- owner[i]: 0 neutral, 1 player, 2.. bots
- building[i]: 0 none, 1 city, 2 defense
- bLevel[i]: building level
- combatProg[i]: attack progress 0..1 for actively contested tiles
Main loop:
- requestAnimationFrame render
- fixed timestep simulation at CONFIG.TICK_HZ
*/

const CONFIG = {
  TICK_HZ: 20,
  BASE_POP_CAP: 8000,
  POP_CAP_PER_LAND_TILE: 30,
  CITY_POP_CAP_BONUS_PER_LEVEL: 25000,
  START_POP_CURRENT: 6500,
  START_GOLD: 2000,
  GOLD_PER_WORKER_PER_SEC: 0.015,
  CITY_BASE_COST: 2500,
  DEF_BASE_COST: 1800,
  DEFENSE_RADIUS: 4,
  DEFENSE_BONUS_PER_LEVEL: 0.12,
  WIN_LAND_PCT: 0.72,
  STARTING_BLOB_TILES: 40,
  MIN_SEED_DISTANCE_MEDIUM: 25,
  BOT_BURST_SEC: 1.5
};

const BOT_PRESETS = {
  easy: { THINK_INTERVAL_SEC: 1.5, ECON_MULT: 0.9, TARGET_WORKER_PCT: 0.65, TARGET_ATTACK_RATIO: 0.16 },
  normal: { THINK_INTERVAL_SEC: 1.0, ECON_MULT: 1.0, TARGET_WORKER_PCT: 0.60, TARGET_ATTACK_RATIO: 0.20 },
  hard: { THINK_INTERVAL_SEC: 0.6, ECON_MULT: 1.1, TARGET_WORKER_PCT: 0.55, TARGET_ATTACK_RATIO: 0.24 }
};

const TERRAIN = { WATER: 0, PLAINS: 1, MOUNTAIN: 2 };
const BUILDING = { NONE: 0, CITY: 1, DEFENSE: 2 };

const ui = {
  canvas: document.getElementById('gameCanvas'),
  menu: document.getElementById('menuOverlay'),
  hud: document.getElementById('hud'),
  end: document.getElementById('endOverlay'),
  mapSize: document.getElementById('mapSize'),
  botCount: document.getElementById('botCount'),
  botCountLabel: document.getElementById('botCountLabel'),
  difficulty: document.getElementById('difficulty'),
  startBtn: document.getElementById('startBtn'),
  stats: document.getElementById('stats'),
  workersPct: document.getElementById('workersPct'),
  workersPctLabel: document.getElementById('workersPctLabel'),
  attackRatio: document.getElementById('attackRatio'),
  attackRatioLabel: document.getElementById('attackRatioLabel'),
  tooltip: document.getElementById('tooltip'),
  buildCityBtn: document.getElementById('buildCityBtn'),
  buildDefenseBtn: document.getElementById('buildDefenseBtn'),
  cancelBuildBtn: document.getElementById('cancelBuildBtn'),
  buildModeLabel: document.getElementById('buildModeLabel'),
  pauseBtn: document.getElementById('pauseBtn'),
  speedBtn: document.getElementById('speedBtn'),
  restartBtn: document.getElementById('restartBtn'),
  endTitle: document.getElementById('endTitle'),
  endStats: document.getElementById('endStats'),
  playAgainBtn: document.getElementById('playAgainBtn')
};

const ctx = ui.canvas.getContext('2d');
let offscreen = document.createElement('canvas');
let offctx = offscreen.getContext('2d');
let imageData;
let imageBuf;

let game = null;

function rand(min, max) { return min + Math.random() * (max - min); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function idx(x, y, W) { return y * W + x; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

function resizeCanvas() {
  ui.canvas.width = window.innerWidth;
  ui.canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function createGame(W, H, botCount, difficulty) {
  const len = W * H;
  const terrain = new Uint8Array(len);
  const owner = new Uint16Array(len);
  const building = new Uint8Array(len);
  const bLevel = new Uint8Array(len);
  const combatProg = new Float32Array(len);
  generateTerrain(W, H, terrain);

  const factions = [];
  factions.push(null);
  factions.push(makeFaction(1, false, difficulty));
  for (let i = 0; i < botCount; i++) factions.push(makeFaction(i + 2, true, difficulty));

  spawnFactions(W, H, terrain, owner, factions);

  const totalLand = terrain.reduce((a, t) => a + (t !== TERRAIN.WATER ? 1 : 0), 0);

  offscreen.width = W;
  offscreen.height = H;
  imageData = offctx.createImageData(W, H);
  imageBuf = imageData.data;

  return {
    W, H, len, terrain, owner, building, bLevel, combatProg, factions,
    totalLand,
    speed: 1,
    paused: false,
    running: true,
    playerAttack: { active: false, target: -1, mouseDown: false },
    botAttacks: new Map(),
    simAccum: 0,
    lastTs: performance.now(),
    popRecalcTimer: 0,
    camX: W * 0.5,
    camY: H * 0.5,
    zoom: Math.min(ui.canvas.width / W, ui.canvas.height / H) * 0.95,
    dragging: false,
    dragLastX: 0,
    dragLastY: 0,
    hoverTile: -1,
    buildMode: 'none',
    annexFlashes: [],
    startTime: performance.now(),
    recentTileLoss: new Float32Array(factions.length),
    ended: false
  };
}

function makeFaction(id, isBot, difficulty) {
  const preset = BOT_PRESETS[difficulty] || BOT_PRESETS.normal;
  return {
    id,
    isBot,
    gold: CONFIG.START_GOLD,
    popCurrent: CONFIG.START_POP_CURRENT,
    popCap: CONFIG.BASE_POP_CAP,
    workerPct: isBot ? preset.TARGET_WORKER_PCT : 0.60,
    attackRatio: isBot ? preset.TARGET_ATTACK_RATIO : 0.20,
    tilesOwnedLand: 0,
    thinkTimer: rand(0.1, preset.THINK_INTERVAL_SEC),
    thinkInterval: preset.THINK_INTERVAL_SEC,
    econMult: preset.ECON_MULT,
    currentBurst: 0,
    defeated: false
  };
}

function generateTerrain(W, H, terrain) {
  const noise = new Float32Array(W * H);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.random();
  for (let p = 0; p < 4; p++) {
    const out = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        let s = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) s += noise[idx(x + ox, y + oy, W)];
        out[idx(x, y, W)] = s / 9;
      }
    }
    noise.set(out);
  }

  const cx = W * 0.5, cy = H * 0.5;
  const maxD = Math.hypot(cx, cy);
  let landTarget = rand(0.25, 0.40);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y, W);
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const v = noise[i] - d * 0.18;
      terrain[i] = v > (0.57 - landTarget * 0.35) ? TERRAIN.PLAINS : TERRAIN.WATER;
    }
  }

  const mountainSeedCount = Math.floor(W * H * 0.004);
  const seeds = [];
  for (let i = 0; i < mountainSeedCount; i++) {
    const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
    const ii = idx(x, y, W);
    if (terrain[ii] !== TERRAIN.WATER) seeds.push(ii);
  }
  for (const s of seeds) {
    const sx = s % W, sy = (s / W) | 0;
    const r = (Math.random() * 4 + 2) | 0;
    for (let y = Math.max(0, sy - r); y <= Math.min(H - 1, sy + r); y++) {
      for (let x = Math.max(0, sx - r); x <= Math.min(W - 1, sx + r); x++) {
        const i = idx(x, y, W);
        if (terrain[i] === TERRAIN.WATER) continue;
        if (dist2(x, y, sx, sy) <= r * r && Math.random() < 0.65) terrain[i] = TERRAIN.MOUNTAIN;
      }
    }
  }
}

function spawnFactions(W, H, terrain, owner, factions) {
  const seeds = [];
  const minDist = CONFIG.MIN_SEED_DISTANCE_MEDIUM * (W / 384);
  let attempts = 0;
  while (seeds.length < factions.length - 1 && attempts < 20000) {
    attempts++;
    const x = (Math.random() * W) | 0;
    const y = (Math.random() * H) | 0;
    const i = idx(x, y, W);
    if (terrain[i] === TERRAIN.WATER) continue;
    let ok = true;
    for (const s of seeds) if (Math.hypot(x - s.x, y - s.y) < minDist) { ok = false; break; }
    if (ok) seeds.push({ x, y });
  }
  for (let f = 1; f < factions.length; f++) {
    const s = seeds[f - 1] || { x: (Math.random() * W) | 0, y: (Math.random() * H) | 0 };
    claimBlob(W, H, terrain, owner, s.x, s.y, CONFIG.STARTING_BLOB_TILES, f);
  }
  recalcTileCounts({ factions, owner, terrain });
}

function claimBlob(W, H, terrain, owner, sx, sy, targetCount, factionId) {
  const q = [idx(sx, sy, W)];
  const seen = new Uint8Array(W * H);
  let got = 0;
  while (q.length && got < targetCount) {
    const cur = q.shift();
    if (seen[cur]) continue;
    seen[cur] = 1;
    if (terrain[cur] === TERRAIN.WATER) continue;
    owner[cur] = factionId;
    got++;
    const x = cur % W, y = (cur / W) | 0;
    const n = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of n) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = idx(nx, ny, W);
      if (!seen[ni] && Math.random() < 0.9) q.push(ni);
    }
    if (Math.random() < 0.3) q.push(cur);
  }
}

function recalcTileCounts(g) {
  for (let i = 1; i < g.factions.length; i++) g.factions[i].tilesOwnedLand = 0;
  for (let i = 0; i < g.len || i < g.owner.length; i++) {
    if (g.terrain[i] === TERRAIN.WATER) continue;
    const o = g.owner[i];
    if (o > 0 && g.factions[o]) g.factions[o].tilesOwnedLand++;
  }
  for (let i = 1; i < g.factions.length; i++) recalcPopCap(g, i);
}

function recalcPopCap(g, factionId) {
  const f = g.factions[factionId];
  let cityLevels = 0;
  for (let i = 0; i < g.len; i++) if (g.owner[i] === factionId && g.building[i] === BUILDING.CITY) cityLevels += g.bLevel[i];
  f.popCap = CONFIG.BASE_POP_CAP + f.tilesOwnedLand * CONFIG.POP_CAP_PER_LAND_TILE + cityLevels * CONFIG.CITY_POP_CAP_BONUS_PER_LEVEL;
  f.popCurrent = clamp(f.popCurrent, 0, f.popCap);
}

function growthRateFromRatio(r) {
  const peak = 0.45;
  const sigma = 0.28;
  const g = 0.06 * Math.exp(-((r - peak) ** 2) / (2 * sigma * sigma));
  return Math.max(0.001, g);
}

function updateEconomy(g, dt) {
  g.popRecalcTimer += dt;
  const dtSec = dt;
  for (let i = 1; i < g.factions.length; i++) {
    const f = g.factions[i];
    if (!f) continue;
    const workers = f.popCurrent * f.workerPct;
    const econMult = f.isBot ? f.econMult : 1;
    f.gold += workers * CONFIG.GOLD_PER_WORKER_PER_SEC * econMult * dtSec;
    const ratio = f.popCap > 0 ? f.popCurrent / f.popCap : 0;
    f.popCurrent += f.popCurrent * growthRateFromRatio(ratio) * dtSec;
    f.popCurrent = clamp(f.popCurrent, 0, f.popCap);
  }
  if (g.popRecalcTimer >= 1) {
    g.popRecalcTimer = 0;
    for (let i = 1; i < g.factions.length; i++) recalcPopCap(g, i);
    for (let i = 1; i < g.factions.length; i++) g.recentTileLoss[i] *= 0.65;
  }
}

function hasOwnedNeighbor(g, tile, factionId) {
  const x = tile % g.W, y = (tile / g.W) | 0;
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  for (const [dx, dy] of dirs) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
    if (g.owner[idx(nx, ny, g.W)] === factionId) return true;
  }
  return false;
}

function localDefenseMultiplier(g, tile, defenderId) {
  const tx = tile % g.W, ty = (tile / g.W) | 0;
  let levels = 0;
  for (let y = Math.max(0, ty - CONFIG.DEFENSE_RADIUS); y <= Math.min(g.H - 1, ty + CONFIG.DEFENSE_RADIUS); y++) {
    for (let x = Math.max(0, tx - CONFIG.DEFENSE_RADIUS); x <= Math.min(g.W - 1, tx + CONFIG.DEFENSE_RADIUS); x++) {
      const i = idx(x, y, g.W);
      if (g.owner[i] === defenderId && g.building[i] === BUILDING.DEFENSE) {
        if (dist2(x, y, tx, ty) <= CONFIG.DEFENSE_RADIUS * CONFIG.DEFENSE_RADIUS) levels += g.bLevel[i];
      }
    }
  }
  return 1 + CONFIG.DEFENSE_BONUS_PER_LEVEL * levels;
}

function resolveAttackOnTile(g, attackerId, targetTile, dtSec) {
  if (targetTile < 0 || targetTile >= g.len) return;
  const defenderId = g.owner[targetTile];
  if (defenderId === 0 || defenderId === attackerId) return;
  if (!hasOwnedNeighbor(g, targetTile, attackerId)) return;

  const attacker = g.factions[attackerId];
  const defender = g.factions[defenderId];
  if (!attacker || !defender) return;

  const attackerTroops = attacker.popCurrent * (1 - attacker.workerPct);
  const defenderTroops = defender.popCurrent * (1 - defender.workerPct);
  const defenseDensity = defenderTroops / Math.max(1, defender.tilesOwnedLand);
  const terrainMul = g.terrain[targetTile] === TERRAIN.MOUNTAIN ? 1.35 : 1.0;
  const localMul = localDefenseMultiplier(g, targetTile, defenderId);

  const atkTroops = attackerTroops * attacker.attackRatio;
  const atkPower = atkTroops * 0.020;
  const defPowerBase = defenseDensity * 55.0;
  const defPower = defPowerBase * terrainMul * localMul;

  const net = atkPower - defPower;
  if (net >= 0) g.combatProg[targetTile] += net * 0.0012;
  else g.combatProg[targetTile] += net * 0.00035;
  g.combatProg[targetTile] = clamp(g.combatProg[targetTile], 0, 1);

  attacker.popCurrent = Math.max(0, attacker.popCurrent - atkTroops * 0.006 * dtSec);
  const frac = atkPower / Math.max(0.0001, atkPower + defPower);
  defender.popCurrent = Math.max(0, defender.popCurrent - Math.max(0, frac) * defPower * 0.0008 * dtSec);

  if (g.combatProg[targetTile] >= 1) {
    captureTile(g, targetTile, attackerId, defenderId);
  }
}

function captureTile(g, tile, newOwner, oldOwner) {
  g.owner[tile] = newOwner;
  g.combatProg[tile] = 0;
  if (oldOwner > 0 && g.factions[oldOwner]) g.recentTileLoss[oldOwner] += 1;
  recalcTileCounts(g);
  checkEnclosureAnnex(g, tile, oldOwner, newOwner);
}

function checkEnclosureAnnex(g, capturedTile, defenderId, capturerId) {
  if (defenderId <= 0) return;
  const cx = capturedTile % g.W, cy = (capturedTile / g.W) | 0;
  const starts = [];
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
    const ni = idx(nx, ny, g.W);
    if (g.owner[ni] === defenderId && g.terrain[ni] !== TERRAIN.WATER) starts.push(ni);
  }
  const seen = new Uint8Array(g.len);
  for (const st of starts) {
    if (seen[st]) continue;
    const q = [st];
    const region = [];
    let touchEdge = false;
    while (q.length) {
      const cur = q.pop();
      if (seen[cur]) continue;
      seen[cur] = 1;
      if (g.owner[cur] !== defenderId || g.terrain[cur] === TERRAIN.WATER) continue;
      region.push(cur);
      const x = cur % g.W, y = (cur / g.W) | 0;
      if (x === 0 || y === 0 || x === g.W - 1 || y === g.H - 1) touchEdge = true;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
        const ni = idx(nx, ny, g.W);
        if (!seen[ni]) q.push(ni);
      }
    }
    if (!touchEdge && region.length) {
      for (const r of region) g.owner[r] = capturerId;
      g.annexFlashes.push({ tiles: region, ttl: 0.6 });
      beep(780, 0.08);
      recalcTileCounts(g);
    }
  }
}

let audioCtx;
function beep(freq, dur) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.value = 0.02;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (_) {}
}

function updateBots(g, dt) {
  for (let i = 2; i < g.factions.length; i++) {
    const b = g.factions[i];
    if (!b || b.tilesOwnedLand === 0) continue;
    b.thinkTimer -= dt;
    if (b.thinkTimer <= 0) {
      b.thinkTimer = b.thinkInterval;
      botThink(g, b);
    }
    if (b.currentBurst > 0) {
      b.currentBurst -= dt;
      const t = g.botAttacks.get(i);
      if (t != null) resolveAttackOnTile(g, i, t, dt);
    }
  }
}

function botThink(g, bot) {
  const lowPop = bot.popCurrent < 0.25 * bot.popCap;
  maybeBotBuild(g, bot, lowPop);
  if (tryBotExpand(g, bot)) return;
  if (lowPop) { bot.currentBurst = 0; g.botAttacks.delete(bot.id); return; }

  let bestTile = -1, bestScore = -1e9;
  for (let i = 0; i < g.len; i++) {
    if (g.owner[i] === bot.id || g.terrain[i] === TERRAIN.WATER) continue;
    if (!hasOwnedNeighbor(g, i, bot.id)) continue;
    if (g.owner[i] === 0) continue;
    const enemyId = g.owner[i];
    const enemy = g.factions[enemyId];
    const enemyTroops = enemy.popCurrent * (1 - enemy.workerPct);
    const weaknessScore = 1000 / Math.max(20, enemyTroops / Math.max(1, enemy.tilesOwnedLand));
    const enclosureScore = estimateEnclosureScore(g, i, enemyId);
    const proximityScore = 6;
    const terrainPenalty = g.terrain[i] === TERRAIN.MOUNTAIN ? 18 : 0;
    const defensePenalty = (localDefenseMultiplier(g, i, enemyId) - 1) * 40;
    const score = weaknessScore + enclosureScore + proximityScore - terrainPenalty - defensePenalty;
    if (score > bestScore) { bestScore = score; bestTile = i; }
  }

  if (bestTile >= 0) {
    g.botAttacks.set(bot.id, bestTile);
    bot.currentBurst = CONFIG.BOT_BURST_SEC;
  }
}

function estimateEnclosureScore(g, tile, enemyId) {
  const x = tile % g.W, y = (tile / g.W) | 0;
  let enemyBehind = 0;
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = x + dx * 2, ny = y + dy * 2;
    if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
    if (g.owner[idx(nx, ny, g.W)] === enemyId) enemyBehind++;
  }
  return enemyBehind * 12;
}

function maybeBotBuild(g, bot, lowPop) {
  if (bot.popCurrent > 0.92 * bot.popCap) {
    const t = findInteriorTile(g, bot.id);
    if (t >= 0) tryBuild(g, bot.id, t, BUILDING.CITY);
  }
  if (g.recentTileLoss[bot.id] > 1.2 || hasActiveBorderConflict(g, bot.id) || lowPop) {
    const t = findBorderTile(g, bot.id);
    if (t >= 0) tryBuild(g, bot.id, t, BUILDING.DEFENSE);
  }
}

function hasActiveBorderConflict(g, id) {
  for (let i = 0; i < g.len; i++) {
    if (g.owner[i] !== id) continue;
    const x = i % g.W, y = (i / g.W) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
      const o = g.owner[idx(nx, ny, g.W)];
      if (o > 0 && o !== id) return true;
    }
  }
  return false;
}

function tryBotExpand(g, bot) {
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < g.len; i++) {
    if (g.owner[i] !== 0 || g.terrain[i] === TERRAIN.WATER) continue;
    if (!hasOwnedNeighbor(g, i, bot.id)) continue;
    const s = g.terrain[i] === TERRAIN.PLAINS ? 2 : 1;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best >= 0) {
    g.owner[best] = bot.id;
    bot.popCurrent = Math.max(0, bot.popCurrent - 3);
    recalcTileCounts(g);
    return true;
  }
  return false;
}

function findInteriorTile(g, factionId) {
  for (let i = 0; i < g.len; i++) {
    if (g.owner[i] !== factionId || g.terrain[i] === TERRAIN.WATER) continue;
    if (!isBorderTile(g, i, factionId)) return i;
  }
  return -1;
}
function findBorderTile(g, factionId) {
  for (let i = 0; i < g.len; i++) if (g.owner[i] === factionId && isBorderTile(g, i, factionId)) return i;
  return -1;
}
function isBorderTile(g, tile, id) {
  const x = tile % g.W, y = (tile / g.W) | 0;
  for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) return true;
    const o = g.owner[idx(nx, ny, g.W)];
    if (o !== id) return true;
  }
  return false;
}

function buildingCost(type, level) {
  if (type === BUILDING.CITY) return Math.round(CONFIG.CITY_BASE_COST * (1.7 ** level));
  return Math.round(CONFIG.DEF_BASE_COST * (1.6 ** level));
}

function tryBuild(g, factionId, tile, type) {
  if (g.terrain[tile] === TERRAIN.WATER || g.owner[tile] !== factionId) return false;
  const faction = g.factions[factionId];
  if (g.building[tile] === BUILDING.NONE) {
    const cost = buildingCost(type, 0);
    if (faction.gold < cost) return false;
    faction.gold -= cost;
    g.building[tile] = type;
    g.bLevel[tile] = 1;
    recalcPopCap(g, factionId);
    return true;
  }
  if (g.building[tile] !== type) return false;
  const level = g.bLevel[tile];
  const cost = buildingCost(type, level);
  if (faction.gold < cost) return false;
  faction.gold -= cost;
  g.bLevel[tile]++;
  recalcPopCap(g, factionId);
  return true;
}

function worldToScreen(g, wx, wy) {
  return {
    x: (wx - g.camX) * g.zoom + ui.canvas.width * 0.5,
    y: (wy - g.camY) * g.zoom + ui.canvas.height * 0.5
  };
}
function screenToWorld(g, sx, sy) {
  return {
    x: (sx - ui.canvas.width * 0.5) / g.zoom + g.camX,
    y: (sy - ui.canvas.height * 0.5) / g.zoom + g.camY
  };
}
function screenToTile(g, sx, sy) {
  const w = screenToWorld(g, sx, sy);
  const x = Math.floor(w.x), y = Math.floor(w.y);
  if (x < 0 || y < 0 || x >= g.W || y >= g.H) return -1;
  return idx(x, y, g.W);
}

function drawGame(g, dt) {
  const colors = factionColors(g.factions.length);
  for (let i = 0; i < g.len; i++) {
    let c;
    if (g.terrain[i] === TERRAIN.WATER) c = [28, 52, 102];
    else if (g.owner[i] === 0) c = [88, 105, 90];
    else c = colors[g.owner[i] % colors.length];
    if (g.terrain[i] === TERRAIN.MOUNTAIN) c = c.map(v => (v * 0.72) | 0);
    const p = i * 4;
    imageBuf[p] = c[0]; imageBuf[p + 1] = c[1]; imageBuf[p + 2] = c[2]; imageBuf[p + 3] = 255;
  }

  offctx.putImageData(imageData, 0, 0);
  ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
  ctx.save();
  ctx.translate(ui.canvas.width / 2, ui.canvas.height / 2);
  ctx.scale(g.zoom, g.zoom);
  ctx.translate(-g.camX, -g.camY);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, 0, 0);

  ctx.strokeStyle = 'rgba(16,16,24,0.65)';
  ctx.lineWidth = Math.max(0.03, 1 / g.zoom);
  ctx.beginPath();
  for (let y = 0; y < g.H; y++) {
    for (let x = 0; x < g.W; x++) {
      const i = idx(x, y, g.W);
      const o = g.owner[i];
      if (x + 1 < g.W && g.owner[idx(x + 1, y, g.W)] !== o) { ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + 1); }
      if (y + 1 < g.H && g.owner[idx(x, y + 1, g.W)] !== o) { ctx.moveTo(x, y + 1); ctx.lineTo(x + 1, y + 1); }
    }
  }
  ctx.stroke();

  for (const f of g.annexFlashes) {
    f.ttl -= dt;
    const alpha = clamp(f.ttl / 0.6, 0, 1);
    ctx.fillStyle = `rgba(255,255,180,${0.35 * alpha})`;
    for (const t of f.tiles) {
      const x = t % g.W, y = (t / g.W) | 0;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  g.annexFlashes = g.annexFlashes.filter(f => f.ttl > 0);

  for (let i = 0; i < g.len; i++) {
    if (g.combatProg[i] <= 0.01) continue;
    const x = i % g.W, y = (i / g.W) | 0;
    ctx.fillStyle = `rgba(255,70,70,${g.combatProg[i] * 0.7})`;
    ctx.fillRect(x, y, 1, 1);
  }

  for (let i = 0; i < g.len; i++) {
    if (g.building[i] === BUILDING.NONE || g.owner[i] === 0) continue;
    const x = i % g.W, y = (i / g.W) | 0;
    ctx.fillStyle = g.building[i] === BUILDING.CITY ? '#f5dc79' : '#7fd7ff';
    ctx.fillRect(x + 0.25, y + 0.25, 0.5, 0.5);
  }

  ctx.restore();
}

function factionColors(n) {
  const arr = [[0,0,0],[78,220,104],[235,92,92],[241,145,58],[128,110,244],[60,195,224],[223,89,184],[193,225,89]];
  while (arr.length <= n + 2) arr.push([rand(80,245)|0, rand(80,245)|0, rand(80,245)|0]);
  return arr;
}

function updateHUD(g) {
  const p = g.factions[1];
  const workers = p.popCurrent * p.workerPct;
  const troops = p.popCurrent * (1 - p.workerPct);
  const landPct = p.tilesOwnedLand / Math.max(1, g.totalLand) * 100;
  ui.stats.textContent = `Gold ${Math.floor(p.gold)} | Pop ${Math.floor(p.popCurrent)} / ${Math.floor(p.popCap)} | Land ${landPct.toFixed(1)}% | Troops ${Math.floor(troops)} | Workers ${Math.floor(workers)}`;
  ui.buildModeLabel.textContent = `Build: ${g.buildMode}`;

  const t = g.hoverTile;
  if (t >= 0) {
    const terr = ['Water', 'Plains', 'Mountain'][g.terrain[t]];
    const o = g.owner[t] === 0 ? 'Neutral' : (g.owner[t] === 1 ? 'Player' : `Bot ${g.owner[t] - 1}`);
    const b = g.building[t] === 0 ? 'None' : (g.building[t] === 1 ? `City L${g.bLevel[t]}` : `Defense L${g.bLevel[t]}`);
    ui.tooltip.textContent = `Tile: ${terr} | Owner: ${o} | Building: ${b}`;
  } else ui.tooltip.textContent = 'Tile: -';
}

function checkEnd(g) {
  const p = g.factions[1];
  const landPct = p.tilesOwnedLand / Math.max(1, g.totalLand);
  if (landPct >= CONFIG.WIN_LAND_PCT) return finishGame(g, true);
  if (p.tilesOwnedLand <= 0) return finishGame(g, false);
}

function finishGame(g, won) {
  if (g.ended) return;
  g.ended = true;
  g.running = false;
  const elapsed = ((performance.now() - g.startTime) / 1000) | 0;
  const p = g.factions[1];
  let botsDefeated = 0, largestEnemy = 0;
  for (let i = 2; i < g.factions.length; i++) {
    const t = g.factions[i].tilesOwnedLand;
    if (t === 0) botsDefeated++;
    largestEnemy = Math.max(largestEnemy, t);
  }
  ui.endTitle.textContent = won ? 'Victory!' : 'Defeat';
  ui.endStats.textContent = `Time ${elapsed}s | Final Land ${(p.tilesOwnedLand / g.totalLand * 100).toFixed(1)}% | Bots Defeated ${botsDefeated} | Largest Enemy ${largestEnemy} tiles`;
  ui.end.classList.remove('hidden');
}

function tick(g, dt) {
  updateEconomy(g, dt);
  if (g.playerAttack.active) resolveAttackOnTile(g, 1, g.playerAttack.target, dt);
  updateBots(g, dt);
  checkEnd(g);
}

function loop(ts) {
  if (!game) return requestAnimationFrame(loop);
  const dtFrame = Math.min(0.25, (ts - game.lastTs) / 1000);
  game.lastTs = ts;
  if (!game.paused && game.running) {
    game.simAccum += dtFrame * game.speed;
    const step = 1 / CONFIG.TICK_HZ;
    while (game.simAccum >= step) {
      tick(game, step);
      game.simAccum -= step;
    }
  }
  drawGame(game, dtFrame);
  updateHUD(game);
  requestAnimationFrame(loop);
}

function startMatch() {
  const [W, H] = ui.mapSize.value.split('x').map(Number);
  const botCount = +ui.botCount.value;
  const diff = ui.difficulty.value;
  game = createGame(W, H, botCount, diff);
  ui.menu.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.end.classList.add('hidden');
}

ui.botCount.addEventListener('input', () => ui.botCountLabel.textContent = ui.botCount.value);
ui.workersPct.addEventListener('input', () => {
  ui.workersPctLabel.textContent = ui.workersPct.value;
  if (game) game.factions[1].workerPct = +ui.workersPct.value / 100;
});
ui.attackRatio.addEventListener('input', () => {
  ui.attackRatioLabel.textContent = ui.attackRatio.value;
  if (game) game.factions[1].attackRatio = +ui.attackRatio.value / 100;
});
ui.startBtn.addEventListener('click', startMatch);
ui.pauseBtn.addEventListener('click', () => { if (game) { game.paused = !game.paused; ui.pauseBtn.textContent = game.paused ? 'Resume' : 'Pause'; } });
ui.speedBtn.addEventListener('click', () => { if (game) { game.speed = game.speed === 1 ? 2 : 1; ui.speedBtn.textContent = `Speed: ${game.speed}x`; } });
ui.restartBtn.addEventListener('click', () => { if (game) startMatch(); });
ui.playAgainBtn.addEventListener('click', () => { ui.menu.classList.remove('hidden'); ui.hud.classList.add('hidden'); ui.end.classList.add('hidden'); game = null; });
ui.buildCityBtn.addEventListener('click', () => { if (game) game.buildMode = 'city'; });
ui.buildDefenseBtn.addEventListener('click', () => { if (game) game.buildMode = 'defense'; });
ui.cancelBuildBtn.addEventListener('click', () => { if (game) game.buildMode = 'none'; });

ui.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
ui.canvas.addEventListener('mousedown', (e) => {
  if (!game || !game.running) return;
  if (e.button === 1 || e.button === 2) {
    game.dragging = true;
    game.dragLastX = e.clientX; game.dragLastY = e.clientY;
    return;
  }
  if (e.button !== 0) return;
  const t = screenToTile(game, e.clientX, e.clientY);
  if (t < 0) return;

  if (game.buildMode !== 'none') {
    const type = game.buildMode === 'city' ? BUILDING.CITY : BUILDING.DEFENSE;
    tryBuild(game, 1, t, type);
    return;
  }

  if (game.owner[t] > 1 && game.terrain[t] !== TERRAIN.WATER && hasOwnedNeighbor(game, t, 1)) {
    game.playerAttack.active = true;
    game.playerAttack.target = t;
    game.playerAttack.mouseDown = true;
  }
});
ui.canvas.addEventListener('mouseup', (e) => {
  if (!game) return;
  if (e.button === 1 || e.button === 2) game.dragging = false;
  if (e.button === 0) game.playerAttack.mouseDown = false;
});
ui.canvas.addEventListener('mousemove', (e) => {
  if (!game) return;
  game.hoverTile = screenToTile(game, e.clientX, e.clientY);
  if (game.dragging) {
    const dx = e.clientX - game.dragLastX;
    const dy = e.clientY - game.dragLastY;
    game.camX -= dx / game.zoom;
    game.camY -= dy / game.zoom;
    game.dragLastX = e.clientX;
    game.dragLastY = e.clientY;
  }
  if (game.playerAttack.active && game.playerAttack.mouseDown) {
    const t = screenToTile(game, e.clientX, e.clientY);
    if (t >= 0 && game.owner[t] > 1 && hasOwnedNeighbor(game, t, 1)) game.playerAttack.target = t;
  }
});
ui.canvas.addEventListener('wheel', (e) => {
  if (!game) return;
  e.preventDefault();
  const before = screenToWorld(game, e.clientX, e.clientY);
  game.zoom = clamp(game.zoom * (e.deltaY < 0 ? 1.1 : 0.9), 1.2, 25);
  const after = screenToWorld(game, e.clientX, e.clientY);
  game.camX += before.x - after.x;
  game.camY += before.y - after.y;
}, { passive: false });

requestAnimationFrame(loop);
