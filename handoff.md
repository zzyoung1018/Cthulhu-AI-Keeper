# DM Online Handoff

Last updated: 2026-06-16 00:00 CST

## Current State

- Local repo: `/Users/young/Documents/dm online`
- Deployed app: `http://8.153.147.137`
- Server app path: `/opt/dm-online`
- SSH endpoint: `root@8.153.147.137 -p 2233`
- Service: `dm-online` managed by systemd
- Reverse proxy: Nginx
- Database: SQLite, server runtime data under `/opt/dm-online/data`
- Local branch: `main`
- Latest deployed commit: `0a94f99 fix: strip AI-generated check markers before injecting backend markers`
- Local worktree is clean.

Do not write server credentials into committed files. Use the conversation context or ask the user if credentials are needed again.

## Recent Commits

- `0a94f99` fix: strip AI-generated check markers before injecting backend markers
- `652a60d` fix: skip processed actions in latestPlayerAction to prevent check re-inference loop
- `0ec6d12` docs: refresh handoff after ai detection deployment
- `6546044` fix: make deployment audit summary assertion stable
- `e58f148` fix: expand ai detection diagnostics
- `0a732a7` chore: checkpoint before ai detection expansion
- `0c4067c` fix: stabilize continuation rollback and ai events
- `3028b48` docs: update handoff notes with session refactor details
- `2e1d80d` refactor: remove dead code, fix double normalization, extract aiEvents module

## Code Map

```text
src/
  app.js           (1026 lines) — HTTP routes, room lifecycle, AI orchestration
  aiOutput.js      (~1200 lines) — AI JSON extraction, validation, detection inference
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
  aiOutput.test.mjs         (~560 lines) — parser/validator/inference regressions
  app.test.mjs              (446 lines) — API integration tests
  db.test.mjs               (735 lines) — persistence tests
  fixtures/
    comprehensive-test-module.json — reusable CoC 7e test module
```

## What Was Just Finished (2026-06-15 Session)

### Fix: Continue Loop — Check Re-inference (`652a60d`)

**Problem**: Clicking `继续叙事` after a check result caused the same check to trigger again, creating an infinite loop.

**Root cause**: The `/continue` endpoint does not create a new player ACTION message. `latestPlayerAction()` in `aiOutput.js` kept finding the *original* ACTION (e.g., "我谎称自己是陈友的远房亲戚"), and `classifyOpposedAction` kept re-matching it — every round, forever.

**Fix** (`src/aiOutput.js` `latestPlayerAction`): After finding the latest ACTION, check whether a DM reply or check system message already exists after it. If so, the action has been processed — return `null` to skip inference.

```js
// Pseudocode for the fix:
const action = findLatestAction(messages);
const alreadyProcessed = messagesAfter(action).some(m =>
  m.authorType === 'dm' ||
  (m.authorType === 'system' && ['对抗检定', '必要检定'].includes(m.displayName))
);
if (alreadyProcessed) return null;  // skip inference
```

This means:
- First AI round (no DM after action yet): inference works normally ✓
- Continue round (DM + check messages already after action): inference skipped ✓
- New player ACTION (no DM after this new action yet): inference works again ✓

### Fix: Duplicate Check Markers (`0a94f99`)

**Problem**: AI model sometimes writes `（此处触发XX检定...。）` in its narrative text. The backend's `sanitizeNarrative` then injects its own marker. Result: two visible markers, one actual check.

**Fix** (`src/aiOutput.js` `sanitizeNarrative`): Added a regex clean step at the start — strips any AI-generated markers matching `（此处触发[^）]*?检定[^）]*?。）` before the backend injects its own unified marker.

```js
const AI_CHECK_MARKER = /（此处触发[^）]*?检定[^）]*?。）\s*/g;
let text = String(narrative || '').replace(AI_CHECK_MARKER, '').trim();
```

## Existing Features Reference

### Continue After Checks

The frontend shows a `继续叙事` button after required/opposed check system messages when the room is ACTIVE and no AI task is running.

Backend behavior:
- `POST /api/rooms/:code/continue` with `checkMessageId`
- Idempotency key: `continue:<checkMessageId>`
- Does **not** create a visible player ACTION message
- Adds system instruction: "本轮是检定结果后的继续叙事，必须根据最近的骰子结果推进"
- Recent check JSON is included in AI context via `summarizeRecentCheckRolls()`
- **Important**: `latestPlayerAction` now skips already-processed actions, preventing the re-inference loop

### AI Detection Logic (`src/aiOutput.js`)

**Opposed checks** (9 rules, takes priority over required):

| Type | activeSkill | passiveSkill | Trigger keywords |
|------|-------------|--------------|-----------------|
| social | 话术 | 心理学 | 撒谎, 说谎, 骗, 忽悠, 假装, 冒充, 套话 |
| social | 说服 | 心理学 | 说服, 劝说, 请求, 交涉, 谈判, 打动 |
| social | 恐吓 | 心理学 | 恐吓, 威胁, 吓唬, 逼问, 震慑, 拔刀 |
| social | 魅惑 | 心理学 | 魅惑, 讨好, 套近乎, 献殷勤, 寒暄 |
| stealth | 潜行 | 侦查 | 潜行, 偷偷, 悄悄, 跟踪, 溜进, 潜入 |
| stealth | 妙手 | 侦查 | 偷, 扒, 摸走, 顺走, 悄悄拿 |
| stealth | 乔装 | 心理学 | 乔装, 易容, 伪装成, 扮成, 假扮 |
| combat | 格斗 | 闪避 | 攻击, 偷袭, 刺杀, 挥拳, 打, 砍, 制服 |
| combat | 射击 | 闪避 | 射击, 开枪, 枪击, 手枪, 步枪, 瞄准 |

**Required checks** (19 rules, plus module-defined):

| Skill | Difficulty | Trigger keywords |
|-------|-----------|-----------------|
| 图书馆使用 | REGULAR | 查资料, 查阅, 翻阅, 档案, 卷宗, 报纸 |
| 侦查 | REGULAR | 侦查, 观察, 搜索, 搜查, 翻找, 打量 |
| 聆听 | REGULAR | 聆听, 倾听, 听声音, 脚步, 动静 |
| 会计/锁匠/急救/医学/驾驶汽车/攀爬/跳跃/投掷/追踪/神秘学/法律/估价/导航/博物学/机械维修/电气维修/化学/物理学/药学 | varies | see `REQUIRED_CHECK_DETECTION_RULES` |

**Special rules**:
- `isNpcOnlyObservation`: Actions that only observe an NPC reaction (e.g., "我看看陈友的脸色") are NOT inferred as 侦查 checks
- `classifyModuleRequiredAction`: Module-defined checks are matched before generic rules (trigger text overlap, skill mention, scene match, CJK bigram)
- Priority: opposed actions drop any model-provided required_checks

### Structured Event Application (`src/aiEvents.js`)

Factory pattern: `createEventApplier({ database, hub, addAiLog })` returns `{ applyStructuredEvents }`.

- required_checks → server-side skill/attribute rolls, system messages
- opposed_checks → contested rolls (player vs NPC), NPC skill from `moduleJson.npcs` when available
- proposed_state_changes → whitelisted status/characteristic paths only
- clues_revealed → system messages (with optional privateTarget)
- scene_change → scene state update + system message
- npc_state_changes → NPC state messages (disposition, location, isPresent)
- summary_update → trusted as replacement summary

### Rollback

AI rounds tracked by task UID. `POST /api/rooms/:code/rollback/:roundId` restores:
- Character snapshots (sheet + revision)
- Story summary
- Scene state
- Marks round and messages as rolled back

## Verification

Local:
```bash
npm run check   # passed
npm test        # 101/101 passed
```

Server:
```bash
cd /opt/dm-online && npm install && npm test   # 101/101 passed, 0 vulnerabilities
systemctl restart dm-online
curl -fsS http://127.0.0.1:4173/api/health     # ok: true, aiConfigured: true
systemctl is-active dm-online                    # active
nginx -t                                         # successful
```

Public deployment audit:
```bash
npm run audit:deployment -- http://8.153.147.137
# ok: true, aiConfigured: true

npm run audit:deployment -- --require-ai http://8.153.147.137
# ok: true, aiConfigured: true, strictAi: true
```

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
sshpass -e ssh -p 2233 -o StrictHostKeyChecking=no root@8.153.147.137 \
  'cd /opt/dm-online && npm install && npm test'

sshpass -e ssh -p 2233 -o StrictHostKeyChecking=no root@8.153.147.137 \
  'systemctl restart dm-online && sleep 2 && curl -fsS http://127.0.0.1:4173/api/health; echo; systemctl is-active dm-online; nginx -t'
```

Public audit after restart (increased timeout for slow AI):
```bash
DEPLOYMENT_AUDIT_AI_TIMEOUT_MS=180000 npm run audit:deployment -- --require-ai http://8.153.147.137
```

## Notes For Next Agent

- User prefers autonomous implementation, testing, deployment, and log inspection.
- Always run tests before and after changes (`npm test`).
- Keep doing checkpoint commits before substantial changes.
- Do not overwrite unrelated user changes if the worktree is dirty.
- Do not commit secrets.
- Preserve server `.env`, `data/`, and runtime database during rsync.
- The test fixture `test/fixtures/comprehensive-test-module.json` can be uploaded via the API to manually test AI detection in a real room.
- If changing AI detection, add regression tests in `test/aiOutput.test.mjs` and/or `test/comprehensive-ai.test.mjs`.
- When debugging game sessions, request the JSON export (`GET /api/rooms/:code/export?format=json`) to see messages, diceRolls, and aiTasks in context.
- The AI detection log endpoint (`GET /api/rooms/:code/ai-log`) is owner-only and shows raw event parsing diagnostics.
- `latestPlayerAction` now returns `null` for already-processed actions — if AI check inference stops working unexpectedly for new actions, check this function first.

## Potential Follow-Ups

- Add end-to-end frontend tests for `继续叙事` button and `检测日志` dialog.
- Cache NPC candidates per room (currently rebuilt every AI call in `npcCandidates()`).
- Add TTL-based eviction for `_aiLogs` map.
- Split `db.js` (1246 lines) into schema / row-mappers / queries.
- Split `public/app.js` (2106 lines) into lobby / character / chat modules.
- Add structured event support for clue-state updates so successful module checks can auto-mark clues discovered.
- Tune module check matching with real playtest logs from `reports/`.
