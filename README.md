# TRON Light Cycles — 2D Arcade Game

A simplified 2-player local multiplayer replica of the classic TRON Light Cycles arcade game, built for the web.

---

## Overview

Two players compete on a fixed 2D arena. Each player controls a "light cycle" that moves continuously and leaves a permanent glowing wall trail behind it. The goal is to force your opponent into crashing while surviving as long as possible. A player loses a life when they crash. The last player with lives remaining wins the match.

---

## Gameplay

### Core Loop

1. Both players spawn at opposite sides of the arena and begin moving immediately.
2. Each bike moves at a constant speed and cannot stop.
3. As each bike moves, it leaves a solid, permanent trail (wall) behind it.
4. A round ends the moment a collision is detected.
5. Lives are deducted on collision. A new round begins after a short intermission.
6. The match ends when one player has lost all their lives.

### Winning & Losing

- Each player starts with **2 lives**.
- A player **loses a life** when their bike collides with:
  - The arena border
  - Their own trail
  - The opponent's trail
  - The opponent's bike directly (head-on counts as both players losing a life)
- The player who still has lives remaining when their opponent reaches 0 wins the match.
- If both players crash simultaneously in the same frame, both lose a life.

---

## Controls

| Action        | Player 1 | Player 2        |
|---------------|----------|-----------------|
| Move Up       | `W`      | `Arrow Up`      |
| Move Down     | `S`      | `Arrow Down`    |
| Move Left     | `A`      | `Arrow Left`    |
| Move Right    | `D`      | `Arrow Right`   |

### Control Rules

- A player cannot reverse direction (e.g. moving right, then immediately pressing left). The input is ignored.
- Inputs are buffered so a quick direction tap is not dropped between game ticks.
- Only one direction change is applied per game tick to prevent 180° reversals through rapid double-tapping.

---

## Arena

- Fixed rectangular grid arena.
- A clearly visible border wall surrounds the entire arena. Hitting it is fatal.
- The arena is the same for every round and every match — no procedural generation.
- The grid is tile-based internally, but rendered smoothly (pixel-level rendering is acceptable).

---

## Visuals & Audio

### Visual Style

- Dark background (black or very dark navy) evoking the TRON aesthetic.
- Player 1 trail and bike: **cyan / electric blue**.
- Player 2 trail and bike: **orange / yellow**.
- Trails should glow (CSS box-shadow or canvas glow effect).
- The arena border should be a bright, glowing line consistent with the neon aesthetic.
- On collision/death, play a brief **explosion or crash flash effect** on the tile(s) where the collision occurred.
- A short **countdown animation** (e.g. 3… 2… 1… GO!) is shown at the start of each round before bikes begin moving.

### HUD

- Display each player's remaining lives clearly on screen during gameplay (e.g. top-left for P1, top-right for P2).
- Display a round result message after each round (e.g. "Player 1 crashes!", "Draw!", "Player 1 Wins the Match!").
- Display a match winner screen when the match concludes, with an option to **restart** (keyboard shortcut + on-screen button).

### Audio

- Looping engine hum for each bike while alive (distinct pitch or tone per player).
- A crash/explosion sound on death.
- A round-start sound or tone.
- A match-winner fanfare or sound.
- All audio should be optional — include a **mute toggle** (e.g. `M` key or on-screen button).
- Audio should be synthesised (Web Audio API) or use small royalty-free sound assets. Do not rely on external CDN audio files.

---

## Game States

The game should flow through these states:

```
COUNTDOWN → PLAYING → ROUND_OVER → (next round or) MATCH_OVER → (restart)
```

| State        | Description                                                                 |
|--------------|-----------------------------------------------------------------------------|
| `COUNTDOWN`  | 3-second countdown before each round. Bikes are positioned but not moving.  |
| `PLAYING`    | Active gameplay. Bikes move, trails grow, collisions are checked.           |
| `ROUND_OVER` | Collision detected. Show result briefly. Deduct life. Pause ~2 seconds.     |
| `MATCH_OVER` | A player has 0 lives. Show match winner. Offer restart.                     |

---

## Technical Requirements

- Built with **HTML5 Canvas** or a lightweight web game framework (e.g. plain JS + Canvas, or Phaser 3).
- No backend required — fully client-side.
- No external dependencies beyond a single chosen rendering framework (if any).
- Runs in a modern desktop browser (Chrome, Firefox, Safari, Edge).
- Target a stable **~60 FPS** using `requestAnimationFrame`.
- Game logic (bike movement, collision detection) should run on a fixed game tick rate (e.g. every 100ms), independent of render rate, to ensure fairness and consistency.
- The canvas/arena should be **responsive to window size** but maintain a fixed aspect ratio. It should fill the available viewport without overflowing.
- All game code should be in a single self-contained HTML file **or** a clean, minimal project structure (e.g. `index.html`, `game.js`, `style.css`).

---

## Spawn Positions & Round Reset

- Player 1 spawns on the **left side** of the arena, facing right.
- Player 2 spawns on the **right side** of the arena, facing left.
- Spawn positions are centred vertically.
- All trails are **cleared** at the start of each new round.
- Bikes resume from their default spawn positions each round (not where they died).

---

## Edge Cases to Handle

- **Simultaneous collision**: Both players crash on the same tick → both lose a life.
- **Head-on collision**: Bikes meet head-to-head → both lose a life.
- **180° direction reversal**: Ignore any input that would reverse the bike's current direction.
- **Rapid input buffering**: If a player presses two keys quickly between ticks, only the first valid input is applied that tick.
- **Window blur**: Pause or freeze the game loop if the browser window loses focus. Resume when focus returns.
- **Restart mid-match**: Pressing the restart key during `MATCH_OVER` fully resets all lives, trails, and scores.

---

## Out of Scope (for this version)

- Main menu or title screen
- Single-player / AI opponent
- Multiple levels or arena layouts
- Online / networked multiplayer
- Player customisation (name, colour selection)
- Persistent high scores or leaderboards
- Power-ups or speed boosts
- Mobile / touch controls
