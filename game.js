/*
Typed arrays per tile index i = y*W + x:
terrain: 0 water, 1 plains, 2 mountain | owner: 0 neutral, 1 player, 2..n bots
building: 0 none, 1 city, 2 defense | bLevel: building level | combatProg: attack progress for attacked tiles
Main loop: fixed timestep simulation at TICK_HZ + requestAnimationFrame render.
*/

const CONFIG = {
  TICK_HZ: 20,
  BASE_POP_CAP: 8000,
  POP_CAP_PER_LAND_TILE: 30,
  CITY_POP_CAP_BONUS_PER_LEVEL: 25000,
  START_POP_CURRENT: 6500,
  START_GOLD: 2000,
  GOLD_PER_WORKER_PER_SEC: 0.015,
  DEFENSE_RADIUS: 4,
  DEFENSE_POST_BONUS_PER_LEVEL: 0.12,
  ATTACK_POWER_MULT: 0.020,
  DEFENSE_DENSITY_MULT: 55.0,
  NET_CAPTURE_GAIN: 0.0012,
  NET_DECAY_GAIN: 0.00035,
  WIN_LAND_PCT: 0.72,
  CITY_BASE_COST: 2500,
  CITY_COST_SCALE: 1.7,
  DEFENSE_BASE_COST: 1800,
  DEFENSE_COST_SCALE: 1.6,
  PLAYER_COLOR: '#4ade80',
  WATER_COLOR: '#1e3a8a',
  NEUTRAL_COLOR: '#5f6f63',
  MOUNTAIN_SHADE: 0.78,
  STARTING_BLOB_SIZE: 40,
  STARTING_DISTANCE_MEDIUM: 25,
  BOT_BURST_SEC: 1.5,
};

const BOT_PRESETS = {
  easy: { THINK_INTERVAL_SEC: 1.5, ECON_MULT: 0.9, TARGET_WORKER_PCT: 0.65, TARGET_ATTACK_RATIO: 0.16 },
  normal: { THINK_INTERVAL_SEC: 1.0, ECON_MULT: 1.0, TARGET_WORKER_PCT: 0.60, TARGET_ATTACK_RATIO: 0.20 },
  hard: { THINK_INTERVAL_SEC: 0.6, ECON_MULT: 1.1, TARGET_WORKER_PCT: 0.55, TARGET_ATTACK_RATIO: 0.24 },
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

const menuOverlay = document.getElementById('menuOverlay');
const endOverlay = document.getElementById('endOverlay');
const hud = document.getElementById('hud');

const mapSizeSelect = document.getElementById('mapSizeSelect');
const botCountSlider = document.getElementById('botCountSlider');
const botCountValue = document.getElementById('botCountValue');
const difficultySelect = document.getElementById('difficultySelect');

const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const speedBtn = document.getElementById('speedBtn');
const restartBtn = document.getElementById('restartBtn');
const endRestartBtn = document.getElementById('endRestartBtn');

const workerSlider = document.getElementById('workerSlider');
const attackSlider = document.getElementById('attackSlider');
const workerValue = document.getElementById('workerValue');
const attackValue = document.getElementById('attackValue');

const buildCityBtn = document.getElementById('buildCityBtn');
const buildDefenseBtn = document.getElementById('buildDefenseBtn');
const cancelBuildBtn = document.getElementById('cancelBuildBtn');
const buildModeText = document.getElementById('buildModeText');
const tooltipText = document.getElementById('tooltipText');

const goldText = document.getElementById('goldText');
const popText = document.getElementById('popText');
const landText = document.getElementById('landText');
const troopsText = document.getElementById('troopsText');
const workersText = document.getElementById('workersText');
const endTitle = document.getElementById('endTitle');
const endStats = document.getElementById('endStats');

let W = 384, H = 216, N = W * H;
let terrain, owner, building, bLevel, combatProg;
let mapImageData;

let gameRunning = false;
let paused = false;
let simSpeed = 1;
let lastTs = 0;
let acc = 0;
let tickDt = 1 / CONFIG.TICK_HZ;
let elapsedSec = 0;
let hudTimer = 0;

let factions = [];
let player = null;
let bots = [];
let totalLandTiles = 0;
let botCount = 20;
let difficulty = 'normal';

let camera = { zoom: 4, minZoom: 1.5, maxZoom: 10, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
let mouse = { sx: 0, sy: 0, tx: -1, ty: -1, index: -1, down: false };
let buildMode = 0; // 0 none, 1 city, 2 defense
let playerAttackTarget = -1;
let annexFlashes = [];
let audioCtx = null;

const botState = new Map();

const botColors = ['#ef4444','#f59e0b','#06b6d4','#a78bfa','#fb7185','#22c55e','#f97316','#84cc16','#14b8a6','#8b5cf6'];

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

botCountSlider.addEventListener('input', () => botCountValue.textContent = botCountSlider.value);
workerSlider.addEventListener('input', () => {
  workerValue.textContent = `${workerSlider.value}%`;
  if (player) player.workerPct = +workerSlider.value / 100;
});
attackSlider.addEventListener('input', () => {
  attackValue.textContent = `${attackSlider.value}%`;
  if (player) player.attackRatio = +attackSlider.value / 100;
});

startBtn.onclick = () => startNewGame();
restartBtn.onclick = () => startNewGame();
endRestartBtn.onclick = () => { endOverlay.classList.add('hidden'); startNewGame(); };
pauseBtn.onclick = () => { paused = !paused; pauseBtn.textContent = paused ? 'Resume' : 'Pause'; };
speedBtn.onclick = () => { simSpeed = simSpeed === 1 ? 2 : 1; speedBtn.textContent = `Speed ${simSpeed}x`; };

buildCityBtn.onclick = () => setBuildMode(1);
buildDefenseBtn.onclick = () => setBuildMode(2);
cancelBuildBtn.onclick = () => setBuildMode(0);

canvas.addEventListener('mousedown', (e) => {
  mouse.down = true;
  if (e.button === 1 || e.button === 2) {
    camera.dragging = true;
    camera.lastX = e.clientX;
    camera.lastY = e.clientY;
  } else if (e.button === 0) {
    handlePrimaryClick();
  }
});
canvas.addEventListener('mouseup', () => { mouse.down = false; camera.dragging = false; playerAttackTarget = -1; });
canvas.addEventListener('mouseleave', () => { mouse.down = false; camera.dragging = false; playerAttackTarget = -1; });
canvas.addEventListener('mousemove', (e) => {
  mouse.sx = e.clientX;
  mouse.sy = e.clientY;
  updateMouseTile();
  if (camera.dragging) {
    const dx = e.clientX - camera.lastX;
    const dy = e.clientY - camera.lastY;
    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
    camera.lastX = e.clientX;
    camera.lastY = e.clientY;
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = screenToWorld(e.clientX, e.clientY);
  const zMul = e.deltaY < 0 ? 1.12 : 0.9;
  camera.zoom = clamp(camera.zoom * zMul, camera.minZoom, camera.maxZoom);
  const after = screenToWorld(e.clientX, e.clientY);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
}, { passive: false });
canvas.oncontextmenu = (e) => e.preventDefault();

function setBuildMode(mode) {
  buildMode = mode;
  buildModeText.textContent = `Build Mode: ${mode === 1 ? 'City' : mode === 2 ? 'Defense' : 'none'}`;
}

function startNewGame() {
  const [w, h] = mapSizeSelect.value.split('x').map(Number);
  W = w; H = h; N = W * H;
  botCount = +botCountSlider.value;
  difficulty = difficultySelect.value;
  terrain = new Uint8Array(N);
  owner = new Uint16Array(N);
  building = new Uint8Array(N);
  bLevel = new Uint8Array(N);
  combatProg = new Float32Array(N);
  mapImageData = ctx.createImageData(W, H);
  elapsedSec = 0;
  hudTimer = 0;
  paused = false;
  simSpeed = 1;
  pauseBtn.textContent = 'Pause';
  speedBtn.textContent = 'Speed 1x';
  setBuildMode(0);

  generateMap();
  initFactions(botCount);
  spawnFactions();
  recalcAllLandCounts();
  recalcAllPopCaps();

  camera.zoom = clamp(Math.min(canvas.width / W, canvas.height / H) * 0.95, 1.5, 8);
  camera.x = W / 2 - canvas.width / (2 * camera.zoom);
  camera.y = H / 2 - canvas.height / (2 * camera.zoom);

  menuOverlay.classList.remove('visible');
  menuOverlay.classList.add('hidden');
  hud.classList.remove('hidden');
  endOverlay.classList.add('hidden');
  gameRunning = true;
  lastTs = performance.now();
}

function initFactions(botCountNum) {
  factions = [];
  player = makeFaction(1, 'Player', CONFIG.PLAYER_COLOR, true, BOT_PRESETS[difficulty]);
  factions.push(player);
  bots = [];
  for (let i = 0; i < botCountNum; i++) {
    const id = i + 2;
    const c = botColors[i % botColors.length];
    const f = makeFaction(id, `Bot ${i + 1}`, c, false, BOT_PRESETS[difficulty]);
    factions.push(f);
    bots.push(f);
  }
  botState.clear();
  for (const b of bots) {
    botState.set(b.id, { thinkTimer: 0, target: -1, burstLeft: 0, lostTilesRecent: 0 });
  }
  player.workerPct = +workerSlider.value / 100;
  player.attackRatio = +attackSlider.value / 100;
}

function makeFaction(id, name, color, isPlayer, preset) {
  return {
    id, name, color, isPlayer,
    gold: CONFIG.START_GOLD,
    popCurrent: CONFIG.START_POP_CURRENT,
    popCap: CONFIG.BASE_POP_CAP,
    workerPct: isPlayer ? 0.6 : preset.TARGET_WORKER_PCT,
    attackRatio: isPlayer ? 0.2 : preset.TARGET_ATTACK_RATIO,
    tilesOwnedLand: 0,
    cityLevels: 0,
    defeated: false,
  };
}

function generateMap() {
  const noise = new Float32Array(N);
  const seeds = 18;
  for (let s = 0; s < seeds; s++) {
    const cx = randInt(0, W - 1), cy = randInt(0, H - 1);
    const radius = randInt(Math.floor(Math.min(W, H) * 0.12), Math.floor(Math.min(W, H) * 0.28));
    const r2 = radius * radius;
    const minX = Math.max(0, cx - radius), maxX = Math.min(W - 1, cx + radius);
    const minY = Math.max(0, cy - radius), maxY = Math.min(H - 1, cy + radius);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) noise[idx(x, y)] += (1 - d2 / r2) * (0.9 + Math.random() * 0.6);
      }
    }
  }
  const edgeFalloff = 0.7;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = x / W * 2 - 1, ny = y / H * 2 - 1;
      noise[idx(x, y)] -= (nx * nx + ny * ny) * edgeFalloff;
    }
  }

  const sorted = Array.from(noise).sort((a, b) => a - b);
  const landTarget = randInt(Math.floor(N * 0.25), Math.floor(N * 0.4));
  const threshold = sorted[N - landTarget];
  totalLandTiles = 0;
  for (let i = 0; i < N; i++) {
    terrain[i] = noise[i] >= threshold ? 1 : 0;
    if (terrain[i] !== 0) totalLandTiles++;
    owner[i] = 0;
    building[i] = 0;
    bLevel[i] = 0;
    combatProg[i] = 0;
  }
  placeMountains();
}

function placeMountains() {
  const landIndices = [];
  for (let i = 0; i < N; i++) if (terrain[i] === 1) landIndices.push(i);
  let target = Math.floor(landIndices.length * (0.08 + Math.random() * 0.07));
  const attempts = Math.max(4, Math.floor(target / 25));
  for (let a = 0; a < attempts; a++) {
    if (target <= 0) break;
    const seedI = landIndices[randInt(0, landIndices.length - 1)];
    const sx = seedI % W, sy = Math.floor(seedI / W);
    const rad = randInt(3, 8);
    for (let y = sy - rad; y <= sy + rad; y++) {
      for (let x = sx - rad; x <= sx + rad; x++) {
        if (!inside(x, y) || target <= 0) continue;
        const i = idx(x, y);
        if (terrain[i] !== 1) continue;
        const d = Math.hypot(x - sx, y - sy);
        if (d <= rad && Math.random() < 0.65 - d * 0.07) {
          terrain[i] = 2;
          target--;
        }
      }
    }
  }
}

function spawnFactions() {
  const minDist = Math.max(14, Math.floor(CONFIG.STARTING_DISTANCE_MEDIUM * (W / 384)));
  const seeds = [];
  const needed = factions.length;
  let tries = 0;
  while (seeds.length < needed && tries < 60000) {
    tries++;
    const x = randInt(4, W - 5), y = randInt(4, H - 5);
    const i = idx(x, y);
    if (terrain[i] === 0) continue;
    let ok = true;
    for (const s of seeds) {
      if (Math.hypot(x - s.x, y - s.y) < minDist) { ok = false; break; }
    }
    if (ok) seeds.push({ x, y });
  }
  if (seeds.length < needed) return;
  for (let f = 0; f < factions.length; f++) {
    seedBlob(seeds[f].x, seeds[f].y, factions[f].id, CONFIG.STARTING_BLOB_SIZE);
  }
}

function seedBlob(sx, sy, factionId, tilesTarget) {
  const q = [{ x: sx, y: sy }];
  const seen = new Uint8Array(N);
  let placed = 0;
  while (q.length && placed < tilesTarget) {
    const n = q.shift();
    const i = idx(n.x, n.y);
    if (seen[i]) continue;
    seen[i] = 1;
    if (terrain[i] !== 0 && owner[i] === 0) {
      owner[i] = factionId;
      placed++;
    }
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx,dy] of dirs) {
      const nx = n.x + dx, ny = n.y + dy;
      if (!inside(nx, ny)) continue;
      if (!seen[idx(nx, ny)]) q.push({ x: nx, y: ny });
    }
  }
}

function gameLoop(ts) {
  if (!gameRunning) return requestAnimationFrame(gameLoop);
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (!paused) {
    acc += dt * simSpeed;
    while (acc >= tickDt) {
      simulateTick(tickDt);
      acc -= tickDt;
      elapsedSec += tickDt;
      hudTimer += tickDt;
    }
  }
  render();
  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);

function simulateTick(dtSec) {
  for (const f of factions) {
    if (f.defeated) continue;
    applyEconomy(f, dtSec);
  }

  if (playerAttackTarget !== -1 && mouse.down) processAttack(player.id, playerAttackTarget, dtSec);
  for (const b of bots) botThinkAndAct(b, dtSec);

  for (const f of factions) {
    if (!f.defeated && f.tilesOwnedLand === 0) f.defeated = true;
  }

  if (hudTimer >= 0.2) {
    updateHUD();
    hudTimer = 0;
  }
  if (!endOverlay.classList.contains('hidden')) return;
  checkEndConditions();
}

function applyEconomy(f, dtSec) {
  const workers = f.popCurrent * f.workerPct;
  const econMult = f.isPlayer ? 1 : BOT_PRESETS[difficulty].ECON_MULT;
  f.gold += workers * CONFIG.GOLD_PER_WORKER_PER_SEC * econMult * dtSec;
  const ratio = f.popCap > 0 ? f.popCurrent / f.popCap : 0;
  const growthRate = popGrowthRate(ratio);
  f.popCurrent = clamp(f.popCurrent + f.popCurrent * growthRate * dtSec, 0, f.popCap);
}

function popGrowthRate(ratio) {
  const clamped = clamp(ratio, 0, 1);
  const peak = Math.exp(-Math.pow((clamped - 0.45) / 0.28, 2)) * 0.06;
  const lowBoost = 0.02 * clamped * (1 - clamped);
  const floor = 0.002 + 0.004 * (1 - clamped);
  return Math.max(floor, peak + lowBoost);
}

function processAttack(attackerId, targetI, dtSec) {
  if (targetI < 0 || targetI >= N || terrain[targetI] === 0) return;
  const defenderId = owner[targetI];
  if (defenderId === attackerId || defenderId === 0) return;
  if (!isAdjacentOwnedBy(targetI, attackerId)) {
    if (attackerId === player.id) playerAttackTarget = -1;
    return;
  }
  const attacker = factions[attackerId - 1];
  const defender = factions[defenderId - 1];
  if (!attacker || !defender) return;

  const attackerTroops = attacker.popCurrent * (1 - attacker.workerPct);
  const atkTroops = attackerTroops * attacker.attackRatio;
  const atkPower = atkTroops * CONFIG.ATTACK_POWER_MULT;

  const defenderTroops = defender.popCurrent * (1 - defender.workerPct);
  const defenseDensity = defenderTroops / Math.max(1, defender.tilesOwnedLand);
  const terrainMult = terrain[targetI] === 2 ? 1.35 : 1.0;
  const localDefense = 1 + CONFIG.DEFENSE_POST_BONUS_PER_LEVEL * getDefenseLevelsInRadius(targetI, defenderId, CONFIG.DEFENSE_RADIUS);
  const defPower = defenseDensity * CONFIG.DEFENSE_DENSITY_MULT * terrainMult * localDefense;

  const net = atkPower - defPower;
  let prog = combatProg[targetI];
  prog += net >= 0 ? net * CONFIG.NET_CAPTURE_GAIN : net * CONFIG.NET_DECAY_GAIN;
  combatProg[targetI] = clamp(prog, 0, 1);

  attacker.popCurrent = Math.max(0, attacker.popCurrent - atkTroops * 0.006 * dtSec);
  const ratio = atkPower / Math.max(1e-6, atkPower + defPower);
  defender.popCurrent = Math.max(0, defender.popCurrent - Math.max(0, ratio) * defPower * 0.0008 * dtSec);

  if (combatProg[targetI] >= 1) {
    captureTile(targetI, attackerId, defenderId);
    combatProg[targetI] = 0;
    if (attackerId === player.id && owner[targetI] !== defenderId) playerAttackTarget = -1;
  }
}

function captureTile(i, attackerId, defenderId) {
  owner[i] = attackerId;
  if (building[i] !== 0) {
    building[i] = 0;
    bLevel[i] = 0;
  }
  const st = botState.get(defenderId);
  if (st) st.lostTilesRecent += 1;
  recalcAllLandCounts();
  recalcAllPopCaps();
  checkAnnexationNearCapture(i, defenderId, attackerId);
}

function getDefenseLevelsInRadius(centerI, factionId, radius) {
  const cx = centerI % W, cy = Math.floor(centerI / W);
  let sum = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(H - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(W - 1, cx + radius); x++) {
      const i = idx(x, y);
      if (owner[i] === factionId && building[i] === 2) {
        if (Math.abs(x - cx) + Math.abs(y - cy) <= radius) sum += bLevel[i];
      }
    }
  }
  return sum;
}

function botThinkAndAct(bot, dtSec) {
  const s = botState.get(bot.id);
  if (!s) return;
  s.thinkTimer += dtSec;
  if (s.burstLeft > 0 && s.target !== -1) {
    processAttack(bot.id, s.target, dtSec);
    s.burstLeft -= dtSec;
    return;
  }
  s.target = -1;

  if (s.thinkTimer < BOT_PRESETS[difficulty].THINK_INTERVAL_SEC) return;
  s.thinkTimer = 0;

  bot.workerPct += (BOT_PRESETS[difficulty].TARGET_WORKER_PCT - bot.workerPct) * 0.3;
  bot.attackRatio += (BOT_PRESETS[difficulty].TARGET_ATTACK_RATIO - bot.attackRatio) * 0.3;

  const lowPop = bot.popCurrent < bot.popCap * 0.25;
  tryBotBuild(bot, s, lowPop);
  if (tryBotExpand(bot, lowPop)) return;
  if (!lowPop) tryBotAttack(bot, s);
  s.lostTilesRecent *= 0.6;
}

function tryBotBuild(bot, state, lowPop) {
  if (bot.popCurrent > 0.92 * bot.popCap && bot.gold >= nextCityCost(bot.id)) {
    const tile = findOwnedInteriorTile(bot.id);
    if (tile !== -1) placeOrUpgrade(tile, bot.id, 1);
  }
  if ((state.lostTilesRecent > 1 || hasBorderConflict(bot.id) || lowPop) && bot.gold >= nextDefenseCost(bot.id)) {
    const tile = findContestedBorderTile(bot.id);
    if (tile !== -1) placeOrUpgrade(tile, bot.id, 2);
  }
}

function tryBotExpand(bot, lowPop) {
  const candidates = [];
  forEachOwnedTile(bot.id, (i, x, y) => {
    for (const [nx, ny] of neighbors4(x, y)) {
      const ni = idx(nx, ny);
      if (terrain[ni] === 0 || owner[ni] !== 0) continue;
      const score = terrain[ni] === 1 ? 2 : 0.8;
      candidates.push({ ni, score });
    }
  });
  if (!candidates.length) return false;
  candidates.sort((a, b) => b.score - a.score);
  const take = candidates[0].ni;
  owner[take] = bot.id;
  combatProg[take] = 0;
  bot.popCurrent = Math.max(0, bot.popCurrent - (lowPop ? 2 : 8));
  recalcAllLandCounts();
  recalcAllPopCaps();
  return true;
}

function tryBotAttack(bot, state) {
  let best = null;
  forEachOwnedTile(bot.id, (i, x, y) => {
    for (const [nx, ny] of neighbors4(x, y)) {
      const ni = idx(nx, ny);
      const defId = owner[ni];
      if (defId === 0 || defId === bot.id || terrain[ni] === 0) continue;
      const defender = factions[defId - 1];
      if (!defender) continue;
      const defTroops = defender.popCurrent * (1 - defender.workerPct);
      const density = defTroops / Math.max(1, defender.tilesOwnedLand);
      const weaknessScore = 110 / (8 + density);
      const enclosureScore = estimateEnclosurePotential(ni, defId, bot.id);
      const proximityScore = (x + y) % 5;
      const terrainPenalty = terrain[ni] === 2 ? 10 : 0;
      const defensePenalty = getDefenseLevelsInRadius(ni, defId, CONFIG.DEFENSE_RADIUS) * 3;
      const score = weaknessScore + enclosureScore + proximityScore - terrainPenalty - defensePenalty;
      if (!best || score > best.score) best = { ni, score };
    }
  });
  if (best && best.score > 1.5) {
    state.target = best.ni;
    state.burstLeft = CONFIG.BOT_BURST_SEC;
  }
}

function estimateEnclosurePotential(targetI, defenderId, attackerId) {
  const x = targetI % W, y = Math.floor(targetI / W);
  let enemyBehind = 0, attackerAround = 0;
  for (const [nx, ny] of neighbors4(x, y)) {
    const ni = idx(nx, ny);
    if (owner[ni] === defenderId) enemyBehind++;
    if (owner[ni] === attackerId) attackerAround++;
  }
  return enemyBehind * attackerAround * 1.7;
}

function checkAnnexationNearCapture(capturedI, defenderId, capturerId) {
  if (defenderId <= 0) return;
  const cx = capturedI % W, cy = Math.floor(capturedI / W);
  const seen = new Uint8Array(N);
  for (const [nx, ny] of neighbors4(cx, cy)) {
    const ni = idx(nx, ny);
    if (owner[ni] !== defenderId || terrain[ni] === 0 || seen[ni]) continue;
    const region = floodRegion(ni, defenderId, seen);
    if (!region.touchesEdge && region.tiles.length) {
      for (const ri of region.tiles) owner[ri] = capturerId;
      annexFlashes.push({ tiles: region.tiles, until: performance.now() + 420 });
      beep(660, 0.12);
    }
  }
  recalcAllLandCounts();
  recalcAllPopCaps();
}

function floodRegion(startI, factionId, globalSeen) {
  const q = [startI];
  const tiles = [];
  let touchesEdge = false;
  while (q.length) {
    const i = q.pop();
    if (globalSeen[i]) continue;
    globalSeen[i] = 1;
    if (owner[i] !== factionId || terrain[i] === 0) continue;
    tiles.push(i);
    const x = i % W, y = Math.floor(i / W);
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesEdge = true;
    for (const [nx, ny] of neighbors4(x, y)) {
      const ni = idx(nx, ny);
      if (!globalSeen[ni]) q.push(ni);
    }
  }
  return { tiles, touchesEdge };
}

function handlePrimaryClick() {
  updateMouseTile();
  const i = mouse.index;
  if (i < 0 || !inside(mouse.tx, mouse.ty)) return;

  if (buildMode) {
    if (placeOrUpgrade(i, player.id, buildMode)) return;
  }

  if (terrain[i] === 0 || owner[i] === player.id || owner[i] === 0) return;
  if (isAdjacentOwnedBy(i, player.id)) {
    playerAttackTarget = i;
  }
}

function placeOrUpgrade(i, factionId, mode) {
  if (terrain[i] === 0 || owner[i] !== factionId) return false;
  const f = factions[factionId - 1];
  if (!f) return false;

  if (building[i] === 0) {
    const cost = mode === 1 ? CONFIG.CITY_BASE_COST : CONFIG.DEFENSE_BASE_COST;
    if (f.gold < cost) return false;
    f.gold -= cost;
    building[i] = mode;
    bLevel[i] = 1;
  } else if (building[i] === mode) {
    const nextLevel = bLevel[i] + 1;
    const cost = mode === 1
      ? Math.round(CONFIG.CITY_BASE_COST * Math.pow(CONFIG.CITY_COST_SCALE, nextLevel - 1))
      : Math.round(CONFIG.DEFENSE_BASE_COST * Math.pow(CONFIG.DEFENSE_COST_SCALE, nextLevel - 1));
    if (f.gold < cost) return false;
    f.gold -= cost;
    bLevel[i] = nextLevel;
  } else {
    return false;
  }
  recalcAllPopCaps();
  return true;
}

function nextCityCost(factionId) {
  let maxLv = 0;
  for (let i = 0; i < N; i++) if (owner[i] === factionId && building[i] === 1) maxLv = Math.max(maxLv, bLevel[i]);
  return Math.round(CONFIG.CITY_BASE_COST * Math.pow(CONFIG.CITY_COST_SCALE, maxLv));
}

function nextDefenseCost(factionId) {
  let maxLv = 0;
  for (let i = 0; i < N; i++) if (owner[i] === factionId && building[i] === 2) maxLv = Math.max(maxLv, bLevel[i]);
  return Math.round(CONFIG.DEFENSE_BASE_COST * Math.pow(CONFIG.DEFENSE_COST_SCALE, maxLv));
}

function findOwnedInteriorTile(factionId) {
  let best = -1, bestScore = -1;
  forEachOwnedTile(factionId, (i, x, y) => {
    let enemyAdj = 0;
    for (const [nx, ny] of neighbors4(x, y)) if (owner[idx(nx, ny)] !== factionId) enemyAdj++;
    if (enemyAdj === 0) {
      const score = Math.random() * 10 + (terrain[i] === 1 ? 2 : 0);
      if (score > bestScore) { best = i; bestScore = score; }
    }
  });
  return best;
}

function findContestedBorderTile(factionId) {
  let best = -1;
  let scoreBest = -1;
  forEachOwnedTile(factionId, (i, x, y) => {
    if (building[i] !== 0) return;
    let enemyAdj = 0;
    for (const [nx, ny] of neighbors4(x, y)) {
      const o = owner[idx(nx, ny)];
      if (o !== factionId && o !== 0) enemyAdj++;
    }
    if (enemyAdj > 0) {
      const score = enemyAdj * 3 + Math.random();
      if (score > scoreBest) { scoreBest = score; best = i; }
    }
  });
  return best;
}

function hasBorderConflict(factionId) {
  let conflict = false;
  forEachOwnedTile(factionId, (i, x, y) => {
    if (conflict) return;
    for (const [nx, ny] of neighbors4(x, y)) {
      const o = owner[idx(nx, ny)];
      if (o !== factionId && o !== 0) { conflict = true; break; }
    }
  });
  return conflict;
}

function recalcAllLandCounts() {
  for (const f of factions) { f.tilesOwnedLand = 0; f.cityLevels = 0; }
  for (let i = 0; i < N; i++) {
    const oid = owner[i];
    if (oid > 0 && terrain[i] !== 0) {
      const f = factions[oid - 1];
      if (f) f.tilesOwnedLand++;
      if (building[i] === 1 && f) f.cityLevels += bLevel[i];
    }
  }
}

function recalcAllPopCaps() {
  for (const f of factions) {
    f.popCap = CONFIG.BASE_POP_CAP + f.tilesOwnedLand * CONFIG.POP_CAP_PER_LAND_TILE + f.cityLevels * CONFIG.CITY_POP_CAP_BONUS_PER_LEVEL;
    f.popCurrent = clamp(f.popCurrent, 0, f.popCap);
  }
}

function updateHUD() {
  if (!player) return;
  const workers = Math.floor(player.popCurrent * player.workerPct);
  const troops = Math.floor(player.popCurrent * (1 - player.workerPct));
  const landPct = totalLandTiles > 0 ? (player.tilesOwnedLand / totalLandTiles) * 100 : 0;
  goldText.textContent = `Gold: ${Math.floor(player.gold)}`;
  popText.textContent = `Pop: ${Math.floor(player.popCurrent)} / ${Math.floor(player.popCap)}`;
  landText.textContent = `Land: ${landPct.toFixed(1)}%`;
  troopsText.textContent = `Troops: ${troops}`;
  workersText.textContent = `Workers: ${workers}`;

  const i = mouse.index;
  if (i >= 0 && inside(mouse.tx, mouse.ty)) {
    tooltipText.textContent = `Tile(${mouse.tx},${mouse.ty}) ${terrainName(terrain[i])} | Owner: ${ownerName(owner[i])} | Building: ${buildingName(building[i], bLevel[i])}`;
  }
}

function checkEndConditions() {
  const landPct = totalLandTiles > 0 ? player.tilesOwnedLand / totalLandTiles : 0;
  if (landPct >= CONFIG.WIN_LAND_PCT) {
    showEnd(true);
  } else if (player.tilesOwnedLand === 0) {
    showEnd(false);
  }
}

function showEnd(win) {
  gameRunning = false;
  const landPct = totalLandTiles > 0 ? (player.tilesOwnedLand / totalLandTiles) * 100 : 0;
  const botsDefeated = bots.filter(b => b.tilesOwnedLand === 0).length;
  let largestEnemy = 0;
  for (const b of bots) largestEnemy = Math.max(largestEnemy, b.tilesOwnedLand);
  endTitle.textContent = win ? 'Victory!' : 'Defeat';
  endStats.textContent = `Time: ${elapsedSec.toFixed(1)}s | Final Land: ${landPct.toFixed(1)}% | Bots Defeated: ${botsDefeated}/${bots.length} | Largest Enemy: ${largestEnemy} tiles`;
  endOverlay.classList.remove('hidden');
  endOverlay.classList.add('visible');
}

function render() {
  drawMapToImageData();
  ctx.save();
  ctx.setTransform(camera.zoom, 0, 0, camera.zoom, -camera.x * camera.zoom, -camera.y * camera.zoom);
  ctx.putImageData(mapImageData, 0, 0);
  drawBorders();
  drawBuildings();
  drawCombatOverlay();
  drawAnnexFlashes();
  ctx.restore();
}

function drawMapToImageData() {
  const data = mapImageData.data;
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    let color = CONFIG.NEUTRAL_COLOR;
    if (terrain[i] === 0) color = CONFIG.WATER_COLOR;
    else if (owner[i] === 0) color = CONFIG.NEUTRAL_COLOR;
    else color = factions[owner[i] - 1]?.color || '#ffffff';
    let [r, g, b] = hexToRgb(color);
    if (terrain[i] === 2) { r *= CONFIG.MOUNTAIN_SHADE; g *= CONFIG.MOUNTAIN_SHADE; b *= CONFIG.MOUNTAIN_SHADE; }
    data[p] = r | 0; data[p + 1] = g | 0; data[p + 2] = b | 0; data[p + 3] = 255;
  }
}

function drawBorders() {
  ctx.lineWidth = Math.max(0.06, 1 / camera.zoom);
  ctx.strokeStyle = 'rgba(15,23,42,0.45)';
  ctx.beginPath();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (terrain[i] === 0) continue;
      const o = owner[i];
      if (x + 1 < W && owner[idx(x + 1, y)] !== o) {
        ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + 1);
      }
      if (y + 1 < H && owner[idx(x, y + 1)] !== o) {
        ctx.moveTo(x, y + 1); ctx.lineTo(x + 1, y + 1);
      }
    }
  }
  ctx.stroke();
}

function drawBuildings() {
  for (let i = 0; i < N; i++) {
    if (building[i] === 0 || owner[i] === 0) continue;
    const x = i % W, y = Math.floor(i / W);
    if (building[i] === 1) {
      ctx.fillStyle = 'rgba(250,204,21,0.95)';
      ctx.fillRect(x + 0.2, y + 0.2, 0.6, 0.6);
    } else {
      ctx.fillStyle = 'rgba(148,163,184,0.95)';
      ctx.beginPath();
      ctx.arc(x + 0.5, y + 0.5, 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCombatOverlay() {
  for (let i = 0; i < N; i++) {
    const p = combatProg[i];
    if (p <= 0.01) continue;
    const x = i % W, y = Math.floor(i / W);
    ctx.fillStyle = `rgba(255,255,255,${0.08 + p * 0.35})`;
    ctx.fillRect(x, y, 1, 1);
  }
  if (playerAttackTarget !== -1) {
    const x = playerAttackTarget % W, y = Math.floor(playerAttackTarget / W);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(0.08, 1.8 / camera.zoom);
    ctx.strokeRect(x + 0.04, y + 0.04, 0.92, 0.92);
  }
}

function drawAnnexFlashes() {
  const now = performance.now();
  annexFlashes = annexFlashes.filter(f => f.until > now);
  if (!annexFlashes.length) return;
  ctx.strokeStyle = 'rgba(250,204,21,0.95)';
  ctx.lineWidth = Math.max(0.08, 2 / camera.zoom);
  for (const flash of annexFlashes) {
    const set = new Set(flash.tiles);
    ctx.beginPath();
    for (const i of flash.tiles) {
      const x = i % W, y = Math.floor(i / W);
      if (!set.has(idxSafe(x + 1, y))) { ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + 1); }
      if (!set.has(idxSafe(x - 1, y))) { ctx.moveTo(x, y); ctx.lineTo(x, y + 1); }
      if (!set.has(idxSafe(x, y + 1))) { ctx.moveTo(x, y + 1); ctx.lineTo(x + 1, y + 1); }
      if (!set.has(idxSafe(x, y - 1))) { ctx.moveTo(x, y); ctx.lineTo(x + 1, y); }
    }
    ctx.stroke();
  }
}

function updateMouseTile() {
  const w = screenToWorld(mouse.sx, mouse.sy);
  mouse.tx = Math.floor(w.x);
  mouse.ty = Math.floor(w.y);
  mouse.index = inside(mouse.tx, mouse.ty) ? idx(mouse.tx, mouse.ty) : -1;
}

function screenToWorld(sx, sy) {
  return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
}

function isAdjacentOwnedBy(i, factionId) {
  const x = i % W, y = Math.floor(i / W);
  for (const [nx, ny] of neighbors4(x, y)) if (owner[idx(nx, ny)] === factionId) return true;
  return false;
}

function forEachOwnedTile(factionId, cb) {
  for (let i = 0; i < N; i++) {
    if (owner[i] === factionId && terrain[i] !== 0) cb(i, i % W, Math.floor(i / W));
  }
}

function neighbors4(x, y) {
  const out = [];
  if (x > 0) out.push([x - 1, y]);
  if (x < W - 1) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y < H - 1) out.push([x, y + 1]);
  return out;
}

function beep(freq, duration) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.04;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    o.stop(audioCtx.currentTime + duration);
  } catch {}
}

function terrainName(v) { return v === 0 ? 'Water' : v === 1 ? 'Plains' : 'Mountain'; }
function ownerName(id) { return id === 0 ? 'Neutral' : factions[id - 1]?.name || `#${id}`; }
function buildingName(id, lv) { return id === 0 ? 'None' : id === 1 ? `City Lv${lv}` : `Defense Lv${lv}`; }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function idx(x, y) { return y * W + x; }
function idxSafe(x, y) { return inside(x, y) ? idx(x, y) : -9999; }
function inside(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
function randInt(a, b) { return (Math.random() * (b - a + 1) + a) | 0; }
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
