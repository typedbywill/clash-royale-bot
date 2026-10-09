# Clash Royale Bot (Planner + Perception + ADB)

Battle loop that captures the Android screen over ADB, **perceives** the board with the OpenAI Decisions API, keeps a modeled game state (elixir, hand cycle, threats), runs an async **planner** (Responses API) that thinks like a pro, and an **executor** that fires plays on an 18×32 arena grid — including led spell aims.

## Architecture

1. `adb` screencap (raw RGBA preferred)
2. Resize / JPEG compress
3. **Perception** (Decisions API every tick) — hand card IDs, elixir, phase, lane threats, coarse push/cluster cells, tower flags
4. **GameState** — elixir model, cycle rotation, memory
5. **Planner** (Responses API, ~every 5s / on events) — structured plan with triggers + matchup memory
6. **Executor** — plan steps, reactive counters from `deck.json`, spell lead, elixir gate
7. **Memory** — on battle end, debrief persists enemy style/strategy under `memory/`
8. `adb` tap/swipe/drag to deploy

### Opponent memory

After each battle the bot writes:

- `memory/battles/<id>.json` — per-match report (enemy cards, style, lessons, result)
- `memory/matchups/<fingerprint>.json` — aggregated tips keyed by enemy deck fingerprint

The planner loads the best matching matchup (exact fingerprint or ≥4 card overlap) and uses `counterStrategy` / `lessons` next time.

To “forget” everything: `rm -rf memory/`.

### Card wiki

[`wiki/cards.json`](wiki/cards.json) holds strengths, weaknesses, counters and tips per card. Each planner call loads a **dynamic slice**: all of *your* deck cards + whatever enemy cards have been confirmed this battle (plus cross-match tips like “vs Balloon → Mega Minion”).

Add new enemy cards to that file anytime — no code change needed.

## Setup

```bash
cp .env.example .env
# set OPENAI_API_KEY

# Edit deck.json with YOUR 8 cards (roles, costs, spell radius/travelMs, counters)
npm install
adb devices   # phone unlocked, USB debugging on, Clash Royale open
```

### Deck knowledge

The bot does not guess unknown cards. Put your ladder deck in [`deck.json`](deck.json):

- `archetype` / `gameplan` — how a pro plays it
- `cards[]` — id, name, elixir, type, roles, usage, preferred tiles; spells need `radius`, `travelMs`, `minValueElixir`
- `reactiveCounters[]` — emergency defenses when the planner is stale
- `phases` — notes for single / double / overtime

### Calibrate layout

```bash
npm run calibrate
# writes debug/calibration.png
# green = hand slots, red = arena bounds, orange = tile grid, blue = shortcuts
```

| Adjust | Where |
| --- | --- |
| Hand slot dots | `src/layout.ts` → `CARD_SLOTS` |
| Arena rectangle | `.env` → `ARENA_BOUNDS=left,top,right,bottom` |

Smoke test without AI:

```bash
npm run test-launch -- card_2 left_bridge
npm run test-launch -- card_1 tile:9,22
```

### Run

```bash
DRY_RUN=true npm start   # perceive + plan + log, no taps
npm start
```

## Env (high-signal)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required |
| `DECISIONS_MODEL` | `gpt-6-luna` | Fast perception |
| `PLANNER_MODEL` | `gpt-5.4-mini` | Reasoning planner |
| `PLANNER_INTERVAL_MS` | `5000` | Min planner refresh |
| `DECK_FILE` | `deck.json` | Deck knowledge |
| `MEMORY_DIR` | `memory` | Battle + matchup persistence |
| `WIKI_FILE` | `wiki/cards.json` | Card strengths / counters wiki |
| `ARENA_BOUNDS` | `0.08,0.12,0.92,0.78` | Playable grass rect |
| `SCREENCAP_FORMAT` | `raw` | `raw` or `png` |
| `BATTLE_LOOP_TOOL_CALL_MS` | `1500` | Min ms between ticks |
| `LAUNCH_METHOD` | `tap` | `tap` / `swipe` / `drag` |
| `DRY_RUN` | `false` | Log only |
| `DEBUG_TICK_LOG` | `true` | JSONL under `debug/ticks/` |

## Warning

Automating Clash Royale can violate Supercell's Terms of Service and risk bans. Prefer a secondary account and friendly / training battles.
