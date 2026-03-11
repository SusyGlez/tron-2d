/* ============================================
   TRON Light Cycles — Game Logic
   ============================================ */

"use strict";

// ─── Configuration ───────────────────────────────────────────
const CONFIG = {
  // Grid dimensions (in tiles)
  gridWidth: 80,
  gridHeight: 60,

  // Aspect ratio (derived from grid, used for responsive canvas)
  get aspectRatio() {
    return this.gridWidth / this.gridHeight;
  },

  // Timing
  tickInterval: 50, // ms per game tick (10 ticks/sec = 1 tile per tick)
  countdownDuration: 3, // seconds before round starts
  roundOverPause: 2000, // ms pause after a crash before next round
  crashEffectDuration: 500, // ms for the crash flash animation

  // Players
  livesPerPlayer: 2,

  // Spawn positions (as fractions of grid dimensions)
  // Player 1: left-centre facing right
  // Player 2: right-centre facing left
  spawn: {
    p1: { xFrac: 0.25, yFrac: 0.5, direction: "RIGHT" },
    p2: { xFrac: 0.75, yFrac: 0.5, direction: "LEFT" },
  },

  // Colours
  p1Color: "#00ffff",
  p1ColorDim: "rgba(0, 255, 255, 0.6)",
  p2Color: "#ff8800",
  p2ColorDim: "rgba(255, 136, 0, 0.6)",
  bgColor: "#0a0a1a",
  borderColor: "#4466ff",

  // Glow radii (canvas shadowBlur values)
  trailGlowBlur: 8,
  bikeGlowBlur: 16,
  borderGlowBlur: 12,

  // Powerups
  powerupSpawnInterval: 4000, // ms between spawn attempts
  powerupMaxOnGrid: 3,
  powerupTypes: ["SPEED", "SHIELD", "CLEAR", "SLOW"],
  powerupSpeedDuration: 250, // ticks (250 × 50ms = ~12.5 seconds)
  powerupSlowDuration: 200, // ticks (~10 seconds)
  powerupShieldInvincibility: 10, // ticks of invincibility after shield absorbs a crash
  powerupClearFraction: 0.3, // fraction of opponent trail to erase
};

// Pre-compute spawn tile positions from fractional config
const SPAWN = {
  p1: {
    x: Math.floor(CONFIG.gridWidth * CONFIG.spawn.p1.xFrac),
    y: Math.floor(CONFIG.gridHeight * CONFIG.spawn.p1.yFrac),
    direction: CONFIG.spawn.p1.direction,
  },
  p2: {
    x: Math.floor(CONFIG.gridWidth * CONFIG.spawn.p2.xFrac),
    y: Math.floor(CONFIG.gridHeight * CONFIG.spawn.p2.yFrac),
    direction: CONFIG.spawn.p2.direction,
  },
};

// ─── Game States ─────────────────────────────────────────────
const STATE = {
  COUNTDOWN: "COUNTDOWN",
  PLAYING: "PLAYING",
  ROUND_OVER: "ROUND_OVER",
  MATCH_OVER: "MATCH_OVER",
};

// Valid state transitions — maps current state → set of allowed next states
const VALID_TRANSITIONS = {
  [null]: new Set([STATE.COUNTDOWN]),
  [STATE.COUNTDOWN]: new Set([STATE.PLAYING]),
  [STATE.PLAYING]: new Set([STATE.ROUND_OVER]),
  [STATE.ROUND_OVER]: new Set([STATE.COUNTDOWN, STATE.MATCH_OVER]),
  [STATE.MATCH_OVER]: new Set([STATE.COUNTDOWN]),
};

// ─── Direction Vectors ───────────────────────────────────────
const DIR = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

// Opposite direction lookup (for 180° reversal prevention)
const OPPOSITE = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

// ─── DOM References ──────────────────────────────────────────
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const countdownEl = document.getElementById("countdown");
const roundResultEl = document.getElementById("round-result");
const matchResultEl = document.getElementById("match-result");
const matchWinnerTextEl = document.getElementById("match-winner-text");
const restartBtn = document.getElementById("restart-btn");
const muteBtn = document.getElementById("mute-btn");
const muteIcon = document.getElementById("mute-icon");
const pauseOverlay = document.getElementById("pause-overlay");

const p1LivesIcons = document.querySelector("#p1-lives .lives-icons");
const p2LivesIcons = document.querySelector("#p2-lives .lives-icons");

const startScreen = document.getElementById("start-screen");
const startBtn = document.getElementById("start-btn");
const pauseBtn = document.getElementById("pause-btn");
const pauseIcon = document.getElementById("pause-icon");
const p1Effects = document.getElementById("p1-effects");
const p2Effects = document.getElementById("p2-effects");

// ─── Game Variables ──────────────────────────────────────────
let gameState = null;
let grid = []; // 2D array [x][y] → 0 | 1 | 2
let players = []; // [player1, player2]
let tickTimer = null;
let countdownValue = 0;
let countdownTimer = null;
let roundOverTimeout = null; // timeout handle for auto-advancing after ROUND_OVER
let roundOverStartTime = 0; // Date.now() when ROUND_OVER started (for pause math)
let roundOverPauseRemaining = 0; // ms remaining when paused during ROUND_OVER
let animFrameId = null;
let isPaused = false;
let isMuted = false;
let collisionTiles = []; // [{x, y}] for crash effect rendering
let collisionTime = 0; // timestamp of collision for effect timing

// Powerup state
let powerups = []; // [{type, x, y}] active powerups on the grid
let playerEffects = [
  {
    shield: false,
    speedRemaining: 0,
    slowRemaining: 0,
    invincibleRemaining: 0,
  },
  {
    shield: false,
    speedRemaining: 0,
    slowRemaining: 0,
    invincibleRemaining: 0,
  },
];
let powerupSpawnTimer = null;
let gameStarted = false;
let testMode = false; // hidden single-player test mode

// ─── Audio Manager (Web Audio API) ───────────────────────────

/**
 * All game audio is synthesised via the Web Audio API.
 * No external audio files are needed.
 *
 * Sounds:
 * - Engine hum: two detuned sawtooth oscillators per player, low-pass filtered
 * - Countdown beep: short sine blip, higher pitch on "GO!"
 * - Crash: noise burst + low thump
 * - Match fanfare: ascending sine arpeggio
 */
const GameAudio = (() => {
  let audioCtx = null;
  let masterGain = null;
  let engineNodes = []; // [{osc1, osc2, gain}] per player

  function ensureCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null; // Browser doesn't support Web Audio
      try {
        audioCtx = new Ctx();
        masterGain = audioCtx.createGain();
        masterGain.connect(audioCtx.destination);
        masterGain.gain.value = isMuted ? 0 : 1;
      } catch (e) {
        console.warn("Failed to create AudioContext:", e);
        return null;
      }
    }
    // Handle browser autoplay policy
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function setMuted(muted) {
    if (masterGain && audioCtx) {
      try {
        masterGain.gain.setTargetAtTime(
          muted ? 0 : 1,
          audioCtx.currentTime,
          0.05,
        );
      } catch (_) {}
    }
  }

  // ── Engine hum ──────────────────────────────────────────
  function startEngineHum() {
    const ctx = ensureCtx();
    if (!ctx) return;
    stopEngineHum(); // clean up any previous

    const freqs = [80, 100]; // different pitch per player
    engineNodes = freqs.map((freq) => {
      const gain = ctx.createGain();
      gain.gain.value = 0.06;
      gain.connect(masterGain);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 300;
      filter.connect(gain);

      const osc1 = ctx.createOscillator();
      osc1.type = "sawtooth";
      osc1.frequency.value = freq;
      osc1.connect(filter);
      osc1.start();

      const osc2 = ctx.createOscillator();
      osc2.type = "sawtooth";
      osc2.frequency.value = freq * 1.01; // slight detune for richness
      osc2.connect(filter);
      osc2.start();

      return { osc1, osc2, gain, filter };
    });
  }

  function stopEngineHum() {
    for (const node of engineNodes) {
      try {
        node.osc1.stop();
        node.osc2.stop();
        node.gain.disconnect();
      } catch (_) {}
    }
    engineNodes = [];
  }

  // ── Countdown beep ─────────────────────────────────────
  function playCountdownBeep(isGo) {
    const ctx = ensureCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = isGo ? 880 : 440;
    gain.gain.value = 0.2;
    gain.gain.setTargetAtTime(0, ctx.currentTime + (isGo ? 0.25 : 0.15), 0.05);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start();
    osc.stop(ctx.currentTime + (isGo ? 0.35 : 0.25));
  }

  // ── Crash sound ────────────────────────────────────────
  function playCrash() {
    const ctx = ensureCtx();
    if (!ctx) return;

    // Noise burst
    const bufferSize = ctx.sampleRate * 0.3;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.3;
    noiseGain.gain.setTargetAtTime(0, ctx.currentTime + 0.05, 0.08);
    noise.connect(noiseGain);
    noiseGain.connect(masterGain);
    noise.start();
    noise.stop(ctx.currentTime + 0.3);

    // Low thump
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 60;
    osc.frequency.setTargetAtTime(20, ctx.currentTime, 0.1);
    const thumpGain = ctx.createGain();
    thumpGain.gain.value = 0.4;
    thumpGain.gain.setTargetAtTime(0, ctx.currentTime + 0.1, 0.08);
    osc.connect(thumpGain);
    thumpGain.connect(masterGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  }

  // ── Match fanfare ──────────────────────────────────────
  function playFanfare() {
    const ctx = ensureCtx();
    if (!ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(0.15, ctx.currentTime + i * 0.15, 0.02);
      gain.gain.setTargetAtTime(0, ctx.currentTime + i * 0.15 + 0.2, 0.08);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.5);
    });
  }

  // ── Round-start tone ───────────────────────────────────
  function playRoundStart() {
    playCountdownBeep(true);
  }

  // ── Powerup pickup ──────────────────────────────────
  function playPickup() {
    const ctx = ensureCtx();
    if (!ctx) return;
    const notes = [660, 880];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = 0.15;
      gain.gain.setTargetAtTime(0, ctx.currentTime + i * 0.08 + 0.08, 0.03);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(ctx.currentTime + i * 0.08);
      osc.stop(ctx.currentTime + i * 0.08 + 0.15);
    });
  }

  // ── Shield break ────────────────────────────────────
  function playShieldBreak() {
    const ctx = ensureCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 300;
    osc.frequency.setTargetAtTime(100, ctx.currentTime, 0.15);
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    gain.gain.setTargetAtTime(0, ctx.currentTime + 0.15, 0.06);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  }

  return {
    ensureCtx,
    setMuted,
    startEngineHum,
    stopEngineHum,
    playCountdownBeep,
    playCrash,
    playFanfare,
    playRoundStart,
    playPickup,
    playShieldBreak,
  };
})();

// Ensure AudioContext is created on first user interaction (autoplay policy)
document.addEventListener("click", () => GameAudio.ensureCtx(), { once: true });
document.addEventListener("keydown", () => GameAudio.ensureCtx(), {
  once: true,
});

// ─── State Machine ───────────────────────────────────────────

/**
 * Transition to a new game state.
 * Validates the transition, runs exit logic for the old state,
 * sets the new state, and runs enter logic for the new state.
 */
function setState(newState) {
  const allowed = VALID_TRANSITIONS[gameState];
  if (!allowed || !allowed.has(newState)) {
    console.warn(`Invalid state transition: ${gameState} → ${newState}`);
    return;
  }

  // ── Exit hooks for the old state ──
  switch (gameState) {
    case STATE.COUNTDOWN:
      clearInterval(countdownTimer);
      countdownTimer = null;
      hideMessage(countdownEl);
      break;
    case STATE.PLAYING:
      clearInterval(tickTimer);
      tickTimer = null;
      // Clear any pending input buffers so stale inputs don't carry over
      for (const p of players) {
        p.nextDirection = null;
      }
      GameAudio.stopEngineHum();
      stopPowerupSpawning();
      break;
    case STATE.ROUND_OVER:
      clearTimeout(roundOverTimeout);
      roundOverTimeout = null;
      hideMessage(roundResultEl);
      break;
    case STATE.MATCH_OVER:
      hideMessage(matchResultEl);
      break;
  }

  const prevState = gameState;
  gameState = newState;

  // ── Enter hooks for the new state ──
  switch (gameState) {
    case STATE.COUNTDOWN:
      countdownValue = CONFIG.countdownDuration;
      showMessage(countdownEl, countdownValue);
      GameAudio.playCountdownBeep(false);
      startCountdownTimer();
      break;
    case STATE.PLAYING:
      GameAudio.startEngineHum();
      startTickLoop();
      startPowerupSpawning();
      break;
    case STATE.ROUND_OVER:
      collisionTime = performance.now();
      roundOverStartTime = Date.now();
      roundOverPauseRemaining = CONFIG.roundOverPause;
      // Auto-advance after pause
      roundOverTimeout = setTimeout(() => {
        const p1Dead = players[0].lives <= 0;
        const p2Dead = players[1].lives <= 0;
        if (p1Dead || p2Dead) {
          endMatch();
        } else {
          startRound();
        }
      }, CONFIG.roundOverPause);
      break;
    case STATE.MATCH_OVER: {
      let winnerText;
      if (players[0].lives <= 0 && players[1].lives <= 0) {
        winnerText = "DRAW!";
      } else if (players[0].lives > 0) {
        winnerText = "PLAYER 1 WINS!";
      } else {
        winnerText = "PLAYER 2 WINS!";
      }
      matchWinnerTextEl.textContent = winnerText;
      matchResultEl.classList.remove("hidden");
      GameAudio.playFanfare();
      break;
    }
  }
}

// ─── Canvas Sizing ───────────────────────────────────────────
let tileSize = 0;
let dpr = 1;

function resizeCanvas() {
  const aspectRatio = CONFIG.aspectRatio;
  const maxW = window.innerWidth;
  const maxH = window.innerHeight;

  let w, h;
  if (maxW / maxH > aspectRatio) {
    h = maxH;
    w = h * aspectRatio;
  } else {
    w = maxW;
    h = w / aspectRatio;
  }

  // Use devicePixelRatio for sharp rendering on retina displays
  dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";

  // Scale the context so all drawing code uses CSS-pixel coordinates
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  tileSize = w / CONFIG.gridWidth;
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ─── Player Factory ──────────────────────────────────────────
function createPlayer(id, spawnX, spawnY, startDir, color, colorDim) {
  return {
    id,
    x: spawnX,
    y: spawnY,
    direction: startDir,
    nextDirection: null, // buffered input
    color,
    colorDim,
    alive: true,
    lives: CONFIG.livesPerPlayer,
  };
}

// ─── Grid Helpers ────────────────────────────────────────────
function initGrid() {
  grid = [];
  for (let x = 0; x < CONFIG.gridWidth; x++) {
    grid[x] = new Array(CONFIG.gridHeight).fill(0);
  }
}

// ─── Powerup System ──────────────────────────────────────

const POWERUP_VISUALS = {
  SPEED: { color: "#ffff00", symbol: "⚡" },
  SHIELD: { color: "#00ff00", symbol: "🛡" },
  CLEAR: { color: "#ff00ff", symbol: "💥" },
  SLOW: { color: "#00ccff", symbol: "🐢" },
};

function spawnPowerup() {
  if (powerups.length >= CONFIG.powerupMaxOnGrid) return;
  // Collect empty cells away from borders and bikes
  const emptyCells = [];
  for (let x = 2; x < CONFIG.gridWidth - 2; x++) {
    for (let y = 2; y < CONFIG.gridHeight - 2; y++) {
      if (grid[x][y] !== 0) continue;
      let tooClose = false;
      for (const p of players) {
        if (Math.abs(p.x - x) <= 3 && Math.abs(p.y - y) <= 3) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      if (powerups.some((pu) => pu.x === x && pu.y === y)) continue;
      emptyCells.push({ x, y });
    }
  }
  if (emptyCells.length === 0) return;
  const cell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
  const type =
    CONFIG.powerupTypes[Math.floor(Math.random() * CONFIG.powerupTypes.length)];
  powerups.push({ type, x: cell.x, y: cell.y });
}

function collectPowerup(playerIndex, powerupIndex) {
  const pu = powerups[powerupIndex];
  GameAudio.playPickup();
  switch (pu.type) {
    case "SPEED":
      playerEffects[playerIndex].speedRemaining = CONFIG.powerupSpeedDuration;
      break;
    case "SHIELD":
      playerEffects[playerIndex].shield = true;
      break;
    case "SLOW": {
      const oppIdx2 = playerIndex === 0 ? 1 : 0;
      playerEffects[oppIdx2].slowRemaining = CONFIG.powerupSlowDuration;
      break;
    }
    case "CLEAR": {
      const opponentId = playerIndex === 0 ? 2 : 1;
      const oppIdx = playerIndex === 0 ? 1 : 0;
      const trailTiles = [];
      for (let x = 0; x < CONFIG.gridWidth; x++) {
        for (let y = 0; y < CONFIG.gridHeight; y++) {
          if (grid[x][y] === opponentId) {
            if (x !== players[oppIdx].x || y !== players[oppIdx].y) {
              trailTiles.push({ x, y });
            }
          }
        }
      }
      const toRemove = Math.ceil(
        trailTiles.length * CONFIG.powerupClearFraction,
      );
      for (let i = 0; i < toRemove && trailTiles.length > 0; i++) {
        const idx = Math.floor(Math.random() * trailTiles.length);
        const tile = trailTiles.splice(idx, 1)[0];
        grid[tile.x][tile.y] = 0;
      }
      break;
    }
  }
  powerups.splice(powerupIndex, 1);
}

function startPowerupSpawning() {
  stopPowerupSpawning();
  powerupSpawnTimer = setInterval(() => {
    if (gameState === STATE.PLAYING && !isPaused) {
      spawnPowerup();
    }
  }, CONFIG.powerupSpawnInterval);
}

function stopPowerupSpawning() {
  if (powerupSpawnTimer) {
    clearInterval(powerupSpawnTimer);
    powerupSpawnTimer = null;
  }
}

function clearAllPowerups() {
  powerups = [];
  for (let i = 0; i < 2; i++) {
    playerEffects[i] = {
      shield: false,
      speedRemaining: 0,
      slowRemaining: 0,
      invincibleRemaining: 0,
    };
  }
  stopPowerupSpawning();
}

function renderEffectIcons() {
  [p1Effects, p2Effects].forEach((container, idx) => {
    container.innerHTML = "";
    if (playerEffects[idx].shield) {
      const span = document.createElement("span");
      span.className = "effect-icon";
      span.textContent = "🛡";
      container.appendChild(span);
    }
    if (playerEffects[idx].speedRemaining > 0) {
      const span = document.createElement("span");
      span.className = "effect-icon";
      span.textContent = "⚡";
      container.appendChild(span);
    }
    if (playerEffects[idx].slowRemaining > 0) {
      const span = document.createElement("span");
      span.className = "effect-icon";
      span.textContent = "🐢";
      container.appendChild(span);
    }
    if (playerEffects[idx].invincibleRemaining > 0) {
      const span = document.createElement("span");
      span.className = "effect-icon";
      span.textContent = "✨";
      container.appendChild(span);
    }
  });
}

// ─── HUD Helpers ─────────────────────────────────────────────
function renderLives() {
  [p1LivesIcons, p2LivesIcons].forEach((container, idx) => {
    const player = players[idx];
    container.innerHTML = "";
    for (let i = 0; i < CONFIG.livesPerPlayer; i++) {
      const pip = document.createElement("div");
      pip.className = "life-pip" + (i >= player.lives ? " lost" : "");
      container.appendChild(pip);
    }
  });
}

function showMessage(el, text) {
  el.textContent = text != null ? String(text) : "";
  el.classList.remove("hidden");
}

function hideMessage(el) {
  el.classList.add("hidden");
}

function hideAllMessages() {
  hideMessage(countdownEl);
  hideMessage(roundResultEl);
  hideMessage(matchResultEl);
}

// ─── Input Handling ──────────────────────────────────────────
const KEY_MAP_P1 = {
  KeyW: "UP",
  KeyS: "DOWN",
  KeyA: "LEFT",
  KeyD: "RIGHT",
};

const KEY_MAP_P2 = {
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
};

/**
 * Central keydown handler.
 * - Ignores held-down auto-repeat events so each physical press
 *   registers exactly once.
 * - Prevents browser default on all mapped game keys.
 * - Routes direction keys to the correct player's input buffer.
 * - Global actions (mute, restart) are handled regardless of player.
 */
function handleKeyDown(e) {
  // Ignore auto-repeat (held key) — only react to the initial press
  if (e.repeat) return;

  const isP1Key = e.code in KEY_MAP_P1;
  const isP2Key = e.code in KEY_MAP_P2;

  // Prevent default for all game movement keys (arrows scroll, some
  // browsers react to W/S for find-in-page etc.)
  if (isP1Key || isP2Key) {
    e.preventDefault();
  }

  // Mute toggle — always available
  if (e.code === "KeyM") {
    toggleMute();
    return;
  }

  // Pause toggle — available during gameplay
  if (e.code === "KeyP" || e.code === "Escape") {
    if (gameStarted && gameState !== STATE.MATCH_OVER && gameState !== null) {
      togglePause();
      return;
    }
  }

  // Start screen — Shift+T activates hidden test mode
  if (!gameStarted && e.code === "KeyT" && e.shiftKey) {
    e.preventDefault();
    testMode = true;
    beginGame();
    return;
  }

  // Start screen — Enter starts the game
  if (!gameStarted && (e.code === "Enter" || e.code === "Space")) {
    e.preventDefault();
    testMode = false;
    beginGame();
    return;
  }

  // Restart during MATCH_OVER
  if (
    gameState === STATE.MATCH_OVER &&
    (e.code === "Enter" || e.code === "Space")
  ) {
    restartMatch();
    return;
  }

  // Player 1 direction input
  if (isP1Key) {
    bufferInput(players[0], KEY_MAP_P1[e.code]);
  }

  // Player 2 direction input
  if (isP2Key) {
    bufferInput(players[1], KEY_MAP_P2[e.code]);
  }
}

/**
 * Buffer a direction input for a player.
 *
 * Rules (per README spec):
 * 1. Only accepted during COUNTDOWN (pre-buffered for when play starts)
 *    or PLAYING.
 * 2. Ignored while the game is paused.
 * 3. 180° reversals are rejected — cannot reverse into current direction
 *    OR into an already-buffered direction (prevents rapid tap reversals
 *    like RIGHT → DOWN → UP where UP is opposite of the pending DOWN).
 * 4. Only one input is stored per tick (first-valid wins). This prevents
 *    180° turns via rapid double-tapping within a single tick.
 */
function bufferInput(player, newDir) {
  if (!player || !player.alive) return;
  // Only during active game phases
  if (gameState !== STATE.PLAYING && gameState !== STATE.COUNTDOWN) return;
  // Ignore while paused
  if (isPaused) return;
  // Reject 180° reversal against current direction
  if (OPPOSITE[newDir] === player.direction) return;
  // Reject 180° reversal against already-buffered direction
  if (
    player.nextDirection !== null &&
    OPPOSITE[newDir] === player.nextDirection
  )
    return;
  // First valid input per tick wins — do not overwrite
  if (player.nextDirection === null) {
    player.nextDirection = newDir;
  }
}

window.addEventListener("keydown", handleKeyDown);

// ─── Mute Toggle ─────────────────────────────────────────────
function toggleMute() {
  isMuted = !isMuted;
  muteIcon.textContent = isMuted ? "🔇" : "🔊";
  muteBtn.classList.toggle("muted", isMuted);
  GameAudio.setMuted(isMuted);
}

muteBtn.addEventListener("click", toggleMute);

// ─── Pause Toggle ───────────────────────────────────────
function togglePause() {
  if (isPaused) {
    resumeGame();
  } else {
    pauseGame();
  }
}

pauseBtn.addEventListener("click", togglePause);

// ─── Focus / Blur (Pause) ────────────────────────────────────
function onVisibilityChange() {
  if (document.hidden) {
    pauseGame();
  } else {
    resumeGame();
  }
}

function pauseGame() {
  if (isPaused) return;
  isPaused = true;
  // Freeze all timers — they will be restarted on resume
  clearInterval(tickTimer);
  tickTimer = null;
  clearInterval(countdownTimer);
  countdownTimer = null;
  clearInterval(powerupSpawnTimer);
  powerupSpawnTimer = null;
  // Pause the round-over timeout by recording remaining time
  if (roundOverTimeout) {
    clearTimeout(roundOverTimeout);
    roundOverTimeout = null;
    // Store elapsed so we can resume with the right remaining delay
    roundOverPauseRemaining =
      CONFIG.roundOverPause - (Date.now() - roundOverStartTime);
    if (roundOverPauseRemaining < 0) roundOverPauseRemaining = 0;
  }
  pauseOverlay.classList.remove("hidden");
  pauseIcon.textContent = "▶";
}

function resumeGame() {
  if (!isPaused) return;
  isPaused = false;
  pauseOverlay.classList.add("hidden");
  pauseIcon.textContent = "⏸";
  // Restart the appropriate timer for the current state
  switch (gameState) {
    case STATE.PLAYING:
      startTickLoop();
      startPowerupSpawning();
      break;
    case STATE.COUNTDOWN:
      startCountdownTimer();
      break;
    case STATE.ROUND_OVER:
      // Resume roundOverTimeout with remaining time
      if (roundOverPauseRemaining > 0) {
        roundOverStartTime = Date.now();
        roundOverTimeout = setTimeout(() => {
          const p1Dead = players[0].lives <= 0;
          const p2Dead = players[1].lives <= 0;
          if (p1Dead || p2Dead) {
            endMatch();
          } else {
            startRound();
          }
        }, roundOverPauseRemaining);
      }
      break;
  }
}

document.addEventListener("visibilitychange", onVisibilityChange);
// Defer blur/focus listeners — attach after a short delay so the
// game doesn't immediately pause on page load if the window
// doesn't yet have focus (common with file:// opens, dev tools, etc.)
setTimeout(() => {
  window.addEventListener("blur", pauseGame);
  window.addEventListener("focus", resumeGame);
}, 1000);

// ─── Game State Transitions ──────────────────────────────────

/**
 * Initialise a brand-new match: create players, reset lives, start first round.
 * Called at boot and on explicit restart.
 */
function initMatch() {
  // Force state to null so the first setState(COUNTDOWN) is valid
  gameState = null;

  // Clean up any lingering timers from a previous match
  clearInterval(tickTimer);
  tickTimer = null;
  clearInterval(countdownTimer);
  countdownTimer = null;
  clearTimeout(roundOverTimeout);
  roundOverTimeout = null;

  players = [
    createPlayer(
      1,
      SPAWN.p1.x,
      SPAWN.p1.y,
      SPAWN.p1.direction,
      CONFIG.p1Color,
      CONFIG.p1ColorDim,
    ),
    createPlayer(
      2,
      SPAWN.p2.x,
      SPAWN.p2.y,
      SPAWN.p2.direction,
      CONFIG.p2Color,
      CONFIG.p2ColorDim,
    ),
  ];

  // In test mode, player 2 is inactive
  if (testMode) {
    players[1].alive = false;
  }

  clearAllPowerups();
  renderLives();
  startRound();
}

/**
 * Reset arena and player positions for a new round, then begin countdown.
 */
function startRound() {
  // Reset grid & player positions
  initGrid();

  const spawns = [SPAWN.p1, SPAWN.p2];
  for (let i = 0; i < 2; i++) {
    players[i].x = spawns[i].x;
    players[i].y = spawns[i].y;
    players[i].direction = spawns[i].direction;
    players[i].nextDirection = null;
    players[i].alive = testMode && i === 1 ? false : true;
    // Mark spawn tile (skip for inactive test-mode player)
    if (players[i].alive) {
      grid[spawns[i].x][spawns[i].y] = i + 1;
    }
  }

  collisionTiles = [];
  collisionTime = 0;
  powerups = [];
  for (let i = 0; i < 2; i++) {
    playerEffects[i] = {
      shield: false,
      speedRemaining: 0,
      slowRemaining: 0,
      invincibleRemaining: 0,
    };
  }
  renderEffectIcons();

  hideAllMessages();

  // Transition → COUNTDOWN (enter hook starts the countdown timer & UI)
  setState(STATE.COUNTDOWN);
}

/**
 * Internal: start the 1-second countdown interval.
 * Called from setState enter hook and from resumeGame.
 */
function startCountdownTimer() {
  countdownTimer = setInterval(() => {
    countdownValue--;
    if (countdownValue > 0) {
      showMessage(countdownEl, countdownValue);
      GameAudio.playCountdownBeep(false);
    } else if (countdownValue === 0) {
      showMessage(countdownEl, "GO!");
      GameAudio.playCountdownBeep(true);
    } else {
      // Countdown finished → transition to PLAYING
      setState(STATE.PLAYING);
    }
  }, 1000);
}

/**
 * Internal: start the fixed-step game tick interval.
 * Called from setState enter hook and from resumeGame.
 */
function startTickLoop() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(gameTick, CONFIG.tickInterval);
}

/**
 * End the current round after a collision.
 * Deducts lives, shows result, triggers transition to ROUND_OVER.
 */
function endRound(message) {
  GameAudio.playCrash();
  showMessage(roundResultEl, message);
  renderLives();

  // Transition → ROUND_OVER (enter hook sets crash timer & auto-advance timeout)
  setState(STATE.ROUND_OVER);
}

/**
 * Transition to MATCH_OVER after a player has lost all lives.
 */
function endMatch() {
  setState(STATE.MATCH_OVER);
}

/**
 * Fully reset and start a new match.
 */
function restartMatch() {
  hideAllMessages();
  initMatch();
}

restartBtn.addEventListener("click", restartMatch);

// ─── Game Tick (Fixed Step) ──────────────────────────────────

/**
 * Attempt to move players and check for collisions.
 * p1Moves/p2Moves indicate whether each player should move this step.
 * Returns true if the round ended (crash), false otherwise.
 */
function moveStep(p1Moves, p2Moves) {
  const newPositions = players.map((p, i) => {
    const shouldMove = i === 0 ? p1Moves : p2Moves;
    if (shouldMove && p.alive) {
      return {
        x: p.x + DIR[p.direction].x,
        y: p.y + DIR[p.direction].y,
        moved: true,
      };
    }
    return { x: p.x, y: p.y, moved: false };
  });

  const crashed = [false, false];
  const wallCrash = [false, false]; // border crashes can't be absorbed

  for (let i = 0; i < 2; i++) {
    if (!newPositions[i].moved) continue;
    const nx = newPositions[i].x;
    const ny = newPositions[i].y;

    if (nx < 0 || nx >= CONFIG.gridWidth || ny < 0 || ny >= CONFIG.gridHeight) {
      crashed[i] = true;
      wallCrash[i] = true;
      continue;
    }
    if (grid[nx][ny] !== 0) {
      crashed[i] = true;
    }
  }

  // Head-on collision: same destination tile (only if both moved)
  if (newPositions[0].moved && newPositions[1].moved) {
    if (
      newPositions[0].x === newPositions[1].x &&
      newPositions[0].y === newPositions[1].y
    ) {
      crashed[0] = true;
      crashed[1] = true;
    }
    // Bikes swap tiles (crossed paths)
    if (
      newPositions[0].x === players[1].x &&
      newPositions[0].y === players[1].y &&
      newPositions[1].x === players[0].x &&
      newPositions[1].y === players[0].y
    ) {
      crashed[0] = true;
      crashed[1] = true;
    }
  }

  // Shield / invincibility absorption: negate trail crashes (not wall crashes)
  for (let i = 0; i < 2; i++) {
    if (crashed[i] && wallCrash[i]) continue; // walls always kill
    if (crashed[i] && playerEffects[i].invincibleRemaining > 0) {
      crashed[i] = false;
      newPositions[i].phaseThrough = true;
    } else if (crashed[i] && playerEffects[i].shield) {
      playerEffects[i].shield = false;
      crashed[i] = false;
      playerEffects[i].invincibleRemaining = CONFIG.powerupShieldInvincibility;
      newPositions[i].phaseThrough = true;
      GameAudio.playShieldBreak();
      renderEffectIcons();
    }
  }

  // Record collision tiles for crash FX
  collisionTiles = [];
  for (let i = 0; i < 2; i++) {
    if (crashed[i]) {
      collisionTiles.push({
        x: newPositions[i].x,
        y: newPositions[i].y,
        player: i + 1,
      });
    }
  }

  // If any crash happened, resolve round
  if (crashed[0] || crashed[1]) {
    if (crashed[0]) players[0].lives--;
    if (crashed[1]) players[1].lives--;

    let message;
    if (crashed[0] && crashed[1]) {
      message = "BOTH CRASH!";
    } else if (crashed[0]) {
      message = "PLAYER 1 CRASHES!";
    } else {
      message = "PLAYER 2 CRASHES!";
    }

    // In test mode, only end round when player 1 crashes
    if (testMode && !crashed[0]) return false;

    endRound(message);
    return true;
  }

  // Move bikes & lay trail
  for (let i = 0; i < 2; i++) {
    if (!newPositions[i].moved) continue;
    players[i].x = newPositions[i].x;
    players[i].y = newPositions[i].y;
    // Don't lay trail on tiles we're phasing through (invincibility)
    if (!newPositions[i].phaseThrough) {
      grid[newPositions[i].x][newPositions[i].y] = i + 1;
    }

    // Check powerup collection (3x3 hitbox to match visual size)
    for (let j = powerups.length - 1; j >= 0; j--) {
      const dx = Math.abs(powerups[j].x - players[i].x);
      const dy = Math.abs(powerups[j].y - players[i].y);
      if (dx <= 1 && dy <= 1) {
        collectPowerup(i, j);
        renderEffectIcons();
        break;
      }
    }
  }

  return false;
}

function gameTick() {
  if (gameState !== STATE.PLAYING) return;

  // Apply buffered input
  for (const p of players) {
    if (p.nextDirection !== null) {
      p.direction = p.nextDirection;
      p.nextDirection = null;
    }
  }

  // Decrement effect timers
  for (let i = 0; i < 2; i++) {
    if (playerEffects[i].speedRemaining > 0) {
      playerEffects[i].speedRemaining--;
      if (playerEffects[i].speedRemaining <= 0) {
        renderEffectIcons();
      }
    }
    if (playerEffects[i].slowRemaining > 0) {
      playerEffects[i].slowRemaining--;
      if (playerEffects[i].slowRemaining <= 0) {
        renderEffectIcons();
      }
    }
    if (playerEffects[i].invincibleRemaining > 0) {
      playerEffects[i].invincibleRemaining--;
      if (playerEffects[i].invincibleRemaining <= 0) {
        renderEffectIcons();
      }
    }
  }

  // Slowed players move only every 3rd tick (1/3 speed)
  const p1Slow = playerEffects[0].slowRemaining > 0;
  const p2Slow = playerEffects[1].slowRemaining > 0;
  const p1Moves = !(p1Slow && playerEffects[0].slowRemaining % 3 !== 0);
  const p2Moves = !(p2Slow && playerEffects[1].slowRemaining % 3 !== 0);

  // Normal move (skipped for slowed players on even ticks)
  if (moveStep(p1Moves, p2Moves)) return;

  // Extra move for speed-boosted players (only if not slowed)
  const p1Speed = playerEffects[0].speedRemaining > 0 && !p1Slow;
  const p2Speed = playerEffects[1].speedRemaining > 0 && !p2Slow;
  if (p1Speed || p2Speed) {
    moveStep(p1Speed, p2Speed);
  }
}

// ─── Render Loop (60 FPS) ────────────────────────────────────

function render() {
  animFrameId = requestAnimationFrame(render);

  // Use CSS-pixel dimensions (ctx is pre-scaled by DPR)
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const ts = tileSize;

  // ── 1. Background ──────────────────────────────────────
  ctx.fillStyle = CONFIG.bgColor;
  ctx.fillRect(0, 0, w, h);

  // ── 2. Subtle grid lines ───────────────────────────────
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= CONFIG.gridWidth; x++) {
    ctx.beginPath();
    ctx.moveTo(x * ts, 0);
    ctx.lineTo(x * ts, h);
    ctx.stroke();
  }
  for (let y = 0; y <= CONFIG.gridHeight; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * ts);
    ctx.lineTo(w, y * ts);
    ctx.stroke();
  }
  ctx.restore();

  // ── 3. Arena border (neon glow) ────────────────────────
  ctx.save();
  ctx.shadowColor = CONFIG.borderColor;
  ctx.shadowBlur = CONFIG.borderGlowBlur;
  ctx.strokeStyle = CONFIG.borderColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
  // Double-stroke for extra glow
  ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.restore();

  // ── 4. Trails ──────────────────────────────────────────
  // Batch by player colour to minimise state changes
  ctx.save();
  ctx.shadowBlur = CONFIG.trailGlowBlur;

  // Player 1 trails
  ctx.shadowColor = CONFIG.p1Color;
  ctx.fillStyle = CONFIG.p1ColorDim;
  for (let x = 0; x < CONFIG.gridWidth; x++) {
    for (let y = 0; y < CONFIG.gridHeight; y++) {
      if (grid[x][y] === 1) {
        ctx.fillRect(x * ts, y * ts, ts, ts);
      }
    }
  }

  // Player 2 trails
  ctx.shadowColor = CONFIG.p2Color;
  ctx.fillStyle = CONFIG.p2ColorDim;
  for (let x = 0; x < CONFIG.gridWidth; x++) {
    for (let y = 0; y < CONFIG.gridHeight; y++) {
      if (grid[x][y] === 2) {
        ctx.fillRect(x * ts, y * ts, ts, ts);
      }
    }
  }
  ctx.restore();

  // ── 4b. Powerups ───────────────────────────────────────
  if (powerups.length > 0) {
    const now = performance.now();
    ctx.save();
    for (const pu of powerups) {
      const vis = POWERUP_VISUALS[pu.type];
      const pulse = 0.65 + 0.35 * Math.sin(now / 200);
      ctx.shadowColor = vis.color;
      ctx.shadowBlur = 12 * pulse;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = vis.color;
      ctx.fillRect(
        (pu.x - 1) * ts + ts * 0.1,
        (pu.y - 1) * ts + ts * 0.1,
        ts * 3 - ts * 0.2,
        ts * 3 - ts * 0.2,
      );
      ctx.globalAlpha = 1;
      // Symbol
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#000";
      ctx.font = `${Math.floor(ts * 1.6)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(vis.symbol, pu.x * ts + ts / 2, pu.y * ts + ts / 2 + 1);
    }
    ctx.restore();
  }

  // ── 5. Bikes ───────────────────────────────────────────
  ctx.save();
  ctx.shadowBlur = CONFIG.bikeGlowBlur;
  for (const p of players) {
    if (!p.alive && gameState !== STATE.ROUND_OVER) continue;

    const bx = p.x * ts;
    const by = p.y * ts;

    // Outer glow
    ctx.shadowColor = p.color;
    ctx.fillStyle = p.color;
    ctx.fillRect(bx, by, ts, ts);

    // Bright centre (makes bike stand out from trail)
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    const inset = ts * 0.25;
    ctx.fillRect(bx + inset, by + inset, ts - inset * 2, ts - inset * 2);
    ctx.shadowBlur = CONFIG.bikeGlowBlur;
  }
  ctx.restore();

  // ── 5b. Shield / speed aura ──────────────────────────
  ctx.save();
  for (let i = 0; i < 2; i++) {
    const p = players[i];
    if (!p.alive && gameState !== STATE.ROUND_OVER) continue;
    const bx = p.x * ts;
    const by = p.y * ts;
    if (playerEffects[i].shield) {
      ctx.strokeStyle = "#00ff00";
      ctx.shadowColor = "#00ff00";
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx - 2, by - 2, ts + 4, ts + 4);
    }
    if (playerEffects[i].speedRemaining > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 100);
      ctx.strokeStyle = `rgba(255, 255, 0, ${pulse})`;
      ctx.shadowColor = "#ffff00";
      ctx.shadowBlur = 8;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx - 3, by - 3, ts + 6, ts + 6);
    }
    if (playerEffects[i].slowRemaining > 0) {
      const pulse = 0.4 + 0.6 * Math.sin(performance.now() / 300);
      ctx.strokeStyle = `rgba(0, 204, 255, ${pulse})`;
      ctx.shadowColor = "#00ccff";
      ctx.shadowBlur = 8;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx - 4, by - 4, ts + 8, ts + 8);
    }
    if (playerEffects[i].invincibleRemaining > 0) {
      // Flashing white outline during invincibility
      const flash = Math.sin(performance.now() / 50) > 0 ? 1 : 0.2;
      ctx.strokeStyle = `rgba(255, 255, 255, ${flash})`;
      ctx.shadowColor = "#ffffff";
      ctx.shadowBlur = 14;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(bx - 5, by - 5, ts + 10, ts + 10);
    }
  }
  ctx.restore();

  // ── 6. Crash flash effect ──────────────────────────────
  if (gameState === STATE.ROUND_OVER && collisionTiles.length > 0) {
    const elapsed = performance.now() - collisionTime;
    const duration = CONFIG.crashEffectDuration;
    if (elapsed < duration) {
      const progress = elapsed / duration;
      const alpha = 1 - progress;
      const radius = ts * 2 + progress * ts * 6;

      ctx.save();
      for (const ct of collisionTiles) {
        // Clamp to canvas bounds for out-of-bounds crashes
        const cx = Math.max(0, Math.min(ct.x * ts + ts / 2, w));
        const cy = Math.max(0, Math.min(ct.y * ts + ts / 2, h));

        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        gradient.addColorStop(0.3, `rgba(255, 200, 50, ${alpha * 0.7})`);
        gradient.addColorStop(0.6, `rgba(255, 80, 30, ${alpha * 0.4})`);
        gradient.addColorStop(1, "rgba(255, 50, 50, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      }
      ctx.restore();

      // Screen flash overlay (brief white flash)
      if (elapsed < 80) {
        ctx.save();
        ctx.fillStyle = `rgba(255, 255, 255, ${0.3 * (1 - elapsed / 80)})`;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
  }

  // ── 7. Scanline overlay (subtle CRT effect) ────────────
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.04)";
  for (let y = 0; y < h; y += 3) {
    ctx.fillRect(0, y, w, 1);
  }
  ctx.restore();
}

// ─── Start Screen & Boot ─────────────────────────────────────

function beginGame() {
  if (gameStarted) return;
  gameStarted = true;
  startScreen.classList.add("hidden");
  initMatch();
}

startBtn.addEventListener("click", () => {
  testMode = false;
  beginGame();
});

try {
  // Show start screen and start the render loop (grid is empty until game starts)
  initGrid();
  players = [
    createPlayer(
      1,
      SPAWN.p1.x,
      SPAWN.p1.y,
      SPAWN.p1.direction,
      CONFIG.p1Color,
      CONFIG.p1ColorDim,
    ),
    createPlayer(
      2,
      SPAWN.p2.x,
      SPAWN.p2.y,
      SPAWN.p2.direction,
      CONFIG.p2Color,
      CONFIG.p2ColorDim,
    ),
  ];
  render(); // Start render loop (draws the empty arena behind the start screen)
} catch (e) {
  console.error("TRON boot failed:", e);
  // Show error on screen as fallback
  const errDiv = document.createElement("div");
  errDiv.style.cssText =
    "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
    "color:#ff4444;font:bold 20px monospace;text-align:center;z-index:999;";
  errDiv.textContent =
    "Game failed to start. Check console. Error: " + e.message;
  document.body.appendChild(errDiv);
}
