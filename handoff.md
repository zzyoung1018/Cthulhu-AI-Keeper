# DM Online Handoff

Last updated: 2026-06-20 16:09 JST

## Current State

- Local repo: `/Users/young/Documents/dm online`
- Deployed app: `http://8.153.147.137`
- Server app path: `/opt/dm-online`
- SSH endpoint: `root@8.153.147.137 -p 2233`
- Service: `dm-online` managed by systemd
- Reverse proxy: Nginx
- Database: SQLite, server runtime data under `/var/lib/dm-online`
- Local branch: `main`
- Latest completed local app commit: `513f7e8 feat: export replay regression fixtures`
- Latest local utility commit: `07396ff fix: wait for audited ai tasks to finish`
- Latest deployed app commit: `513f7e8 feat: export replay regression fixtures`
- Latest Lina module nested repo commit: `62278db fix: preserve Lina void opening facts`
- Deployment verified on 2026-06-20 16:07 JST: server `npm run check` OK, server `npm test` 129/129 passed, systemd active, Nginx config OK, `/api/health` OK, public deployment audit OK (`6XJ2UA`).
- Local worktree has the nested `测试模组 新/` directory untracked from the parent repo; leave it alone unless the user explicitly asks.

Do not write server credentials into committed files. Use the conversation context or ask the user if credentials are needed again.

## Recent App Commits

- `513f7e8` feat: export replay regression fixtures
- `0375846` chore: checkpoint before replay fixture export
- `2005a33` docs: update handoff after replay labels
- `b588b6b` feat: label imported replay rooms
- `fdde78a` chore: checkpoint before replay room labels
- `ed4e26a` feat: import playtest exports as replay rooms
- `212570b` chore: checkpoint before playtest import
- `f859c06` docs: update handoff after preflight log visibility
- `3f42a13` feat: surface preflight checks in ai logs
- `1a17782` fix: clarify intro and opening pacing prompts
- `3da6cf2` fix: preserve prep synopsis facts and export context
- `eace8dd` chore: checkpoint before prep intro fact restoration
- `d9e5027` docs: update handoff after prep synopsis simplification
- `348ff7e` fix: simplify preparation synopsis prompt
- `db0c726` chore: checkpoint before intro briefing simplification
- `07396ff` fix: wait for audited ai tasks to finish
- `ae8e93f` feat: defer opening scene until game start
- `3c41fe5` chore: checkpoint before deferred opening scene
- `186673b` docs: update handoff after intro fidelity fix
- `5479566` fix: guard intro critical fact drift
- `effb1f4` chore: checkpoint before intro drift guard
- `b16fd69` fix: preserve intro anomaly facts
- `b9328ba` chore: checkpoint before void intro fidelity fix
- `1814fda` fix: complete module intro briefing
- `6194355` chore: checkpoint before intro flow improvements
- `9ebd7da` feat: run preflight checks from ai queue
- `29dfb01` chore: checkpoint before queued preflight improvements
- `2dddd99` docs: clarify module skill and clue rules
- `280c4f8` fix: handle new module language checks
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
  app.js           (1347 lines) — HTTP routes, room lifecycle, AI orchestration
  aiOutput.js      (1699 lines) — AI JSON extraction, validation, detection inference
  aiEvents.js       (566 lines) — applies AI structured events to rolls/state/summary
  aiClient.js       (430 lines) — streaming client and scene-aware AI context assembly
  prompts.js        (687 lines) — intro/opening/DM system/user/structured-output prompts
  db.js            (1686 lines) — SQLite schema, migrations, row mappers, queries
  export.js         (416 lines) — owner exports and replay regression fixture builder
  character.js      (392 lines) — CoC 7e sheet normalization and skill lookup
  dice.js           (441 lines) — CoC 7e dice, checks, opposed checks, luck/pushed rolls
  moduleParser.js   (347 lines) — JSON module validation and segment extraction
  playerState.js    (123 lines) — structured player state sent to AI
  rounds.js          (90 lines) — AI round snapshots and rollback
  privateHub.js      (63 lines) — player-specific SSE delivery

public/
  app.js          (2721 lines) — main frontend logic

test/
  comprehensive-ai.test.mjs (765 lines) — full AI detection and event coverage
  aiOutput.test.mjs         (882 lines) — parser/validator/inference regressions
  frontend.e2e.mjs          (623 lines) — Playwright browser coverage for visible controls
  app.test.mjs             (1362 lines) — API integration tests
  db.test.mjs               (922 lines) — persistence tests
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

## 2026-06-17 Intro Briefing Update

Fixed a real playtest issue from export `dm-online-FN8CVX.json`: the preparation intro for `Lina-现实的荒原` only produced a short "模组简介" and did not explain the public premise, character hooks, or opening scene.

What changed:
- `buildIntroSystemPrompt()` now requires five public sections: `模组简介`, `玩家公开前提`, `调查员创建指南`, `开局场景`, and `注意事项`.
- `buildIntroPublicGuide()` extracts a public briefing from JSON module fields such as `module_info`, `player_opening`, initial scene, known locations, known handouts, and checks.
- `ensureCompleteIntroContent()` appends missing sections from backend-derived public data if the model stops early or omits required headings.
- The public intro intentionally avoids NPC `role`, keeper secrets, and `keeper_overview.investigation_goal`; it prefers first impressions/public descriptions and excludes hidden identities.
- Recommended prep skills filter out attributes and `克苏鲁神话`; `语言学` is presented as `外语`.

Regression coverage:
- `test/prompts.test.mjs` covers required headings, public guide extraction, hidden-role non-leakage, and missing-section completion.
- `test/app.test.mjs` covers the HTTP `/start-intro` path where a fake AI returns only `## 模组简介`; the final persisted intro includes public premise, character guidance, opening scene, and no hidden NPC identity.

Verification after this update:
- `npm run check`
- `npm test` — 123/123 passed
- `npm run test:e2e` — 9/9 passed
- Server `npm run check`
- Server `npm test` — 123/123 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `BP3G3A`, `aiConfigured: true`

## 2026-06-17 Void Opening Fidelity Update

User reported the latest generated intro still failed the original module premise: the PDF explicitly says there is an "empty sphere" / `直径一米的完美球形空缺`, but the AI-generated intro in `/Users/young/Downloads/dm-online-FN8CVX.json` described it as `直径约一米的完美球形凹陷`.

Comparison result:
- PDF source is correct:
  - p.2 module intro: `底特律郊区一座废弃的汽车工会大厅里，出现了一个直径一米的完美球形空缺。`
  - p.4 opening handout/photo: the blurry photo shows a `圆形空缺`, not the full phenomenon.
  - p.5 first contact: the actual site contains `一个直径一米的球形空缺`.
- Lina JSON was partly correct but lossy in the opening:
  - `player_opening.initial_public_information` and `union_hall_void` scene already preserved the sphere.
  - `player_opening.suggested_intro_text` only said the photo had `一个完美的圆`.
  - The model then drifted from "空缺" to "凹陷".

What changed:
- `src/prompts.js`
  - `buildIntroPublicGuide()` now extracts `criticalPublicFacts` from public information, objective, opening text, initial scene, known locations, and known handouts.
  - `buildIntroSystemPrompt()` tells the model to preserve immutable public facts, exact geometry, numbers, locations, distances, objects, and objectives.
  - `ensureCompleteIntroContent()` now runs deterministic drift correction even when the model already returned all required headings. For this module, `直径约一米的完美球形凹陷` is corrected to `直径一米的完美球形空缺`.
- `测试模组（json）/prompt.md`
  - Added a "关键意象和开场保真" section requiring converters to keep handout/photo facts separate from actual scene facts.
- Nested module repo `测试模组 新/`
  - `Lina-现实的荒原.json` now distinguishes the photo's circular cutout from the real `直径一米的完美球形空缺`.
  - `prompt.md` has the same key-imagery fidelity rules.
  - `build_lina_wasteland_json.py` is still untracked in that nested repo but was updated on disk to match the JSON; decide explicitly before adding it to version control.

Regression coverage:
- `test/prompts.test.mjs` now asserts the public guide includes `不可改写的公开事实` and `直径一米的完美球形空缺`.
- New regression: an AI intro that already has all required headings but says `直径约一米的完美球形凹陷` is corrected to `直径一米的完美球形空缺`.
- `test/app.test.mjs` asserts the persisted intro includes the sphere fact and excludes the drift phrase.

Verification after this update:
- Local `npm run check`
- Local `npm test` — 124/124 passed
- Local `npm run test:e2e` — 9/9 passed
- `python3 -m json.tool "测试模组 新/Lina-现实的荒原.json"` — OK
- Server `npm run check`
- Server `npm test` — 124/124 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `UEQJXT`, `aiConfigured: true`
- Targeted local drift check against `测试模组 新/Lina-现实的荒原.json` — `hasVoidSphere: true`, `hasDrift: false`

## 2026-06-17 Preparation Synopsis / Deferred Opening Scene Update

This supersedes both the old "five-section intro" behavior and the later "four-section public briefing" behavior. Preparation mode should now show only a natural, non-spoiler story synopsis. However, the synopsis must still preserve the module's public hook facts; over-abstracting the premise causes missing information and model hallucination.

What changed:
- Preparation intro now allows exactly one heading: `## 剧情简介`.
- The generated text should be 1-3 natural paragraphs, like a back-cover pitch or table invitation. It should not be a classified list of era/place/type/atmosphere.
- Preparation output must not include `## 模组简介`, `## 玩家公开前提`, `## 调查员创建指南`, `## 注意事项`, `## 开局场景`, "你已经知道", known NPC/location/handout lists, skill/occupation guidance, operational checklists, or first-scene readaloud. It may include public hook facts and critical public numbers when those facts are part of the premise.
- For structured JSON modules, preparation context includes only public-safe synopsis material: title, `player_opening.initial_public_information`, initial objective, background mood, tone, filtered themes, and must-preserve hook facts. It still excludes known NPCs, known locations, known handouts, `keeper_overview`, hidden roles, global keeper rules, and `suggested_intro_text`.
- For unstructured modules, raw snippets are still available only as "internal reference for mood extraction"; the prompt forbids repeating concrete opening facts.
- `ensureCompleteIntroContent()` now normalizes `## 模组简介` to `## 剧情简介`, keeps only that synopsis section, strips old prep sections, and converts old "you already know" style lines into natural synopsis facts instead of dropping those facts.
- Critical-fact correction such as `直径约一米的完美球形凹陷` -> `直径一米的完美球形空缺` remains in `ensureOpeningSceneContent()` for the actual opening scene.
- `suggested_intro_text`, `default_opening`, and `initial_scene` are reserved for the actual first scene after the owner starts the game.
- When room status changes from `PREPARING` to `ACTIVE`, `PATCH /api/rooms/:code/status` creates an idempotent opening task (`opening:<code>`) and queues `generateOpeningScene()`.
- Opening scene output streams as an `AI DM` message, uses a separate opening-scene prompt, and is sanitized by `ensureOpeningSceneContent()`.
- The frontend now accepts `openingTask` from the status response so the AI queue/status UI immediately reflects the automatic opening task.
- AI log labels now call the preparation task `剧情简介` rather than `开场介绍`.

Regression coverage:
- `test/prompts.test.mjs` verifies prep prompts only request a natural non-spoiler synopsis.
- `test/prompts.test.mjs` verifies structured JSON prep context does not contain opening facts such as the void sphere, photo, envelope, known skills, or hidden role.
- `test/prompts.test.mjs` verifies `ensureCompleteIntroContent()` strips old sections and does not append opening facts or run critical drift correction during preparation.
- `test/app.test.mjs` verifies `/start-intro` saves only `## 剧情简介` and strips leaked `玩家公开前提` / "你已经知道" content from model output.
- `test/app.test.mjs` verifies starting the game automatically queues and completes the opening scene, with critical void terminology repaired.
- Existing AI/check tests were adjusted so the automatic opening task does not mask later player-action tasks.
- `scripts/audit_deployment.mjs` now waits for the automatic opening task and then tracks the specific task uid returned by the audited player action, preventing false failures while AI is still streaming.

Verification after this update:
- Local `npm run check`
- Local `npm test` — 127/127 passed
- Local `npm run test:e2e` — 9/9 passed
- Server `npm run check`
- Server `npm test` — 127/127 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `8Q25W3`, `aiConfigured: true`

## 2026-06-17 Prep Hook Fact Restoration / Export Context Update

User supplied `/Users/young/Downloads/dm-online-KM93VJ.json` and reported the intro was still wrong/missing information. The export showed the opening scene did contain the true premise, but the preparation synopsis had omitted the core hook and hallucinated unsupported phenomena.

Diagnosis:
- The previous preparation prompt over-corrected: it hid the module's actual public premise from the model and left mostly mood/theme material.
- For `Lina-现实的荒原`, that meant the prep synopsis did not reliably preserve the banker, cash/photo commission, Detroit/union hall setup, or the one-meter spherical void.
- The exported JSON also did not contain enough owner-only module context or AI logs, making a playtest export less useful for debugging.

What changed in `src/prompts.js`:
- `buildIntroPublicGuide()` now includes `剧情引入素材`, `早期推动问题`, and `必须保留的引入事实` derived conservatively from public opening information and the initial objective.
- It still avoids known NPC/location/handout expansions, hidden roles, `keeper_overview`, global keeper rules, and `suggested_intro_text`.
- Intro themes are filtered so keeper-only mythos or secret terms such as `奈亚拉托提普` do not leak into preparation copy.
- `buildIntroSystemPrompt()` now says the one allowed heading is still only `## 剧情简介`, but core public hook facts, anomaly/task terms, and key public numbers must be preserved without turning them into a checklist.
- `scrubPrepIntroPhrases()` strips old labels such as `你已经知道:` but keeps the facts after the label, preventing data loss during cleanup.
- The prompt now explicitly forbids unsupported inventions such as unrelated records, dreams, place changes, or phenomena not present in the source.

What changed in export:
- Owner exports now include `module`, `moduleSegments`, `aiLogs`, `rounds`, room `sceneState`, module parse metadata, and richer participant state (`state`, `discoveredClues`, `knownNpcs`, `characterRevision`).
- Non-owner exports still hide private module and AI-log data.
- This makes future `dm-online-*.json` files useful for diagnosing whether a bug came from source JSON, prompt context, model output, or sanitizer/export behavior.

Regression coverage:
- `test/prompts.test.mjs` verifies prep context preserves public hook facts while excluding known-list expansions, hidden NPC roles, secret mythos themes, and old briefing sections.
- `test/app.test.mjs` verifies `/start-intro` keeps the core public premise, strips old headings and `你已经知道`, and does not leak handout/known-list details.
- `test/db.test.mjs` verifies owner exports include full debugging context and non-owner exports do not.

Verification after this update:
- Local `npm run check`
- Local `npm test` — 127/127 passed
- Local `npm run test:e2e` — 9/9 passed
- Server `npm run check`
- Server `npm test` — 127/127 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `GAHKUF`, `aiConfigured: true`

## 2026-06-17 Prompt Pacing / Player-View Update

User asked whether a three-paragraph limit helps or hurts from the player perspective. The conclusion now encoded in prompts:
- Preparation synopsis may use 1-3 paragraphs, but this is an upper-bound rhythm, not a fixed three-paragraph template.
- Preparation should prioritize public hook completeness and natural reading flow over exact paragraph count.
- The old wording "只写一段" conflicted with "1-3 段" and was changed to "只写一个剧情简介/引入".
- Opening scene after play starts must not be forced into three paragraphs either. It now says "不要求固定三段" and should use 2-5 paragraphs according to scene complexity, with information completeness and player actionability prioritized.

Regression coverage:
- `test/prompts.test.mjs` now asserts the intro prompt contains `不是固定三段格式` and `信息完整和自然节奏优先`.
- It also asserts the opening-scene prompt contains `不要求固定三段` and `玩家可行动性优先`.

Verification after this update:
- Local `npm run check`
- Local `node --test test/prompts.test.mjs` — 6/6 passed
- Local `npm test` — 127/127 passed
- Local `npm run test:e2e` — 9/9 passed
- Server `npm run check`
- Server `npm test` — 127/127 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `NNP942`, `aiConfigured: true`

## 2026-06-18 Preflight Log Visibility Update

Completed a high-value UX/debuggability follow-up: preflight checks are now visible and readable in the owner AI detection log instead of appearing as raw backend stage names.

What changed:
- `public/app.js` now localizes `preflight-check` as `服务器预检定` and `preflight-skipped` as `预检定跳过`.
- AI log entries for preflight checks now explain that the server completed the required/opposed check before AI narration, list the trigger source, executed event keys, and linked action message id.
- Preflight skipped logs now show a Chinese reason, including unresolved NPC targets, validation failures, already-processed actions, and "no check" cases.
- AI log stats now show a compact `预检` chip when preflight checks exist.
- AI log chips now display localized stage names instead of raw internal stage ids.
- Existing warning summaries now also show validation warnings, not just issues.

Regression coverage:
- `test/frontend.e2e.mjs` seeds a preflight-check log and verifies the owner sees `服务器预检定`, `服务器已在 AI 回复前完成必要检定`, and `触发来源：通用规则：侦查`.
- The queue/log stats E2E test now verifies the `预检` stat chip.

Verification after this update:
- Local `npm run check`
- Local `npm test` — 127/127 passed
- Local `npm run test:e2e` — 9/9 passed after rerunning outside the sandbox; the first sandboxed run failed only because Chromium could not register its macOS Mach port.
- Server `npm run check`
- Server `npm test` — 127/127 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `XJVAU3`, `aiConfigured: true`

## 2026-06-18 Playtest Import / Replay Room Update

Completed the next owner-facing debug workflow: an owner JSON export can now be imported into a fresh replay/debug room.

What changed:
- Owner exports now preserve round-trip identity fields:
  - participants include `isOwner`
  - messages include `playerId` and `privateTarget`
  - dice rolls include `playerId` and `isPrivate`
- `src/db.js` now has `importPlaytestExport({ exportData, ownerPlayerId, displayName, roomName })`.
- `POST /api/imports/playtest` accepts `{ playerId, displayName, roomName?, export }` and returns the same room payload shape the frontend already knows how to render.
- The create-room dialog now has an `导入回放（owner JSON）` file input and `导入回放` action.
- Importing creates a new module and room owned by the importing user, restores module text/segments, participants, character sheets, participant state, room summary, scene state, messages, dice rolls, and AI logs.
- Old exports without message/dice `playerId` are still usable: the importer maps by display name where possible and otherwise falls back to the new owner.
- Private messages from old exports without a target are mapped to the new owner so they remain inspectable in replay.

Scope and limits:
- This is a replay/debug room, not a perfect continuation of the original live queue.
- It intentionally does not restore original live AI task rows or rollback rounds as active mutable state.
- Use it to inspect a bad playtest, compare module context/logs/messages/dice, and quickly reproduce frontend-visible state.

Regression coverage:
- `test/db.test.mjs` verifies owner export identity fields, imported room/module/participants/messages/dice/AI logs/summary/scene state, and owner visibility for imported private messages.
- `test/app.test.mjs` verifies the HTTP import endpoint creates a replay room from a real owner export and preserves AI logs.
- `test/frontend.e2e.mjs` verifies importing through the create dialog renders the replay room, chat content, player count, and AI log details.

Verification after this update:
- Local `npm run check`
- Local `npm test` — 129/129 passed
- Local `npm run test:e2e` — 10/10 passed
- Server `npm run check`
- Server `npm test` — 129/129 passed
- Server systemd/Nginx/health checks — OK
- Public deployment audit — OK, room `5ANVDK`, `aiConfigured: true`

## 2026-06-18 Replay Room Label Update

Completed the UI/data follow-up after playtest import: imported replay rooms are now explicitly identifiable after refresh.

What changed:
- `rooms` now has `room_meta_json` with a migration and safe JSON parsing in `rowToRoom()`.
- `importPlaytestExport()` stores `roomMeta.replay` with:
  - `isReplay`
  - import time
  - source room name/code
  - source module title
  - imported participant/message/dice/log/segment counts
  - whether player IDs were preserved
- The import endpoint still returns `importSummary`, now using the same replay metadata object.
- The owner sidebar now renders a `调试回放` banner with source room code and import counts.
- The banner is owner-only and separate from `sceneState`, so replay/debug metadata does not pollute AI scene context.
- Static asset cache bust changed to `20260618-replay-labels`.

Regression coverage:
- `test/db.test.mjs` verifies replay metadata is stored and survives `getRoomState()`.
- `test/app.test.mjs` verifies the import API returns replay metadata and exposes it on room reload.
- `test/frontend.e2e.mjs` verifies the create-dialog import flow shows the owner-visible `调试回放` banner with source and count labels.

Verification after this update:
- Local `npm run check`
- Local `npm test` — 129/129 passed
- Local `npm run test:e2e` — 10/10 passed
- Server `npm run check`
- Server `npm test` — 129/129 passed
- Server health/systemd/Nginx/static cache-bust checks — OK
- Public deployment audit — OK, room `ET3PKA`, `aiConfigured: true`

## 2026-06-20 Replay Fixture Export Update

Completed the next debugging workflow after replay import: owner-only replay rooms can now export a compact regression fixture for future AI/check test creation.

What changed:
- `src/export.js` now builds replay fixtures with schema `dm-online-replay-fixture/1.0`.
- New API: `GET /api/rooms/:code/replay-fixture?playerId=...`.
- Access rules:
  - owner only
  - imported replay/debug rooms only
  - non-owner requests return 403; normal live rooms return 409
- Fixture contents include:
  - room metadata, replay source metadata, clipped summary, and parsed scene state
  - anonymized participant refs (`P1`, `P2`, ...), character names, characteristics, skills, discovered clues, known NPCs, and clipped state
  - module title plus clipped segment snippets
  - complete message timeline with anonymized player/target refs
  - player ACTION messages and summarized dice/check results
  - expected AI behavior inferred from `preflight-check` and `structured-events` logs, linked back to action content when possible
  - slim AI logs and `testHints` for action/check/log counts and warning/preflight presence
- The owner-only `调试回放` banner now has a `导出回归用例` button that downloads `dm-online-<CODE>-fixture.json`.
- Static asset cache bust changed to `20260620-replay-fixture`.

Why this matters:
- Bad real sessions can now become durable debugging artifacts without exposing raw player ids.
- The next improvement can consume these fixtures into automated `aiOutput` / API / Playwright regressions instead of hand-copying screenshots or logs.

Regression coverage:
- `test/app.test.mjs` verifies the fixture endpoint, schema, replay metadata, anonymized participant refs, AI behavior hints, and owner-only access.
- `test/frontend.e2e.mjs` imports an owner playtest export, clicks `导出回归用例`, parses the downloaded file, and verifies schema/source/preflight hints.

Verification after this update:
- Local `npm run check`
- Local `node --test test/app.test.mjs` — 13/13 passed
- Local `npm run test:e2e` — 10/10 passed
- Local `npm test` — 129/129 passed
- Server `npm run check`
- Server `npm test` — 129/129 passed
- Server health/systemd/Nginx/static cache-bust checks — OK
- Public deployment audit — OK, room `6XJ2UA`, `aiConfigured: true`

### Current Recommended Next Work

1. Split large frontend/server files before the next broad feature.
   - `public/app.js` is now 2721 lines; `src/db.js`, `src/app.js`, `src/aiOutput.js`, and `src/export.js` are also carrying multiple responsibilities.
   - Best first split: move character-sheet UI, AI log UI, and chat rendering into focused frontend modules.
   - Keep tests green between each extraction; avoid a big-bang refactor.

2. Add a fixture consumer / test generator for replay fixtures.
   - Fixture export now exists; the next step is turning `dm-online-replay-fixture/1.0` files into executable regression tests.
   - Good tooling would load fixture JSON, replay expected preflight/check decisions, and generate focused assertions for `aiOutput`, `app`, and Playwright tests.
   - Start with a read-only script that validates a fixture and prints proposed test cases before auto-writing test files.

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

5. Add replay-room owner actions.
   - `导出回归用例` is done.
   - The next useful action would open the AI log dialog pre-filtered to warnings/preflight for that replay.
   - Another useful action would copy the fixture API path or show a compact replay diagnostics panel.

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
npm run check     # passed on 2026-06-20 16:05 JST
npm test          # 129/129 passed on 2026-06-20 16:05 JST
npm run test:e2e  # 10/10 Playwright tests passed on 2026-06-20 16:05 JST
```

Server:
```bash
cd /opt/dm-online && npm run check
cd /opt/dm-online && npm test                  # 129/129 passed
systemctl restart dm-online
curl -fsS http://127.0.0.1:4173/api/health     # ok: true, aiConfigured: true
systemctl is-active dm-online                    # active
nginx -t                                         # successful
```

Public deployment audit:
```bash
npm run audit:deployment -- http://8.153.147.137
# ok: true, aiConfigured: true, roomCode: 6XJ2UA
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
  --exclude 'reports/' \
  --exclude 'test-results/' \
  --exclude 'playwright-report/' \
  --exclude '测试模组 新/' \
  --exclude '.DS_Store' \
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
- When debugging game sessions, request the owner JSON export (`GET /api/rooms/:code/export?format=json`) to see messages, diceRolls, aiTasks, AI logs, module data, module segments, rounds, scene state, and participant state in context.
- Owner JSON exports can now be imported through the create-room dialog or `POST /api/imports/playtest` to create a replay/debug room. Use this before manually recreating bad sessions.
- Imported replay rooms now persist `room.roomMeta.replay` and show an owner-only `调试回放` banner. Keep replay/debug metadata in `room_meta_json`, not `sceneState`, so AI scene context stays clean.
- Imported replay rooms can now export regression fixtures through the banner button `导出回归用例` or `GET /api/rooms/:code/replay-fixture?playerId=...`. The fixture schema is `dm-online-replay-fixture/1.0` and anonymizes participant refs.
- The AI detection log endpoint (`GET /api/rooms/:code/ai-log`) is owner-only and now reads persistent SQLite `ai_logs`.
- `latestPlayerAction` now prefers explicit `triggerMessageId` and skips `aiProcessedTaskUid` actions — if AI check inference stops working unexpectedly, inspect `ai_tasks.trigger_message_id` and `messages.ai_processed_task_uid` first.

## Potential Follow-Ups

- Add fixture-consumer tooling so exported `dm-online-replay-fixture/1.0` files can become local regression tests quickly.
- Add owner actions to the replay banner for warning/preflight AI-log shortcuts and compact replay diagnostics.
- Tune module check matching with newer real playtest logs from `reports/` after another session.
- Cache NPC candidates per room/task (currently rebuilt every AI call in `npcCandidates()`).
- Split `aiOutput.js`, `db.js`, `app.js`, and `public/app.js` along existing boundaries when next touching those files.
- Consider moving Playwright artifacts or traces to a CI-friendly path if this project gets CI later.
