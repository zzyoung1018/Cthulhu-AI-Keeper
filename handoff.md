# DM Online Handoff

Last updated: 2026-06-16 12:40 CST

## Current State

- Local repo: `/Users/young/Documents/dm online`
- Deployed app: `http://8.153.147.137`
- Server app path: `/opt/dm-online`
- SSH endpoint: `root@8.153.147.137 -p 2233`
- Service: `dm-online` managed by systemd
- Reverse proxy: Nginx
- Database: SQLite, server runtime data under `/opt/dm-online/data`
- Local branch: `main`
- Latest completed local code commit: `4716b92 test: add frontend e2e and readable ai logs`
- Latest deployed code commit known from prior deployment: `0a94f99 fix: strip AI-generated check markers before injecting backend markers`
- Note: local app code now has post-deployment changes after `0a94f99`; deploy before expecting the server to have these features.
- Local worktree is clean.

Do not write server credentials into committed files. Use the conversation context or ask the user if credentials are needed again.

## Recent Commits

- `4716b92` test: add frontend e2e and readable ai logs
- `e426d16` feat: persist ai state and action lifecycle
- `56ffb3c` chore: checkpoint before ai state and log upgrades
- `4ad3c21` docs: update handoff with ai detection review
- `79bedf4` docs: refresh handoff with continue loop fix and duplicate marker fix
- `0a94f99` fix: strip AI-generated check markers before injecting backend markers
- `652a60d` fix: skip processed actions in latestPlayerAction to prevent check re-inference loop
- `0ec6d12` docs: refresh handoff after ai detection deployment
- `6546044` fix: make deployment audit summary assertion stable

## Code Map

```text
src/
  app.js           (1030 lines) — HTTP routes, room lifecycle, AI orchestration
  aiOutput.js      (1211 lines) — AI JSON extraction, validation, detection inference
  aiEvents.js       (535 lines) — applies AI structured events to rolls/state/summary
  aiClient.js       (430 lines) — streaming client and scene-aware AI context assembly
  prompts.js        (243 lines) — system/user/structured-output prompts
  db.js            (1350 lines) — SQLite schema, migrations, row mappers, queries
  character.js      (368 lines) — CoC 7e sheet normalization and skill lookup
  dice.js           (441 lines) — CoC 7e dice, checks, opposed checks, luck/pushed rolls
  moduleParser.js   (347 lines) — JSON module validation and segment extraction
  playerState.js    (123 lines) — structured player state sent to AI
  rounds.js          (77 lines) — AI round snapshots and rollback
  privateHub.js      (63 lines) — player-specific SSE delivery

public/
  app.js          (2207 lines) — main frontend logic

test/
  comprehensive-ai.test.mjs (765 lines) — full AI detection and event coverage
  aiOutput.test.mjs         (594 lines) — parser/validator/inference regressions
  frontend.e2e.mjs          (287 lines) — Playwright browser coverage for visible controls
  app.test.mjs              (446 lines) — API integration tests
  db.test.mjs               (774 lines) — persistence tests
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

## 2026-06-16 Code Review Notes

Historical review note retained for context. The items marked as recommended below have mostly been implemented by `e426d16` and `4716b92`.

Current AI behavior detection is much stronger than the original playtest report described:
- The model no longer needs to reliably emit JSON for common checks. Backend inference now recovers many missing `required_checks` and `opposed_checks`.
- Opposed checks are prioritized over ordinary required checks, preventing "lie to NPC" actions from becoming generic observation/search rolls.
- The continuation loop caused by reusing the same player ACTION has been fixed by skipping already-processed actions.
- AI-written check-marker text is stripped before backend marker injection, preventing duplicate visible prompts.

The remaining improvements are mostly about durability, edge cases, and making future tuning easier.

### AI Behavior Detection: Recommended Next Work

1. Persist clue and NPC state structurally.
   - `src/aiEvents.js` currently turns `clues_revealed` into system/private messages only.
   - `playerState.js` already exposes `discoveredClues` and `knownNpcs`, but AI events do not update those arrays.
   - Best next feature: when a clue is revealed or an NPC state changes, merge it into participant `playerMeta` or room scene state, then include it in future AI context.
   - This improves long-session memory more than another prompt-only tweak.

2. Make check lifecycle explicit instead of heuristic.
   - `latestPlayerAction()` now skips an ACTION if a later DM/system check message exists. This fixed the continue loop.
   - Longer term, attach the triggering `messageId` or task context to `ai_tasks` and mark that action as processed.
   - This would handle edge cases like manual system checks, interleaved players, retries, or future regeneration flows more cleanly.

3. Split `aiOutput.js` before major detection tuning.
   - It now mixes JSON extraction, validation, narrative cleanup, required-check inference, opposed-check inference, module matching, and NPC matching.
   - Suggested split:
     - `aiStructuredParser.js` for JSON extraction/validation.
     - `aiDetection.js` for rule-based check inference.
     - `aiNarrativeSanitizer.js` for marker/action-suggestion cleanup.
   - Add tests before splitting so behavior stays stable.

4. Tune module-defined check matching with real playtest logs.
   - `classifyModuleRequiredAction()` already scores module checks using trigger overlap, skill mention, scene match, and CJK bigram overlap.
   - Use `reports/dm-online-ZZL4KB.json` and `reports/dm-online-ZZL4KB-ai-log.json` to add targeted regression cases.
   - Avoid over-broad keyword rules; prefer module-specific anchors so normal roleplay does not trigger excessive rolls.

5. Improve observability for skipped/invalid structured events.
   - Some invalid or unresolved events are skipped or logged only to server console.
   - Add owner-visible AI log entries for rejected check skills, missing NPC targets, and ignored state changes.
   - This will make future playtest debugging faster than reading raw server logs.

6. Persist AI diagnostics if playtests become longer.
   - `_aiLogs` in `src/app.js` is in-memory, capped per room, and lost on restart.
   - For serious playtesting, store diagnostics in SQLite or include them in room export.
   - If staying in memory, add time-based eviction as already noted below.

7. Make AI context scene-aware.
   - `buildDmMessages()` sends compact module JSON, but current selection still favors early scenes/NPCs.
   - Use `sceneState.currentScene`, recent messages, and latest triggered check/clue IDs to include the most relevant scene/NPC/clue context first.
   - This should improve narrative continuity and reduce hallucinated location/NPC details.

8. Add browser/E2E coverage for visible AI controls.
   - Current tests cover backend and parser behavior well, but not the actual chat UI.
   - Add tests for `继续叙事`, AI detection log modal, rollback button visibility, and character-card quick status/actions.

### Lower-Priority Cleanup

- Harden `public/app.js` `window.onerror`; it currently injects raw error text via HTML. Use DOM nodes/textContent or disable it in production.
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
- Marks round and messages as rolled back

## Verification

Local:
```bash
npm run check     # passed on 2026-06-16 12:39 CST
npm test          # 105/105 passed on 2026-06-16 12:39 CST
npm run test:e2e  # 3/3 Playwright tests passed on 2026-06-16 12:39 CST
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

- Deploy local commits `e426d16` and `4716b92` to the server, then run server-side `npm test`, restart `dm-online`, and audit health.
- Add AI log export into `GET /api/rooms/:code/export?format=json` if long playtests need portable diagnostics.
- Tune module check matching with newer real playtest logs from `reports/` after another session.
- Cache NPC candidates per room/task (currently rebuilt every AI call in `npcCandidates()`).
- Split `aiOutput.js`, `db.js`, `app.js`, and `public/app.js` along existing boundaries when next touching those files.
- Consider moving Playwright artifacts or traces to a CI-friendly path if this project gets CI later.
