# DM Online Handoff

Last updated: 2026-06-17 12:39 CST

## Current State

- Local repo: `/Users/young/Documents/dm online`
- Deployed app: `http://8.153.147.137`
- Server app path: `/opt/dm-online`
- SSH endpoint: `root@8.153.147.137 -p 2233`
- Service: `dm-online` managed by systemd
- Reverse proxy: Nginx
- Database: SQLite, server runtime data under `/var/lib/dm-online`
- Local branch: `main`
- Latest completed local app commit: `5055948 fix: harden ai checks and rollback side effects`
- Latest deployed app commit: `5055948 fix: harden ai checks and rollback side effects`
- Deployment verified on 2026-06-16 23:10 CST: systemd active, Nginx config OK, `/api/health` OK, public deployment audit OK.
- Local worktree is clean.

Do not write server credentials into committed files. Use the conversation context or ask the user if credentials are needed again.

## Recent App Commits

- `5055948` fix: harden ai checks and rollback side effects
- `da39b3e` chore: checkpoint before bug optimization pass
- `3d3817f` docs: update handoff after ai preflight checks
- `9a89c6a` feat: add ai preflight check validation
- `158b688` chore: checkpoint before ai preflight checks
- `a9fc6aa` docs: update handoff after bug audit
- `96d8f3d` fix: validate private message targets
- `ee06284` chore: checkpoint before bug audit fixes
- `d8e23d6` docs: update handoff after deployment and e2e work
- `9a6ab9b` feat: improve ai log tools and frontend coverage
- `01a7d1d` chore: checkpoint before e2e and log upgrades
- `d419174` docs: update handoff after quick send
- `e38928d` feat: add chat quick send shortcut

## Code Map

```text
src/
  app.js           (1147 lines) — HTTP routes, room lifecycle, AI orchestration
  aiOutput.js      (1676 lines) — AI JSON extraction, validation, detection inference
  aiEvents.js       (566 lines) — applies AI structured events to rolls/state/summary
  aiClient.js       (430 lines) — streaming client and scene-aware AI context assembly
  prompts.js        (250 lines) — system/user/structured-output prompts
  db.js            (1360 lines) — SQLite schema, migrations, row mappers, queries
  character.js      (368 lines) — CoC 7e sheet normalization and skill lookup
  dice.js           (441 lines) — CoC 7e dice, checks, opposed checks, luck/pushed rolls
  moduleParser.js   (347 lines) — JSON module validation and segment extraction
  playerState.js    (123 lines) — structured player state sent to AI
  rounds.js          (90 lines) — AI round snapshots and rollback
  privateHub.js      (63 lines) — player-specific SSE delivery

public/
  app.js          (2561 lines) — main frontend logic

test/
  comprehensive-ai.test.mjs (765 lines) — full AI detection and event coverage
  aiOutput.test.mjs         (835 lines) — parser/validator/inference regressions
  frontend.e2e.mjs          (556 lines) — Playwright browser coverage for visible controls
  app.test.mjs              (741 lines) — API integration tests
  db.test.mjs               (797 lines) — persistence tests
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

## 2026-06-16 Implementation Update

The five high-value follow-ups from the previous review are now implemented locally.

### 1. Structured Clue / NPC Persistence (`e426d16`)

- `clues_revealed` still creates visible system/private messages, but now also writes structured records into participant `playerMeta.discoveredClues`.
- Public clues are merged into every participant; private clues are merged only into `privateTo`.
- `npc_state_changes` now writes structured records into each participant `knownNpcs` and into room `sceneState.npcStates`.
- Prompt schema now supports `clueId` and `npcId`; `clueId` should use module `clues.clue_id` when available.
- Regression coverage: `test/comprehensive-ai.test.mjs` verifies public/private clue persistence, NPC persistence, room scene-state update, and AI log entries.

### 2. Explicit AI Action Lifecycle (`e426d16`)

- `messages` has `ai_processed_task_uid` and `ai_processed_at`.
- Completed AI tasks call `database.markAiTriggerProcessed({ taskUid })`.
- `enhanceStructuredEvents()` now accepts `triggerMessageId` from `ai_tasks`, so detection uses the action that actually triggered the current task instead of blindly using the newest ACTION in the room.
- `latestPlayerAction()` still keeps the old message-order fallback for legacy messages, but explicit task linkage is now the primary path.
- Regression coverage: `test/aiOutput.test.mjs` verifies queued actions do not cross-contaminate detection.

### 3. Scene-Aware AI Context (`e426d16`)

- `buildDmMessages()` now ranks module scenes, NPCs, clues, and checks by:
  - `room.sceneState.currentScene/currentSceneId/currentLocation`
  - `sceneState.npcStates`
  - recent chat terms
  - player `knownNpcs` and `discoveredClues`
- AI prompt now includes "模组结构化数据（已按当前场景排序）" plus current `sceneState` JSON.
- Regression coverage: `test/aiClient.test.mjs` verifies the current scene is prioritized over earlier module scenes.

### 4. Persistent AI Logs (`e426d16`)

- `_aiLogs` in-memory map was replaced by SQLite table `ai_logs`.
- `GET /api/rooms/:code/ai-log` now reads persisted logs, still owner-only.
- Logs are no longer cleared when the owner leaves or the room ends, so playtest diagnostics survive restarts.
- Regression coverage: `test/db.test.mjs` verifies AI logs persist and round-trip from SQLite.

### 5. Frontend E2E Coverage (`4716b92`)

- Added Playwright via `@playwright/test`.
- New script: `npm run test:e2e`.
- New test file: `test/frontend.e2e.mjs`.
- Browser tests start a real app server, fake streaming AI server, and temporary SQLite database.
- Covered flows:
  - `继续叙事` button appears after a check result and queues AI without creating a visible player ACTION.
  - AI detection log dialog displays readable Chinese summaries.
  - rollback button appears and works.
  - character status / skill allocation shortcuts open the expected dialogs.
- This also caught and fixed a real frontend bug: `#btnCharSheet` was inside `#chatLog`, and `renderMessages()` removed it with `innerHTML = ''`. It is now reattached during message rendering.

### AI Log Readability (`4716b92`)

- Log dialog now shows Chinese stage names, event chips, summary paragraphs, detection rows, and collapsed raw snippets.
- Added readable labels for `required_checks`, `opposed_checks`, `clues_revealed`, `scene_change`, `npc_state_changes`, and `summary_update`.
- `window.onerror` now renders via DOM/textContent instead of HTML string injection.

### Chat Quick Send (`e38928d`)

- Added `Ctrl+Enter` quick send on the main chat textarea.
- Also supports `Meta+Enter` for Mac keyboards while keeping the requested `Ctrl+Enter` behavior.
- The shortcut uses `requestSubmit()`, so it goes through the existing submit handler, AI task queue, error handling, and input clearing path.
- Added a Playwright regression test that opens a real room, fills the composer, presses `Control+Enter`, verifies the action appears, the textarea clears, and the fake streaming AI reply renders.
- Verification after this change:
  - `npm run check`
  - `npm test` — 105/105 passed
  - `npm run test:e2e` — 4/4 passed

### Follow-up Items 1 / 3 / 4 / 5 (`9a6ab9b`)

Completed the latest requested follow-up set:

1. Deployment
   - Synced local app code to `/opt/dm-online` with runtime data excluded (`.env`, `data/`, `node_modules/`, reports, test-results).
   - Ran on server: `npm install`, `npm run check`, `npm test`, `systemctl restart dm-online`, `nginx -t`.
   - Rechecked after restart race: `curl http://127.0.0.1:4173/api/health` returned OK and `systemctl is-active dm-online` returned `active`.
   - Ran public audit locally: `npm run audit:deployment -- http://8.153.147.137`, result OK.
   - Confirmed public HTML/JS contains the new cache version `20260616-e2e-log-tools` and AI log export code.

3. Frontend E2E coverage
   - Expanded Playwright coverage from 4 to 8 browser tests.
   - New coverage:
     - Create room through UI, join through UI, enforce max-player cap.
     - Real-time player message sync across browser pages.
     - Private messages delivered only to sender and target player.
     - Character sheet save/reopen preserves occupation and interest skill allocations.
     - AI log filtering, grouping, and JSON export.
   - Local `npm run test:e2e` passed 8/8.

4. AI detection log usability
   - AI log dialog now has a stage filter, warning-only toggle, task grouping toggle, and JSON export.
   - Filtering/grouping happens client-side against the persisted SQLite log payload.
   - Export includes room code, export time, active filters, and filtered log entries.

5. Frontend HTML rendering cleanup
   - Removed `innerHTML` usage from `public/app.js`.
   - Rebuilt chat messages, player list, status cards, character sheet overlay, skill tables, characteristic/resource inputs, and AI log entries with DOM APIs and `textContent`.
   - Local browser smoke check via in-app Browser: page loaded at `127.0.0.1:4174`, AI log toolbar and quick-send marker existed, and console error count was 0.

Verification after `9a6ab9b`:
- Local `npm run check`
- Local `npm test` — 105/105 passed
- Local `npm run test:e2e` — 8/8 passed
- In-app Browser smoke check — OK
- Server `npm run check`
- Server `npm test` — 105/105 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK

### Bug Audit Fixes (`96d8f3d`)

Two concrete bugs were found and fixed during the latest review:

- Private message API accepted missing or non-room `privateTarget` values.
  - Before: it could create a private message that no recipient would ever receive.
  - Now: `POST /api/rooms/:code/messages` with `messageType: "PRIVATE"` requires `privateTarget`, validates the target is a room participant, and then delivers to sender + target.
  - Added integration coverage in `test/app.test.mjs`.
- Frontend SSE had duplicate `message_error` listeners.
  - Before: one AI failure event could run the same error handling twice and show duplicate toasts.
  - Now: only one listener remains.

Verification after `96d8f3d`:
- Local `npm run check`
- Local `npm test` — 106/106 passed
- Local `npm run test:e2e` — 8/8 passed
- Server `npm run check`
- Server `npm test` — 106/106 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK

### AI Queue / Log Frontend State (`3c3583a`)

Implemented the latest optimization pass after `Ctrl+Enter`:

- Main chat header now includes `#aiQueueSummary`, a compact live queue summary next to the AI state pill.
- The summary shows:
  - current active task status and short task id
  - waiting active-task count
  - latest finished task, or active failure count when failures exist
  - latest task update time when available
- AI log dialog now includes `#aiLogStats`, showing total logs, current filter matches, warning count, distinct task count, and latest stage/time.
- AI log stats update together with stage filter, warning-only toggle, and task grouping state.
- Loading and failure states are visible in the AI log stats strip, so the owner can tell whether logs are unavailable or simply empty.
- Added E2E coverage that seeds a busy AI queue and log records, then verifies the queue summary and filtered AI log stats in the browser.
- Public cache bust: `public/index.html` now serves `/app.js?v=20260616-ai-status-ui`.

Verification after `3c3583a`:
- Local `npm run check`
- Local `npm test` — 106/106 passed
- Local `npm run test:e2e` — 9/9 passed
- In-app Browser smoke check — OK, no console errors
- Server `npm run check`
- Server `npm test` — 106/106 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `PXUPGK`, `aiConfigured: true`
- Confirmed public HTML/JS includes `#aiQueueSummary`, `#aiLogStats`, and `20260616-ai-status-ui`

### AI Preflight Checks / Stronger Validation (`9a89c6a`)

Implemented the latest requested AI reliability pass:

- ACTION messages now run through `planPreflightCheck()` before an AI task is queued.
- If the backend can confidently identify a required check or opposed check and it passes room-aware validation, the server rolls it immediately.
- After a preflight roll, the AI task uses idempotency key `precheck:<actionMessageId>:<checkMessageId>` and `triggerMessageId` points to the system check message, not the original ACTION.
- Preflight AI tasks receive the same "检定结果后的继续叙事" system instruction as manual `继续叙事`, plus an extra instruction not to repeat `required_checks` / `opposed_checks`.
- The older post-AI inference path remains as a fallback when preflight is ambiguous, skipped, or when the model still emits useful structured events.
- Preflight is intentionally skipped while another AI task is active, so deterministic rolls do not jump ahead of queued narration.

Validation improvements:

- `validateStructuredEvents()` now accepts `{ roomState, defaultPlayerId }`.
- Required checks are rejected if the target player is missing or the skill/attribute cannot be resolved from the character sheet.
- Opposed checks are rejected if the active player is missing, the active skill is invalid, or a hallucinated NPC is returned while a module/known/recent NPC context exists.
- NPC references are canonicalized through module NPCs, scene `npcStates`, participant `knownNpcs`, static aliases, and recent chat context.
- Private clue targets must be real room participants.
- AI logs now include room-aware validation `warnings` along with `issues`.

Regression coverage:

- Added real playtest-derived cases from `reports/2026-06-14-test-report.md` / `dm-online-ZZL4KB`:
  - "其实我祖上也是我们村的人" -> 话术 vs 陈友
  - "老一辈就让我找您呀" -> 话术 vs 陈友
  - "姓郑啊" -> 话术 vs 陈友
  - "陈友让我们往北边去的" -> 话术 vs 老汉
  - "回到房间 自己审查所有账册" -> 会计
  - "仔细观察一下这个房间（过侦查检定）" -> 侦查
  - "我们出门... (过聆听）" -> 聆听
- Added HTTP integration coverage proving required and opposed preflight rolls happen before AI narration and that the AI continuation prompt is sent.
- `applyStructuredEvents()` now returns applied check messages/rolls so the HTTP layer can chain preflight rolls into AI continuation tasks.

Verification after `9a89c6a`:
- Local `npm run check`
- Local `npm test` — 111/111 passed
- Local `npm run test:e2e` — 9/9 passed
- Server `npm run check`
- Server `npm test` — 111/111 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `TKUWBF`, `aiConfigured: true`

### AI Check Hardening / Rollback Side Effects (`5055948`)

Implemented another reliability pass focused on lowering AI check mistakes during real play.

AI structured-event validation:

- `validateStructuredEvents()` now validates array events item by item. If one item is bad and another is valid, the valid item is kept and only the bad item is dropped.
- This applies to schema errors, invalid state-change paths, invalid required-check difficulties, invalid opposed-check `contestType`, and room-aware failures such as missing players, unknown skills, invalid private clue targets, or hallucinated NPCs.
- Bad array items are recorded in `issues`; partial recovery is recorded in `warnings`.
- `required_checks.difficulty` now normalizes accepted variants (`NORMAL`, `REGULAR`, `HARD`, `EXTREME`, plus common Chinese labels). Invalid difficulties drop only that check.
- `opposed_checks.contestType` is normalized to lowercase and inferred from the active skill when omitted.

AI check inference:

- Model-provided checks only count as "model-provided" if they are actually executable in the room.
- If the model returns a complete but unusable check (for example a nonexistent skill or hallucinated NPC), backend inference can still add the correct required/opposed check from the latest ACTION.
- Added regressions proving:
  - Invalid model `opposed_checks` for a nonexistent NPC are dropped while backend infers the valid NPC opposed check.
  - Invalid model `required_checks` with a nonexistent skill are dropped while backend infers the valid `侦查` check.

Prompt hardening:

- DM system prompt now states that all dice rolls, check results, and opposed winners are server-owned.
- Structured-output prompt now explicitly forbids self-generated `d100` results, fixes the allowed JSON top-level keys, and tells the model not to invent unknown player IDs, NPC names, or skill names.
- Check-continuation prompt now tells the model not to rewrite or reroll server dice, and to use `clues_revealed` / `npc_state_changes` when continuing from successful checks.

Rollback side effects:

- `applyStructuredEvents()` now returns applied side-effect message IDs and dice-roll IDs.
- Preflight and AI-applied check rolls are stored in round `rollbackRefs`.
- SQLite `dice_rolls` now has `is_rolled_back`; list/export state filters rolled-back dice.
- `computeRollback()` now marks the DM message, structured-event system messages, preflight check messages, and related dice rolls as rolled back.
- Regression coverage verifies that rolling back a preflight AI round removes the visible check message, DM message, and dice roll from room state.

Verification after `5055948`:
- Local `npm run check`
- Local `npm test` — 114/114 passed
- Local `npm run test:e2e` — 9/9 passed
- Server `npm run check`
- Server `npm test` — 114/114 passed
- Server `systemctl restart dm-online`, `nginx -t`, `/api/health`, and `systemctl is-active dm-online` — OK
- Public deployment audit — OK, room `YF9WQA`, `aiConfigured: true`

## 2026-06-16 Code Review Notes

Historical review note retained for context. The old high-value items around structured clue/NPC persistence, explicit action lifecycle, scene-aware context, persistent AI logs, visible log tooling, and browser coverage have now been implemented.

Current AI behavior detection is much stronger than the original playtest report described:
- The model no longer needs to reliably emit JSON for common checks. Backend preflight and post-AI inference now recover many missing `required_checks` and `opposed_checks`.
- Opposed checks are prioritized over ordinary required checks, preventing "lie to NPC" actions from becoming generic observation/search rolls.
- The continuation loop caused by reusing the same player ACTION has been fixed by skipping already-processed actions.
- AI-written check-marker text is stripped before backend marker injection, preventing duplicate visible prompts.
- Common high-risk checks can now happen before AI narration, reducing cases where AI narrates a result before the server rolls.
- If the model returns unusable structured checks, backend inference can now rescue the round instead of treating bad JSON as "model-provided".
- AI rollback now hides related system check messages and dice rolls, not only the DM message.

The remaining improvements are now mostly about deeper durability, UI ergonomics, and reducing future maintenance cost.

## 2026-06-17 Queued Preflight Update

Completed the highest-impact follow-up from the previous review: preflight checks now run when an AI task reaches the front of the per-room queue, rather than only at message-submit time.

Why this matters:
- Previously, if another AI task was active, the backend skipped preflight for later ACTION messages to avoid out-of-order rolls.
- That preserved ordering, but increased the chance that queued actions would rely on the model to ask for checks correctly.
- Now every queued ACTION can still get deterministic server-side preflight when its own AI turn starts, so busy multiplayer rooms keep both ordering and lower AI check error rates.

Implementation notes:
- `src/app.js` keeps ACTION submission fast: it creates the player message and AI task immediately, then defers preflight to `generateDmReply()`.
- When queued preflight creates a required/opposed check, the AI task `triggerMessageId` is updated to the resulting system check message.
- The AI prompt then receives the same "检定结果后的继续叙事" instruction as manual continue tasks.
- Rollback refs now include queued preflight check messages and dice rolls.
- Regenerating a task whose trigger is a check result also receives continuation context, so it does not forget server dice results.
- `src/db.js` added `updateAiTaskTrigger()` for the internal task trigger rewrite.

Regression coverage:
- `test/app.test.mjs` now verifies immediate preflight still rolls before narration.
- It also verifies a second ACTION submitted while AI is streaming still runs its own preflight when its queued turn starts.
- It verifies regeneration from a preflighted task preserves check-continuation prompt context.

Verification after this update:
- `npm run check`
- `npm test` — 119/119 passed
- `npm run test:e2e` — 9/9 passed

### Current Recommended Next Work

1. Split large frontend/server files before the next broad feature.
   - `public/app.js` is now 2561 lines; `src/db.js`, `src/app.js`, and `src/aiOutput.js` are also large.
   - Best first split: move character-sheet UI, AI log UI, and chat rendering into focused frontend modules.
   - Keep tests green between each extraction; avoid a big-bang refactor.

2. Add a complete owner-facing playtest export/import flow.
   - Chat, character cards, state, summary, AI logs, and module data are already persisted.
   - A single importable bundle would make bug reports, regression fixtures, and cross-machine playtest replay much easier.

3. Split `aiOutput.js` before more detection tuning.
   - It now mixes JSON extraction, validation, narrative cleanup, required-check inference, opposed-check inference, module matching, and NPC matching.
   - Suggested split:
     - `aiStructuredParser.js` for JSON extraction/validation.
     - `aiDetection.js` for rule-based check inference.
     - `aiNarrativeSanitizer.js` for marker/action-suggestion cleanup.
   - Add tests before splitting so behavior stays stable.

4. Continue tuning module-defined check matching with more playtest logs.
   - `classifyModuleRequiredAction()` already scores module checks using trigger overlap, skill mention, scene match, and CJK bigram overlap.
   - `ZZL4KB` report regressions are now covered for several social and required checks.
   - Add future reports as fixtures before changing broad keyword rules; prefer module-specific anchors so normal roleplay does not trigger excessive rolls.

5. Surface preflight status in the UI.
   - Backend logs `preflight-check` and `preflight-skipped`, but the UI currently only shows the resulting system check and AI task.
   - A compact "服务器已预检定" marker in the AI log/status area would make this behavior easier to understand during playtests.

6. Add export/import for a complete playtest session.
   - Chat, character cards, state, summary, AI logs, and module data are all persisted.
   - A single owner export would make bug reports and future regression fixtures much easier to produce.

### Lower-Priority Cleanup

- Broaden `AI_CHECK_MARKER` only if more duplicate marker variants appear. Current regex handles the observed Chinese full-width marker pattern.
- Cache NPC candidates and module detection data per room/task if AI calls become CPU-heavy.
- Split large files (`public/app.js`, `src/db.js`, `src/app.js`) when touching those areas next; do not refactor them all at once.

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
- clues_revealed → system/private messages + participant `discoveredClues`
- scene_change → scene state update + system message
- npc_state_changes → NPC state messages + participant `knownNpcs` + room `sceneState.npcStates`
- summary_update → trusted as replacement summary

### Rollback

AI rounds tracked by task UID. `POST /api/rooms/:code/rollback/:roundId` restores:
- Character snapshots (sheet + revision)
- Story summary
- Scene state
- Marks round, DM message, structured-event system messages, preflight check messages, and related dice rolls as rolled back

## Verification

Local:
```bash
npm run check     # passed on 2026-06-16 23:09 CST
npm test          # 114/114 passed on 2026-06-16 23:09 CST
npm run test:e2e  # 9/9 Playwright tests passed on 2026-06-16 23:10 CST
```

Server:
```bash
cd /opt/dm-online && npm run check
cd /opt/dm-online && npm test                  # 114/114 passed
systemctl restart dm-online
curl -fsS http://127.0.0.1:4173/api/health     # ok: true, aiConfigured: true
systemctl is-active dm-online                    # active
nginx -t                                         # successful
```

Public deployment audit:
```bash
npm run audit:deployment -- http://8.153.147.137
# ok: true, aiConfigured: true, roomCode: YF9WQA
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

# Optional on server if Playwright browsers are installed:
sshpass -e ssh -p 2233 -o StrictHostKeyChecking=no root@8.153.147.137 \
  'cd /opt/dm-online && npm run test:e2e'

sshpass -e ssh -p 2233 -o StrictHostKeyChecking=no root@8.153.147.137 \
  'systemctl restart dm-online && sleep 2 && curl -fsS http://127.0.0.1:4173/api/health; echo; systemctl is-active dm-online; nginx -t'
```

Public audit after restart (increased timeout for slow AI):
```bash
DEPLOYMENT_AUDIT_AI_TIMEOUT_MS=180000 npm run audit:deployment -- --require-ai http://8.153.147.137
```

## Notes For Next Agent

- User prefers autonomous implementation, testing, deployment, and log inspection.
- Always run tests before and after changes (`npm test`; run `npm run test:e2e` for frontend-visible flows).
- Keep doing checkpoint commits before substantial changes.
- Do not overwrite unrelated user changes if the worktree is dirty.
- Do not commit secrets.
- Preserve server `.env`, `data/`, and runtime database during rsync.
- Playwright browser binaries were installed locally via `npx playwright install chromium`; a new machine may need that command before `npm run test:e2e`.
- The test fixture `test/fixtures/comprehensive-test-module.json` can be uploaded via the API to manually test AI detection in a real room.
- If changing AI detection, add regression tests in `test/aiOutput.test.mjs` and/or `test/comprehensive-ai.test.mjs`.
- When debugging game sessions, request the JSON export (`GET /api/rooms/:code/export?format=json`) to see messages, diceRolls, and aiTasks in context.
- The AI detection log endpoint (`GET /api/rooms/:code/ai-log`) is owner-only and now reads persistent SQLite `ai_logs`.
- `latestPlayerAction` now prefers explicit `triggerMessageId` and skips `aiProcessedTaskUid` actions — if AI check inference stops working unexpectedly, inspect `ai_tasks.trigger_message_id` and `messages.ai_processed_task_uid` first.

## Potential Follow-Ups

- Add AI log export into `GET /api/rooms/:code/export?format=json` if long playtests need portable diagnostics.
- Tune module check matching with newer real playtest logs from `reports/` after another session.
- Cache NPC candidates per room/task (currently rebuilt every AI call in `npcCandidates()`).
- Split `aiOutput.js`, `db.js`, `app.js`, and `public/app.js` along existing boundaries when next touching those files.
- Consider moving Playwright artifacts or traces to a CI-friendly path if this project gets CI later.
