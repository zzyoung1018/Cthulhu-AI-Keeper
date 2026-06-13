# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / Test / Run

```bash
npm install               # Install dependencies
npm test                  # Run test suite (node --test)
npm start                 # Start server on configured host:port
npm run check             # Syntax check all JS and MJS files
```

Copy `.env.example` → `.env` before first run. A fallback AI generates placeholder streaming text so the full flow works without external API keys.

```bash
npm run audit:deployment -- http://<host>           # Audit a deployed instance
npm run audit:deployment -- http://<host> --require-ai  # Require real AI (no fallback)
```

## Architecture

**Runtime**: Node 22.5+ ESM (`"type": "module"`). Zero external dependencies — uses only Node.js built-ins (`node:http`, `node:sqlite`, `node:fs`, `node:crypto`, etc.).

**Server**: `src/server.js` loads config, calls `createApp()` from `src/app.js`, and wires SIGINT/SIGTERM graceful shutdown (draining connections, closing database).

**HTTP routing** (`src/app.js`, `src/http.js`): All requests flow through a single `createServer` handler. The URL path is split into segments; `/api/*` routes are dispatched in `handleApi()`. Everything else is served as a static file from `public/`. JSON request body size is capped at 1 MiB.

**Database** (`src/db.js`): SQLite via `node:sqlite`'s `DatabaseSync`. WAL mode, foreign keys on. Migrations are additive — `hasColumn()` checks precede each `ALTER TABLE` addition. An `ensureRoom()` pattern throws `HttpError` early when a room doesn't exist. Writes use `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` in a `transaction()` helper.

**Real-time events** (`src/sse.js`): `RoomEventHub` manages per-room SSE subscribers. `broadcast()` sends to every connected client in a room. The SSE endpoint at `GET /api/rooms/{code}/events` requires a `playerId` query param and the player must be in the room. Heartbeats every 25s keep connections alive.

**AI DM flow** (`src/app.js`, `src/aiClient.js`, `src/aiQueue.js`):
1. A player sends an `ACTION` message (or sets `submitToDm: true`) while the room is `ACTIVE`
2. The message is persisted; an `ai_task` row is created with an idempotency key (based on `actionId` or message ID) to prevent double-submission
3. The task is enqueued into a per-room serial queue (`RoomAiQueue` — chains promises so only one AI call runs per room at a time)
4. The task generates context by: fetching room state → scoring and ranking module segments by relevance to recent chat → building `system`/`user` messages via `buildDmMessages()`
5. Streaming begins: a DM message is created with `status: "streaming"`, chunks are SSE-broadcast to the room via `message_delta` events, and the message content is persisted every ~750ms
6. On completion, the DM message is marked `complete` and a `message_completed` event fires. On error or cancellation, the DM message is marked `error` with the error text appended.

**AI settings** (`src/aiSettings.js`): AI configuration exists at two layers — global (`.env`) and per-room (`rooms.ai_config_json`). `roomRuntimeAiConfig()` merges them: room overrides win, global fills in gaps. The API key is never returned to clients (`publicAiSettings` strips it, exposing only `apiKeyConfigured: true/false`).

**Character sheets** (`src/character.js`): Call of Cthulhu 7e character model with characteristics (STR/CON/SIZ/DEX/APP/INT/POW/EDU/Luck), skills, weapons, investigator metadata, and text fields (equipment, beliefs, etc.). `diffCharacterSheets()` produces a flat diff for the `character_history` table. `summarizeCharacterSheet()` generates a compact text representation fed into the AI prompt.

**Dice** (`src/dice.js`): CoC 7e dice mechanics — d100 with bonus/penalty dice, success levels (CRITICAL/EXTREME/HARD/REGULAR/FAIL/FUMBLE), difficulty-based pass/fail, sanity loss rolls. Also supports generic `NdM±X` expressions.

**Module upload** (`src/moduleParser.js`, `src/multipart.js`): TXT, PDF, and DOCX files up to 12 MiB. PDF text extracted by scanning raw PDF operators (`Tj`/`TJ`). DOCX via ZIP entry extraction from `word/document.xml`. Multipart parsing is handwritten (no `busboy`/`multer`). Text is segmented by headings/markdown headers into ≤1800-char chunks (max 400 segments), scored against recent chat for AI context relevance.

**API summary** (`src/app.js` `handleApi`):
- `GET /api/health` — health check with AI config status
- `POST /api/rooms` — create room (requires a parsed module owned by the creator)
- `GET /api/rooms/{code}` — full room state
- `POST /api/rooms/{code}/join` — join during PREPARING (max 5 players)
- `PATCH /api/rooms/{code}/status` — owner transitions room (PREPARING→ACTIVE requires all players ready with character)
- `PATCH /api/rooms/{code}/character` — update character sheet
- `PATCH /api/rooms/{code}/profile` — update profile
- `PATCH /api/rooms/{code}/ready` — toggle ready status
- `PATCH /api/rooms/{code}/summary` — update story summary
- `PATCH /api/rooms/{code}/ai-config` — room-level AI settings
- `POST /api/rooms/{code}/messages` — send player message (ACTION triggers AI)
- `POST /api/rooms/{code}/rolls` — roll dice
- `POST /api/rooms/{code}/ai-tasks/{uid}/cancel` — cancel AI task (owner only)
- `POST /api/rooms/{code}/ai-tasks/{uid}/regenerate` — re-run AI (owner only)
- `GET /api/rooms/{code}/events` — SSE stream
- `GET /api/rooms/{code}/character/history` — character sheet change log
- `POST /api/modules` — upload a module file
- `GET /api/modules` — list player's modules
- `GET /api/modules/{id}/preview` — module details with text and segments

**Frontend** (`public/`): Single-page app with vanilla JS (`app.js`), raw HTML (`index.html`), and CSS (`styles.css`). Communicates via `fetch` to the JSON API and `EventSource` for SSE.

**Deployment** (`deploy/`): `install_server.sh` installs Node 22, Nginx, sets up a systemd service (`dm-online.service`), and configures Nginx as reverse proxy. `configure_ai.sh` securely writes AI credentials to `/etc/dm-online.env`.

**Error handling** (`src/errors.js`): `HttpError(statusCode, message)` thrown anywhere in route handlers; caught at the top-level `createServer` handler and serialized via `sendError()`. 500s are logged to stderr; client-safe messages are truncated to 220 chars.
