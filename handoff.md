# DM Online Handoff

Last updated: 2026-06-15 19:44 CST

## Current State

- Local repo: `/Users/young/Documents/dm online`
- Deployed app: `http://8.153.147.137`
- Server app path: `/opt/dm-online`
- SSH endpoint: `root@8.153.147.137 -p 2233`
- Service: `dm-online` managed by systemd
- Reverse proxy: Nginx
- Database: SQLite, server runtime data under `/opt/dm-online/data`
- Local branch: `main`
- Latest functional/deployed code commit: `6546044 fix: make deployment audit summary assertion stable`
- Latest deployed app content includes `6546044` and `e58f148`
- Local worktree was clean after deployment before this handoff update.

Do not write server credentials into committed files. Use the conversation context or ask the user if credentials are needed again.

## Recent Commits

- `6546044` fix: make deployment audit summary assertion stable
- `e58f148` fix: expand ai detection diagnostics
- `0a732a7` chore: checkpoint before ai detection expansion
- `0c4067c` fix: stabilize continuation rollback and ai events
- `04fb838` chore: checkpoint before stability fixes
- `3028b48` docs: update handoff notes with session refactor details
- `2e1d80d` refactor: remove dead code, fix double normalization, extract aiEvents module

## Code Map

```text
src/
  app.js           (1026 lines) — HTTP routes, room lifecycle, AI orchestration
  aiOutput.js      (1177 lines) — AI JSON extraction, validation, detection inference
  aiEvents.js       (381 lines) — applies AI structured events to rolls/state/summary
  aiClient.js       (261 lines) — streaming client and AI context assembly
  prompts.js        (243 lines) — system/user/structured-output prompts
  db.js            (1246 lines) — SQLite schema, migrations, row mappers, queries
  character.js      (368 lines) — CoC 7e sheet normalization and skill lookup
  dice.js           (441 lines) — CoC 7e dice, checks, opposed checks, luck/pushed rolls
  moduleParser.js   (347 lines) — JSON module validation and segment extraction
  playerState.js    (123 lines) — structured player state sent to AI
  rounds.js          (77 lines) — AI round snapshots and rollback
  privateHub.js      (63 lines) — player-specific SSE delivery

public/
  app.js          (2106 lines) — main frontend logic

test/
  comprehensive-ai.test.mjs (702 lines) — full AI detection and event coverage
  aiOutput.test.mjs         (520 lines) — parser/validator/inference regressions
  app.test.mjs              (446 lines) — API integration tests
  db.test.mjs               (735 lines) — persistence tests
```

## What Was Just Finished

### AI Detection Expansion (`e58f148`)

Backend detection now covers more ordinary CoC skill checks, not just 侦查/聆听/图书馆使用.

New generic required-check rules include:

- 会计
- 锁匠
- 急救
- 医学
- 驾驶汽车
- 攀爬
- 跳跃
- 投掷
- 追踪
- 神秘学
- 法律
- 估价
- 导航
- 博物学
- 机械维修
- 电气维修
- 化学
- 物理学
- 药学

Existing opposed checks still take priority over required checks:

- 社交：话术/说服/恐吓/魅惑 vs NPC 心理学
- 潜行：潜行/妙手/乔装 vs NPC 侦查/聆听/心理学
- 战斗：格斗/射击 vs NPC 闪避/侦查

### Module JSON Check Matching

`src/aiOutput.js` now tries `roomState.moduleJson.checks` before generic required-check rules.

Important details:

- Match uses trigger text, skill mentions, generic same-skill hits, current scene, and CJK bigram overlap.
- Secret-ish `success` / `failure` / `ai_dm_instruction` text can add a small overlap score, but cannot be the only anchor.
- A module check must be anchored by trigger overlap/exact match, explicit skill mention, or a generic same-skill rule.
- Module matches add detection metadata:
  - `source: "module"`
  - `moduleCheckId`
  - `moduleSceneId`
  - confidence score
  - notes such as `trigger-overlap`, `generic-same-skill`, `scene-match`
- Player-facing system messages do not expose module `ai_dm_instruction`; they use a generic safe hint.

### False Positive Reduction

The backend now avoids inferring 侦查 when a player only observes an NPC reaction, for example:

```text
我看看陈友的脸色和反应。
```

This should not become a required 侦查 check. Actual environment/object searches still trigger checks:

```text
我检查前台登记簿。
我搜索房间和抽屉。
```

### Recent Check Results In AI Context

`src/aiClient.js` now summarizes recent relevant dice rolls and passes them into `buildDmUserContext`.

Supported recent roll types:

- `skill_check`
- `coc_check`
- `contested_check`
- `opposed_check`
- `pushed_check`
- `luck_spend`

The prompt now includes:

```text
最近检定结果（JSON，继续叙事必须依据这些结果，不要重复同一检定）
```

The structured-output prompt also tells the AI that when the recent action is “继续”, it must use `passed` / `winner` from that JSON and must not repeat the same required/opposed check.

### AI Detection Logs

There is now a room-owner-only detection log UI:

- Frontend button: `检测日志`
- Dialog: `#aiLogDialog`
- Backend route: `GET /api/rooms/:code/ai-log?playerId=...`
- Permission: only `room.ownerPlayerId` can view it.

The log shows:

- AI task UID
- structured-event keys
- rejected keys and validation issues
- dropped required checks for opposed actions
- inferred detection notes
- detection source/rule/skill/target/confidence
- raw response snippet

Test coverage includes owner-only access.

### Deployment Audit Fix (`6546044`)

The public audit script used to write a summary containing “审计房间” and then assert that exact phrase after AI generation. That was brittle because AI `summary_update` can validly replace the summary.

Now the script:

- Verifies manual summary persistence immediately after writing it.
- After AI completion, only requires final summary to be non-empty.
- Still supports strict AI mode with `--require-ai`.

## Earlier Important Fixes Still In Place

### Continue After Checks

The frontend shows a `继续叙事` control after required/opposed check system messages when the room is ACTIVE and no AI task is running.

Current backend behavior:

- Uses `/api/rooms/:code/continue`.
- Queues an AI task with idempotency key `continue:<checkMessageId>`.
- Does **not** create a visible player ACTION message.
- Adds a system instruction: this is “检定结果后的继续叙事”.
- Recent check JSON is included in the AI context.

### Rollback Stability

AI rounds are tracked by task UID. Rollback restores:

- character snapshots
- story summary
- scene state
- messages/rolls from the rolled-back round

Runtime character state changes preserve ready flag/history.

### AI Event Application

`src/aiEvents.js` applies validated structured events:

- required checks become server-side rolls and system messages
- opposed checks use player skill and NPC skill
- NPC skill lookup uses `moduleJson.npcs` when available
- scene changes update scene state
- summary updates are applied once and trusted as replacement summary
- state changes only allow whitelisted status/characteristic paths

## Verification Already Run

Local:

```bash
npm run check
npm test
# 100/100 passed
```

Server:

```bash
cd /opt/dm-online && npm install && npm test
# 100/100 passed, 0 vulnerabilities
```

Service and proxy:

```bash
curl -fsS http://127.0.0.1:4173/api/health
# {"ok":true,"aiConfigured":true,"localFallback":false,...}

systemctl is-active dm-online
# active

nginx -t
# successful
```

Public deployment audit:

```bash
npm run audit:deployment -- http://8.153.147.137
# ok: true, aiConfigured: true, dmMessageId: 435

npm run audit:deployment -- --require-ai http://8.153.147.137
# ok: true, aiConfigured: true, strictAi: true, dmMessageId: 446
```

Browser static verification:

- `#btnAiLog` exists with text `检测日志`.
- `#aiLogDialog` and `#aiLogBody` exist.
- Button is initially hidden before room context.
- No browser console errors on local page load.

## Deployment Commands

From local repo:

```bash
export SSHPASS='<password>'

sshpass -e rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude '.env' \
  -e 'ssh -p 2233 -o StrictHostKeyChecking=no' \
  ./ root@8.153.147.137:/opt/dm-online/
```

Then on server:

```bash
export SSHPASS='<password>'

sshpass -e ssh -p 2233 -o StrictHostKeyChecking=no root@8.153.147.137 \
  'cd /opt/dm-online && npm install && npm test'

sshpass -e ssh -p 2233 -o StrictHostKeyChecking=no root@8.153.147.137 \
  'systemctl restart dm-online && sleep 2 && curl -fsS http://127.0.0.1:4173/api/health; echo; systemctl is-active dm-online; nginx -t'
```

Public audit after restart:

```bash
DEPLOYMENT_AUDIT_AI_TIMEOUT_MS=180000 npm run audit:deployment -- --require-ai http://8.153.147.137
```

## Notes For Next Agent

- User prefers autonomous implementation, testing, deployment, and log inspection.
- Keep doing checkpoint commits before substantial changes.
- Use `apply_patch` for manual edits.
- Do not overwrite unrelated user changes if the worktree is dirty.
- Do not commit secrets.
- Preserve server `.env`, `data/`, and runtime database during rsync.
- The test fixture `test/fixtures/comprehensive-test-module.json` is useful for AI detection/manual room tests.
- If changing AI detection, add regression tests in `test/aiOutput.test.mjs` and/or `test/comprehensive-ai.test.mjs`.
- If changing deployed behavior, run both local and server tests, restart systemd, check health, check Nginx, then run public audit.

## Potential Follow-Ups

- Add a true end-to-end frontend test for `继续叙事` button visibility and click behavior.
- Add a true end-to-end frontend test for the owner-only `检测日志` dialog after an AI round.
- Show detection log summaries in a more compact owner dashboard, not just a modal.
- Add TTL-based eviction for `_aiLogs` map beyond existing room lifecycle cleanup.
- Tune module check matching with more real playtest logs from `reports/`.
- Add structured event support for clue-state updates, so successful module checks can mark clues discovered automatically.
- Split `db.js` and `public/app.js` when the next feature touches them heavily.
