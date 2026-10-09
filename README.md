# Clash Royale Bot (Decisions API + ADB)

Battle loop that captures the Android screen over ADB, asks the OpenAI **Decisions API** (`gpt-6-luna`) which action to take, and — when launching a card — asks again **where** to place it using named tactical zones.

## Flow

1. `adb exec-out screencap -p`
2. Resize / JPEG compress
3. **Decision 1** — `choice`: `wait` | `card_1`…`card_4` (+ `in_battle` predicate, `elixir` score)
4. If a card was chosen → **Decision 2** — `choice` among placement zones
5. `adb shell input swipe` from card slot → zone
6. Sleep until `BATTLE_LOOP_TOOL_CALL_MS` since tick start, then repeat

## Setup

```bash
cp .env.example .env
# set OPENAI_API_KEY (and optionally ADB_SERIAL)

npm install
adb devices   # phone unlocked, USB debugging on, Clash Royale open
```

### Calibrate layout

Coordinates in `src/layout.ts` are normalized **0..1** of the full screen.

```bash
npm run calibrate
# prints a coord table + writes debug/calibration.png
# green = hand slots, blue = placement zones
```

Adjust until green dots sit in the **center** of each card:

| Dot is… | Change |
| --- | --- |
| too high | increase `y` |
| too low | decrease `y` |
| too left | increase `x` |
| too right | decrease `x` |

Then smoke-test without the AI:

```bash
npm run test-launch -- card_2 left_bridge
```

### Run

```bash
# Safe: decide + log, no taps
DRY_RUN=true npm start

# Live
npm start
```

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required |
| `DECISIONS_MODEL` | `gpt-6-luna` | Decisions model |
| `BATTLE_LOOP_TOOL_CALL_MS` | `1500` | Min ms between ticks |
| `ADB_SERIAL` | empty | Pin device when several are connected |
| `MIN_ACTION_CONFIDENCE` | `0.5` | Below → treat as wait |
| `MIN_PLACEMENT_CONFIDENCE` | `0.4` | Below → fallback/cancel |
| `LOW_CONFIDENCE_PLACEMENT` | `fallback` | `fallback` or `cancel` |
| `SCREENSHOT_MAX_WIDTH` | `720` | Resize before API |
| `SWIPE_DURATION_MS` | `120` | Drag duration |
| `DRY_RUN` | `false` | Log only |
| `DEBUG_SAVE_FRAMES` | `false` | Save JPEGs under `debug/frames/` |

## Warning

Automating Clash Royale can violate Supercell's Terms of Service and risk bans. Prefer a secondary account and friendly / training battles.
