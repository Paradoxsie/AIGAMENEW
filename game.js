/*
Typed arrays per tile index i = x + y*W:
- terrain: 0 water, 1 plains, 2 mountain
- owner: 0 neutral, 1 player, 2..N factions
- building: 0 none, 1 city, 2 defense
- bLevel: building level
- combatProg: attack progress [0..1]
Main loop: fixed-step simulation at CONFIG.TICK_HZ + requestAnimationFrame rendering.
*/

const CONFIG = {
  TICK_HZ: 20,
  BASE_POP_CAP: 8000,
  POP_CAP_PER_LAND_TILE: 30,
  CITY_POP_CAP_BONUS_PER_LEVEL: 25000,
  START_POP_CURRENT: 6500,
  START_GOLD: 2000,
  GOLD_PER_WORKER_PER_SEC: 0.015,
  TILE_SIZE: 4,
  DEFENSE_RADIUS: 4,
  WIN_LAND_PCT: 0.72,
  CITY_BASE_COST: 2500,
  DEF_BASE_COST: 1800,
  ATTACK_POWER_FACTOR: 0.020,
  DEF_BASE_FACTOR: 55,
  PROG_GAIN: 0.0012,
  PROG_LOSS: 0.00035,
  ATTACK_CASUALTY: 0.006,
  DEF_CASUALTY: 0.0008,
  BOT_BURST_SEC: 1.5,
};

const DIFFICULTY = {
  easy: { THINK_INTERVAL_SEC: 1.5, ECON_MULT: 0.9, TARGET_WORKER_PCT: 0.65, TARGET_ATTACK_RATIO: 0.16 },
  normal: { THINK_INTERVAL_SEC: 1.0, ECON_MULT: 1.0, TARGET_WORKER_PCT: 0.60, TARGET_ATTACK_RATIO: 0.20 },
  hard: { THINK_INTERVAL_SEC: 0.6, ECON_MULT: 1.1, TARGET_WORKER_PCT: 0.55, TARGET_ATTACK_RATIO: 0.24 }
};

const TERRAIN = { WATER: 0, PLAINS: 1, MOUNTAIN: 2 };
const BUILD = { NONE: 0, CITY: 1, DEFENSE: 2 };

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const menuOverlay = document.getElementById('menuOverlay');
const hud = document.getElementById('hud');
const endOverlay = document.getElementById('endOverlay');
const statusText = document.getElementById('statusText');

let W = 384, H = 216, N = 0;
let terrain, owner, building, bLevel, combatProg;
let factions = [];
let bots = [];
let totalLand = 1;
let playerAttackTarget = -1;
let mouseDown = false;
let pendingBuild = 0;
let paused = false;
let speedMult = 1;
let gameEnded = false;
let simAccumulator = 0;
let lastTs = 0;
let elapsedSec = 0;
let camera = { zoom: 1, x: 0, y: 0 };
let dragging = false;
let dragStart = null;
let mouseScreen = { x: 0, y: 0 };
let flashRegions = [];

function idx(x, y) { return x + y * W; }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
function tileX(i) { return i % W; }
function tileY(i) { return (i / W) | 0; }

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function randInt(min, max) { return (Math.random() * (max - min + 1) + min) | 0; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx*dx + dy*dy; }

function parseMapSize(v) {
  const [w, h] = v.split('x').map(Number); return { w, h };
}

function initArrays() {
  const len = W * H;
  terrain = new Uint8Array(len);
  owner = new Uint16Array(len);
  building = new Uint8Array(len);
  bLevel = new Uint8Array(len);
  combatProg = new Float32Array(len);
}

function smoothPass(arr, passes = 3) {
  const temp = new Float32Array(arr.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0, c = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox, ny = y + oy;
            if (!inBounds(nx, ny)) continue;
            sum += arr[idx(nx, ny)]; c++;
          }
        }
        temp[idx(x, y)] = sum / c;
      }
    }
    arr.set(temp);
  }
}

function generateMap() {
  initArrays();
  const len = W * H;
  const noise = new Float32Array(len);
  for (let i = 0; i < len; i++) noise[i] = Math.random();
  smoothPass(noise, 5);
  const targetLand = 0.25 + Math.random() * 0.15;
  const sorted = Array.from(noise).sort((a, b) => b - a);
  const threshold = sorted[(sorted.length * targetLand) | 0] || 0.5;
  for (let i = 0; i < len; i++) terrain[i] = noise[i] >= threshold ? TERRAIN.PLAINS : TERRAIN.WATER;

  // mountain clusters on land
  const mountainSeedCount = Math.max(8, (W * H / 5000) | 0);
  const seeds = [];
  for (let s = 0; s < mountainSeedCount; s++) {
    let attempts = 0;
    while (attempts++ < 1000) {
      const x = randInt(0, W - 1), y = randInt(0, H - 1), i = idx(x, y);
      if (terrain[i] === TERRAIN.PLAINS) { seeds.push([x, y]); break; }
    }
  }
  for (const [sx, sy] of seeds) {
    const rad = randInt(3, 8);
    for (let y = sy - rad; y <= sy + rad; y++) {
      for (let x = sx - rad; x <= sx + rad; x++) {
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        if (terrain[i] !== TERRAIN.PLAINS) continue;
        const d = Math.sqrt(dist2(x, y, sx, sy));
        if (d <= rad && Math.random() > d / (rad + 1)) terrain[i] = TERRAIN.MOUNTAIN;
      }
    }
  }
  // keep mountain % sensible
  let land = 0, mountain = 0;
  for (let i = 0; i < len; i++) {
    if (terrain[i] !== TERRAIN.WATER) { land++; if (terrain[i] === TERRAIN.MOUNTAIN) mountain++; }
  }
  const maxM = land * 0.15;
  while (mountain > maxM) {
    const i = randInt(0, len - 1);
    if (terrain[i] === TERRAIN.MOUNTAIN) { terrain[i] = TERRAIN.PLAINS; mountain--; }
  }
  totalLand = Math.max(1, land);
}

function createFaction(id, isPlayer, difficultyKey) {
  const diff = DIFFICULTY[difficultyKey] || DIFFICULTY.normal;
  return {
    id, isPlayer,
    gold: CONFIG.START_GOLD,
    popCurrent: CONFIG.START_POP_CURRENT,
    popCap: CONFIG.BASE_POP_CAP,
    workerPct: isPlayer ? 0.6 : diff.TARGET_WORKER_PCT,
    attackRatio: isPlayer ? 0.2 : diff.TARGET_ATTACK_RATIO,
    tilesOwnedLand: 0,
    cityLevels: 0,
    thinkTimer: 0,
    target: -1,
    burstTimer: 0,
    econMult: isPlayer ? 1 : diff.ECON_MULT,
    thinkInterval: diff.THINK_INTERVAL_SEC,
    recentTileLoss: 0,
  };
}

function spawnFactions(botCount, difficultyKey) {
  factions = [null];
  bots = [];
  N = botCount + 1;
  factions[1] = createFaction(1, true, difficultyKey);
  for (let i = 2; i <= N; i++) {
    const f = createFaction(i, false, difficultyKey);
    factions[i] = f;
    bots.push(f);
  }
  const seeds = [];
  const minDist = Math.max(18, Math.min(25, (W / 16) | 0));
  const minDist2 = minDist * minDist;
  for (let id = 1; id <= N; id++) {
    let placed = false;
    for (let a = 0; a < 5000 && !placed; a++) {
      const x = randInt(6, W - 7), y = randInt(6, H - 7);
      if (terrain[idx(x, y)] === TERRAIN.WATER) continue;
      let ok = true;
      for (const [sx, sy] of seeds) if (dist2(x, y, sx, sy) < minDist2) ok = false;
      if (!ok) continue;
      seeds.push([x, y]);
      assignStartingBlob(id, x, y, 40);
      placed = true;
    }
  }
  recalcAllStats();
}

function assignStartingBlob(fid, sx, sy, count) {
  const q = [[sx, sy]];
  const seen = new Uint8Array(W * H);
  let got = 0;
  while (q.length && got < count) {
    const [x, y] = q.shift();
    if (!inBounds(x, y)) continue;
    const i = idx(x, y);
    if (seen[i]) continue;
    seen[i] = 1;
    if (terrain[i] === TERRAIN.WATER) continue;
    owner[i] = fid;
    got++;
    q.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function recalcFactionStats(fid) {
  const f = factions[fid];
  let land = 0, cityLevels = 0;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === fid && terrain[i] !== TERRAIN.WATER) {
      land++;
      if (building[i] === BUILD.CITY) cityLevels += bLevel[i];
    }
  }
  f.tilesOwnedLand = land;
  f.cityLevels = cityLevels;
  f.popCap = CONFIG.BASE_POP_CAP + land * CONFIG.POP_CAP_PER_LAND_TILE + cityLevels * CONFIG.CITY_POP_CAP_BONUS_PER_LEVEL;
  f.popCurrent = Math.min(f.popCurrent, f.popCap);
}

function recalcAllStats() {
  for (let id = 1; id <= N; id++) recalcFactionStats(id);
}

function getWorkers(f) { return f.popCurrent * f.workerPct; }
function getTroops(f) { return f.popCurrent * (1 - f.workerPct); }
function terrainDefenseMult(i) { return terrain[i] === TERRAIN.MOUNTAIN ? 1.35 : 1.0; }

function getLocalDefenseMult(fid, cx, cy) {
  let levels = 0;
  const r = CONFIG.DEFENSE_RADIUS;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!inBounds(x, y)) continue;
      if (dist2(x, y, cx, cy) > r * r) continue;
      const i = idx(x, y);
      if (owner[i] === fid && building[i] === BUILD.DEFENSE) levels += bLevel[i];
    }
  }
  return 1 + 0.12 * levels;
}

function hasAdjOwner(i, fid) {
  const x = tileX(i), y = tileY(i);
  const n = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
  for (const [nx, ny] of n) if (inBounds(nx, ny) && owner[idx(nx, ny)] === fid) return true;
  return false;
}

function captureTile(i, attackerId) {
  const prev = owner[i];
  if (prev === attackerId) return;
  owner[i] = attackerId;
  combatProg[i] = 0;
  if (prev > 0) factions[prev].recentTileLoss += 1;
  recalcFactionStats(attackerId);
  if (prev > 0) recalcFactionStats(prev);
  checkEnclosureFromCapture(i, attackerId, prev);
}

function attemptPlayerAttack(i) {
  if (i < 0 || i >= owner.length) return;
  if (terrain[i] === TERRAIN.WATER) return;
  if (owner[i] <= 1) return;
  if (!hasAdjOwner(i, 1)) return;
  playerAttackTarget = i;
}

function populationGrowthRate(ratio) {
  const x = ratio - 0.45;
  let v = 0.06 - 0.173 * x * x;
  if (v < 0.002) v = 0.002;
  return v;
}

function simEconomy(dt) {
  for (let id = 1; id <= N; id++) {
    const f = factions[id];
    const workers = getWorkers(f);
    f.gold += workers * CONFIG.GOLD_PER_WORKER_PER_SEC * f.econMult * dt;
    const ratio = f.popCap <= 0 ? 0 : f.popCurrent / f.popCap;
    const growth = f.popCurrent * populationGrowthRate(ratio) * dt;
    f.popCurrent = Math.max(0, Math.min(f.popCap, f.popCurrent + growth));
    f.recentTileLoss *= 0.96;
  }
}

function resolveAttack(attackerId, targetIdx, dt) {
  if (targetIdx < 0 || targetIdx >= owner.length) return;
  if (terrain[targetIdx] === TERRAIN.WATER) return;
  const defenderId = owner[targetIdx];
  if (defenderId === attackerId) return;
  if (defenderId === 0) {
    captureTile(targetIdx, attackerId);
    factions[attackerId].popCurrent *= 0.999;
    return;
  }
  if (!hasAdjOwner(targetIdx, attackerId)) return;

  const atk = factions[attackerId];
  const def = factions[defenderId];
  const atkTroops = getTroops(atk) * atk.attackRatio;
  const defDensity = getTroops(def) / Math.max(1, def.tilesOwnedLand);
  const atkPower = atkTroops * CONFIG.ATTACK_POWER_FACTOR;
  const tx = tileX(targetIdx), ty = tileY(targetIdx);
  const defPower = defDensity * CONFIG.DEF_BASE_FACTOR * terrainDefenseMult(targetIdx) * getLocalDefenseMult(defenderId, tx, ty);
  const net = atkPower - defPower;
  if (net >= 0) combatProg[targetIdx] += net * CONFIG.PROG_GAIN;
  else combatProg[targetIdx] += net * CONFIG.PROG_LOSS;
  if (combatProg[targetIdx] < 0) combatProg[targetIdx] = 0;
  if (combatProg[targetIdx] >= 1) captureTile(targetIdx, attackerId);

  atk.popCurrent = Math.max(0, atk.popCurrent - atkTroops * CONFIG.ATTACK_CASUALTY * dt);
  const ratio = atkPower <= 0 ? 0 : atkPower / (atkPower + defPower);
  def.popCurrent = Math.max(0, def.popCurrent - Math.max(0, ratio) * defPower * CONFIG.DEF_CASUALTY * dt);
}

function botThink(bot, dt) {
  bot.thinkTimer += dt;
  if (bot.burstTimer > 0) {
    bot.burstTimer -= dt;
    if (bot.target >= 0) resolveAttack(bot.id, bot.target, dt);
  }
  if (bot.thinkTimer < bot.thinkInterval) return;
  bot.thinkTimer = 0;
  bot.workerPct += (DIFFICULTY[currentDifficulty].TARGET_WORKER_PCT - bot.workerPct) * 0.2;
  bot.attackRatio += (DIFFICULTY[currentDifficulty].TARGET_ATTACK_RATIO - bot.attackRatio) * 0.2;

  if (bot.popCurrent > 0.92 * bot.popCap && bot.gold >= CONFIG.CITY_BASE_COST) botBuildCity(bot);
  if ((bot.recentTileLoss > 0.8 || hasConflict(bot.id)) && bot.gold >= CONFIG.DEF_BASE_COST) botBuildDefense(bot);

  const weak = bot.popCurrent < 0.25 * bot.popCap;
  if (!weak && tryBotExpand(bot)) return;
  if (!weak) botChooseAttack(bot);
}

function hasConflict(fid) {
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== fid) continue;
    const x = tileX(i), y = tileY(i);
    for (const [nx, ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
      if (!inBounds(nx, ny)) continue;
      const o = owner[idx(nx, ny)];
      if (o > 0 && o !== fid) return true;
    }
  }
  return false;
}

function tileBuildCost(type, level) {
  if (type === BUILD.CITY) return Math.round(CONFIG.CITY_BASE_COST * Math.pow(1.7, Math.max(0, level - 1)));
  if (type === BUILD.DEFENSE) return Math.round(CONFIG.DEF_BASE_COST * Math.pow(1.6, Math.max(0, level - 1)));
  return 0;
}

function botBuildCity(bot) {
  let best = -1;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== bot.id || terrain[i] === TERRAIN.WATER) continue;
    const border = hasEnemyNeighbor(i, bot.id);
    if (border) continue;
    if (building[i] !== BUILD.NONE && building[i] !== BUILD.CITY) continue;
    best = i; break;
  }
  if (best < 0) return;
  const lv = building[best] === BUILD.CITY ? bLevel[best] + 1 : 1;
  const cost = tileBuildCost(BUILD.CITY, lv);
  if (bot.gold < cost) return;
  bot.gold -= cost;
  building[best] = BUILD.CITY;
  bLevel[best] = lv;
  recalcFactionStats(bot.id);
}

function botBuildDefense(bot) {
  let best = -1;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== bot.id || terrain[i] === TERRAIN.WATER) continue;
    if (!hasEnemyNeighbor(i, bot.id)) continue;
    if (building[i] !== BUILD.NONE && building[i] !== BUILD.DEFENSE) continue;
    best = i; break;
  }
  if (best < 0) return;
  const lv = building[best] === BUILD.DEFENSE ? bLevel[best] + 1 : 1;
  const cost = tileBuildCost(BUILD.DEFENSE, lv);
  if (bot.gold < cost) return;
  bot.gold -= cost;
  building[best] = BUILD.DEFENSE;
  bLevel[best] = lv;
}

function hasEnemyNeighbor(i, fid) {
  const x = tileX(i), y = tileY(i);
  for (const [nx, ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
    if (!inBounds(nx, ny)) continue;
    const o = owner[idx(nx, ny)];
    if (o > 0 && o !== fid) return true;
  }
  return false;
}

function tryBotExpand(bot) {
  let best = -1, score = -1e9;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== bot.id) continue;
    const x = tileX(i), y = tileY(i);
    for (const [nx, ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (owner[ni] !== 0 || terrain[ni] === TERRAIN.WATER) continue;
      const s = terrain[ni] === TERRAIN.PLAINS ? 2 : 1;
      if (s > score) { score = s; best = ni; }
    }
  }
  if (best >= 0) {
    captureTile(best, bot.id);
    bot.popCurrent = Math.max(0, bot.popCurrent - getTroops(bot) * 0.001);
    return true;
  }
  return false;
}

function botChooseAttack(bot) {
  let best = -1, bestScore = -1e9;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === bot.id || owner[i] === 0 || terrain[i] === TERRAIN.WATER) continue;
    if (!hasAdjOwner(i, bot.id)) continue;
    const def = factions[owner[i]];
    const weakness = 300 / Math.max(10, getTroops(def) / Math.max(1, def.tilesOwnedLand));
    const enclosure = enclosurePotential(i, bot.id) * 18;
    const prox = owner[i] === 1 ? 4 : 2;
    const terrainPenalty = terrain[i] === TERRAIN.MOUNTAIN ? 7 : 0;
    const defPenalty = (getLocalDefenseMult(owner[i], tileX(i), tileY(i)) - 1) * 10;
    const sc = weakness + enclosure + prox - terrainPenalty - defPenalty;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  if (best >= 0) {
    bot.target = best;
    bot.burstTimer = CONFIG.BOT_BURST_SEC;
  }
}

function enclosurePotential(target, attackerId) {
  const x = tileX(target), y = tileY(target);
  const enemy = owner[target];
  let c = 0;
  for (const [nx, ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
    if (!inBounds(nx, ny)) continue;
    const ni = idx(nx, ny);
    if (owner[ni] === enemy) {
      let support = 0;
      for (const [sx, sy] of [[nx+1,ny],[nx-1,ny],[nx,ny+1],[nx,ny-1]]) {
        if (inBounds(sx, sy) && owner[idx(sx, sy)] === attackerId) support++;
      }
      if (support >= 2) c++;
    }
  }
  return c;
}

function checkEnclosureFromCapture(capturedIdx, attackerId, defenderId) {
  if (defenderId <= 0) return;
  const cx = tileX(capturedIdx), cy = tileY(capturedIdx);
  const seen = new Uint8Array(owner.length);
  for (const [nx, ny] of [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]]) {
    if (!inBounds(nx, ny)) continue;
    const s = idx(nx, ny);
    if (owner[s] !== defenderId || seen[s]) continue;
    const region = [];
    let touchesEdge = false;
    const q = [s];
    seen[s] = 1;
    while (q.length) {
      const i = q.pop();
      region.push(i);
      const x = tileX(i), y = tileY(i);
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesEdge = true;
      for (const [ax, ay] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
        if (!inBounds(ax, ay)) continue;
        const ni = idx(ax, ay);
        if (!seen[ni] && owner[ni] === defenderId && terrain[ni] !== TERRAIN.WATER) {
          seen[ni] = 1;
          q.push(ni);
        }
      }
    }
    if (!touchesEdge && region.length > 0) {
      for (const i of region) owner[i] = attackerId;
      flashRegions.push({ tiles: region, ttl: 0.5 });
      beep(700, 0.08);
      recalcFactionStats(attackerId);
      recalcFactionStats(defenderId);
    }
  }
}

let audioCtx;
function beep(freq, dur) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.05;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch {}
}

function update(dt) {
  if (gameEnded) return;
  simEconomy(dt);
  if (mouseDown && playerAttackTarget >= 0) {
    if (owner[playerAttackTarget] > 1 && hasAdjOwner(playerAttackTarget, 1)) resolveAttack(1, playerAttackTarget, dt);
    else playerAttackTarget = -1;
  }
  for (const bot of bots) botThink(bot, dt);
  for (let i = flashRegions.length - 1; i >= 0; i--) {
    flashRegions[i].ttl -= dt;
    if (flashRegions[i].ttl <= 0) flashRegions.splice(i, 1);
  }
  checkWinLose();
}

function checkWinLose() {
  const playerLand = factions[1].tilesOwnedLand;
  const pct = playerLand / totalLand;
  if (pct >= CONFIG.WIN_LAND_PCT) endGame(true);
  else if (playerLand <= 0) endGame(false);
}

function endGame(win) {
  gameEnded = true;
  const playerPct = (factions[1].tilesOwnedLand / totalLand) * 100;
  let botsDefeated = 0, largest = 0;
  for (let id = 2; id <= N; id++) {
    const l = factions[id].tilesOwnedLand;
    if (l === 0) botsDefeated++;
    largest = Math.max(largest, l);
  }
  document.getElementById('endTitle').textContent = win ? 'Victory!' : 'Defeat';
  document.getElementById('endStats').textContent = `Time: ${elapsedSec.toFixed(1)}s | Land: ${playerPct.toFixed(1)}% | Bots defeated: ${botsDefeated}/${N-1} | Largest enemy: ${largest} tiles`;
  endOverlay.classList.remove('hidden');
}

function factionColor(id) {
  if (id === 0) return '#5f7261';
  if (id === 1) return '#35c4ff';
  const hue = (id * 43) % 360;
  return `hsl(${hue} 70% 53%)`;
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const ts = CONFIG.TILE_SIZE * camera.zoom;
  const startX = Math.max(0, Math.floor((-camera.x) / ts));
  const startY = Math.max(0, Math.floor((-camera.y) / ts));
  const endX = Math.min(W - 1, Math.ceil((canvas.width - camera.x) / ts));
  const endY = Math.min(H - 1, Math.ceil((canvas.height - camera.y) / ts));

  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const i = idx(x, y);
      let col;
      if (terrain[i] === TERRAIN.WATER) col = '#17406d';
      else {
        col = factionColor(owner[i]);
        if (terrain[i] === TERRAIN.MOUNTAIN) col = shadeColor(col, -20);
      }
      ctx.fillStyle = col;
      ctx.fillRect(camera.x + x * ts, camera.y + y * ts, ts + 0.25, ts + 0.25);
      if (building[i] !== BUILD.NONE && terrain[i] !== TERRAIN.WATER) {
        ctx.fillStyle = building[i] === BUILD.CITY ? '#ffd166' : '#c46fff';
        const s = Math.max(2, ts * 0.5);
        ctx.fillRect(camera.x + x * ts + (ts-s)/2, camera.y + y * ts + (ts-s)/2, s, s);
      }
      if (combatProg[i] > 0 && owner[i] > 0) {
        ctx.fillStyle = `rgba(255,80,80,${Math.min(0.8, combatProg[i])})`;
        ctx.fillRect(camera.x + x * ts, camera.y + y * ts, ts, ts);
      }
    }
  }
  drawBorders(startX, startY, endX, endY, ts);
  drawFlashes(ts);
  updateHUD();
}

function drawBorders(startX, startY, endX, endY, ts) {
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, ts * 0.08);
  ctx.beginPath();
  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const i = idx(x, y);
      if (terrain[i] === TERRAIN.WATER) continue;
      const o = owner[i];
      const px = camera.x + x * ts, py = camera.y + y * ts;
      if (x + 1 < W && owner[idx(x + 1, y)] !== o) { ctx.moveTo(px + ts, py); ctx.lineTo(px + ts, py + ts); }
      if (y + 1 < H && owner[idx(x, y + 1)] !== o) { ctx.moveTo(px, py + ts); ctx.lineTo(px + ts, py + ts); }
    }
  }
  ctx.stroke();
}

function drawFlashes(ts) {
  ctx.strokeStyle = 'rgba(255,255,180,0.95)';
  ctx.lineWidth = 2;
  for (const f of flashRegions) {
    const a = Math.max(0, f.ttl * 2);
    ctx.strokeStyle = `rgba(255,255,180,${a})`;
    for (const i of f.tiles) {
      const x = tileX(i), y = tileY(i);
      ctx.strokeRect(camera.x + x*ts + 1, camera.y + y*ts + 1, ts - 2, ts - 2);
    }
  }
}

function shadeColor(color, percent) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = color;
  const rgb = c.fillStyle.match(/\d+/g);
  if (!rgb) return color;
  const f = (v) => Math.max(0, Math.min(255, Number(v) + (255 * percent / 100)));
  return `rgb(${f(rgb[0])},${f(rgb[1])},${f(rgb[2])})`;
}

function screenToWorld(sx, sy) {
  const ts = CONFIG.TILE_SIZE * camera.zoom;
  return { wx: (sx - camera.x) / ts, wy: (sy - camera.y) / ts };
}
function worldToTile(wx, wy) {
  const x = Math.floor(wx), y = Math.floor(wy);
  if (!inBounds(x, y)) return -1;
  return idx(x, y);
}

function updateHUD() {
  if (!factions[1]) return;
  const p = factions[1];
  const landPct = (100 * p.tilesOwnedLand / totalLand).toFixed(1);
  document.getElementById('goldStat').textContent = `Gold: ${p.gold.toFixed(0)}`;
  document.getElementById('popStat').textContent = `Pop: ${p.popCurrent.toFixed(0)} / ${p.popCap.toFixed(0)}`;
  document.getElementById('landStat').textContent = `Land: ${landPct}% (${p.tilesOwnedLand})`;
  document.getElementById('splitStat').textContent = `Troops: ${getTroops(p).toFixed(0)} | Workers: ${getWorkers(p).toFixed(0)}`;
  statusText.textContent = paused ? 'Paused' : (pendingBuild ? (pendingBuild === BUILD.CITY ? 'Placing City...' : 'Placing Defense...') : '');

  const t = getHoverTileInfo();
  document.getElementById('tooltip').textContent = t;
}

function getHoverTileInfo() {
  const w = screenToWorld(mouseScreen.x, mouseScreen.y);
  const i = worldToTile(w.wx, w.wy);
  if (i < 0) return 'Tile: out of map';
  const terr = terrain[i] === TERRAIN.WATER ? 'Water' : terrain[i] === TERRAIN.PLAINS ? 'Plains' : 'Mountain';
  const own = owner[i] === 0 ? 'Neutral' : owner[i] === 1 ? 'Player' : `Bot ${owner[i]-1}`;
  const b = building[i] === BUILD.NONE ? 'None' : `${building[i] === BUILD.CITY ? 'City' : 'Defense'} Lv${bLevel[i]}`;
  return `Tile ${tileX(i)},${tileY(i)} | ${terr} | Owner: ${own} | Building: ${b}`;
}

function tryPlaceBuilding(i, type) {
  const p = factions[1];
  if (i < 0 || terrain[i] === TERRAIN.WATER || owner[i] !== 1) return;
  if (building[i] !== BUILD.NONE && building[i] !== type) return;
  const lv = building[i] === type ? bLevel[i] + 1 : 1;
  const cost = tileBuildCost(type, lv);
  if (p.gold < cost) return;
  p.gold -= cost;
  building[i] = type;
  bLevel[i] = lv;
  if (type === BUILD.CITY) recalcFactionStats(1);
}

let currentDifficulty = 'normal';
function startGame() {
  const ms = parseMapSize(document.getElementById('mapSize').value);
  W = ms.w; H = ms.h;
  currentDifficulty = document.getElementById('difficulty').value;
  const botCount = Number(document.getElementById('botCount').value);

  generateMap();
  spawnFactions(botCount, currentDifficulty);
  paused = false; speedMult = 1; gameEnded = false;
  elapsedSec = 0; simAccumulator = 0; lastTs = 0;
  pendingBuild = 0; playerAttackTarget = -1;
  camera.zoom = Math.min(canvas.width / (W * CONFIG.TILE_SIZE), canvas.height / (H * CONFIG.TILE_SIZE));
  camera.zoom = Math.max(0.8, Math.min(2.5, camera.zoom * 1.15));
  camera.x = (canvas.width - W * CONFIG.TILE_SIZE * camera.zoom) / 2;
  camera.y = (canvas.height - H * CONFIG.TILE_SIZE * camera.zoom) / 2;

  menuOverlay.classList.add('hidden');
  endOverlay.classList.add('hidden');
  hud.classList.remove('hidden');
  requestAnimationFrame(loop);
}

function loop(ts) {
  if (!lastTs) lastTs = ts;
  const frame = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (!paused && !gameEnded) {
    simAccumulator += frame * speedMult;
    const dt = 1 / CONFIG.TICK_HZ;
    while (simAccumulator >= dt) {
      update(dt);
      simAccumulator -= dt;
      elapsedSec += dt;
      if (((elapsedSec * CONFIG.TICK_HZ) | 0) % CONFIG.TICK_HZ === 0) recalcAllStats();
    }
  }
  render();
  requestAnimationFrame(loop);
}

canvas.addEventListener('mousedown', (e) => {
  mouseDown = true;
  if (e.button === 1 || e.button === 2) {
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y };
    return;
  }
  const i = worldToTile(screenToWorld(e.clientX, e.clientY).wx, screenToWorld(e.clientX, e.clientY).wy);
  if (pendingBuild) {
    tryPlaceBuilding(i, pendingBuild);
    return;
  }
  attemptPlayerAttack(i);
});
canvas.addEventListener('mouseup', () => { mouseDown = false; dragging = false; playerAttackTarget = -1; });
canvas.addEventListener('mouseleave', () => { mouseDown = false; dragging = false; });
canvas.addEventListener('mousemove', (e) => {
  mouseScreen.x = e.clientX; mouseScreen.y = e.clientY;
  if (dragging && dragStart) {
    camera.x = dragStart.cx + (e.clientX - dragStart.x);
    camera.y = dragStart.cy + (e.clientY - dragStart.y);
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const old = camera.zoom;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  camera.zoom = Math.max(0.4, Math.min(6, camera.zoom * factor));
  const wx = (e.clientX - camera.x) / (CONFIG.TILE_SIZE * old);
  const wy = (e.clientY - camera.y) / (CONFIG.TILE_SIZE * old);
  camera.x = e.clientX - wx * CONFIG.TILE_SIZE * camera.zoom;
  camera.y = e.clientY - wy * CONFIG.TILE_SIZE * camera.zoom;
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const workerPct = document.getElementById('workerPct');
const attackPct = document.getElementById('attackPct');
function syncSliderLabels() {
  document.getElementById('workerPctLabel').textContent = `${workerPct.value}%`;
  document.getElementById('attackPctLabel').textContent = `${attackPct.value}%`;
  if (factions[1]) {
    factions[1].workerPct = Number(workerPct.value) / 100;
    factions[1].attackRatio = Number(attackPct.value) / 100;
  }
}
workerPct.addEventListener('input', syncSliderLabels);
attackPct.addEventListener('input', syncSliderLabels);
syncSliderLabels();

const botCountInput = document.getElementById('botCount');
botCountInput.addEventListener('input', () => document.getElementById('botCountLabel').textContent = botCountInput.value);

document.getElementById('startBtn').addEventListener('click', startGame);
document.getElementById('pauseBtn').addEventListener('click', () => { paused = !paused; document.getElementById('pauseBtn').textContent = paused ? 'Resume' : 'Pause'; });
document.getElementById('speedBtn').addEventListener('click', () => { speedMult = speedMult === 1 ? 2 : 1; document.getElementById('speedBtn').textContent = `Speed ${speedMult}x`; });
document.getElementById('restartBtn').addEventListener('click', () => location.reload());
document.getElementById('playAgainBtn').addEventListener('click', () => {
  endOverlay.classList.add('hidden');
  hud.classList.add('hidden');
  menuOverlay.classList.remove('hidden');
});
document.getElementById('buildCityBtn').addEventListener('click', () => pendingBuild = BUILD.CITY);
document.getElementById('buildDefenseBtn').addEventListener('click', () => pendingBuild = BUILD.DEFENSE);
document.getElementById('cancelBuildBtn').addEventListener('click', () => pendingBuild = 0);

render();
