# DM Online Handoff

Last updated: 2026-06-15 18:00 CST

## Current State

- Local repo: `/Users/young/Documents/dm online`
- Deployed app: `http://8.153.147.137`
- Server app path: `/opt/dm-online`
- SSH: `root@8.153.147.137 -p 2233`
- Service: `dm-online` managed by systemd
- Reverse proxy: Nginx
- Database: SQLite, server data preserved under `/opt/dm-online/data`
- Current local branch: `main`
- Current latest commit: `2e1d80d refactor: remove dead code, fix double normalization, extract aiEvents module`
- Local worktree is clean.

Do not write server credentials into committed files. Use the conversation context or ask the user if credentials are needed again.

## Recent Commits

- `2e1d80d` refactor: remove dead code, fix double normalization, extract aiEvents module
- `b95ab3f` docs: add handoff notes
- `ea2a9e4` fix: add continue action after checks
- `80da90d` chore: checkpoint before continue action UI fix
- `2f6ded8` fix: execute ai required checks
- `b599c4c` chore: checkpoint before ai detection execution fix
- `32b6edf` fix: avoid reinferring saved skill allocations
- `0c55b14` fix: persist skill allocations in character sheets

## Architecture Changes (2026-06-15 Session)

### File Structure

```
src/
  aiClient.js      (208 lines) — streaming, buildDmMessages
  aiEvents.js      (331 lines) — NEW: extracted from app.js
  aiOutput.js      (801 lines) — structured event parsing + validation
  aiQueue.js        (28 lines) — per-room serial AI queue
  aiSettings.js    (102 lines) — AI config merge logic
  app.js           (965 lines) — routing, room lifecycle, AI orchestration
  character.js     (368 lines) — CoC 7e character model
  config.js         (36 lines) — env config loader
  db.js           (1206 lines) — SQLite schema, migrations, queries
  dice.js         (438 lines) — CoC 7e dice mechanics
  errors.js         (29 lines) — HttpError class
  export.js        (156 lines) — JSON/Markdown export
  http.js           (72 lines) — JSON read/send, static file serving
  moduleParser.js  (347 lines) — module upload + segmentation
  multipart.js      (65 lines) — multipart form parsing
  playerState.js   (123 lines) — per-player state JSON builder
  privateHub.js     (63 lines) — player-specific SSE delivery
  prompts.js       (241 lines) — AI prompt templates
  rounds.js         (76 lines) — round records + rollback
  server.js         (38 lines) — entry point
  sse.js            (80 lines) — SSE room event hub
test/
  aiClient.test.mjs            (96 lines)
  aiOutput.test.mjs           (391 lines)
  app.test.mjs                (298 lines)
  character.test.mjs           (86 lines)
  comprehensive-ai.test.mjs   (NEW, 27 tests) — AI detection coverage
  db.test.mjs                 (697 lines)
  dice.test.mjs               (251 lines)
  moduleParser.test.mjs       (143 lines)
  queue.test.mjs               (38 lines)
  fixtures/
    comprehensive-test-module.json  (NEW) — full test module
```

### Key Changes

1. **Dead code removed** (`aiClient.js`):
   - Removed `estimateTokens`, `trimToBudget`, `DEFAULT_TOKEN_BUDGET` — the function was building a token-budget-aware `userContent` but returning untrimmed `userContext` from `buildDmUserContext`. The user prefers full context to the AI model.
   - Removed unused destructured variables `po` (player_opening) and `sp` (story_progression).

2. **Duplicate branch removed** (`aiOutput.js`):
   - `validateBySchema` had an unreachable `if (schema === 'string')` at line 281-283 — already handled at line 234-236.

3. **Double normalization fixed** (`character.js`):
   - Extracted internal `_lookupSkill(normalizedSheet, skillName)` helper.
   - `getSkillTarget` and `getCheckTarget` now share one `normalizeCharacterSheet` call instead of two.

4. **`app.js` split** → new `src/aiEvents.js`:
   - Extracted 7 functions via factory pattern `createEventApplier({ database, hub, addAiLog })`:
     - `applyStructuredEvents` — applies all structured events to room state
     - `applyRequiredCheck` — server-side skill/attribute check execution
     - `applyStateChange` — character sheet state mutation
     - `resolveDefaultCheckPlayerId`, `normalizeCheckDifficulty`, `difficultyText`, `successText`
   - `app.js` reduced from 1285 to 965 lines (-25%).

5. **Bug fixed — NPC skill lookup from module JSON**:
   - `applyStructuredEvents` was trying to access `state.moduleJson?.npcs` from `database.getRoomState`, but `getRoomState` never populates `moduleJson`.
   - NPC skills from module JSON were **never used** — always fell back to role-based defaults (50/65/55/40/35).
   - Fixed: `generateDmReply` now passes `state.moduleJson` directly to `applyStructuredEvents(code, taskUid, valid, dmMessageId, state.moduleJson)`.

6. **Unused destructured variables removed** (`app.js` `generateModuleIntro`):
   - Removed `sp` (story_progression) — destructured but never referenced.

### AI Detection Test Suite

New file `test/comprehensive-ai.test.mjs` — 27 tests covering all AI detection paths:

| Category | Tests | Covered |
|----------|-------|---------|
| Social opposed checks | 4 | 话术, 说服, 恐吓, 魅惑 |
| Stealth opposed checks | 3 | 潜行, 妙手, 乔装 |
| Combat opposed checks | 2 | 格斗, 射击 |
| Required checks | 3 | 侦查, 图书馆使用, 聆听 |
| Priority & inference | 2 | opposed > required, NPC pronoun resolution |
| Narrative sanitization | 2 | strip suggestions, trim decisive outcomes |
| Structured events | 5 | scene change, multi-check, state changes, NPC states, rejection |
| Module & character | 3 | moduleJson NPC skills, Chinese skill/attribute aliases |
| JSON parsing | 1 | multi-block merge |
| Module structure | 2 | schema validation, NPC skill definitions |

Test module fixture at `test/fixtures/comprehensive-test-module.json` — "东乡招待所失踪事件":
- 8 NPCs with skills (顾振兴, 陈友, 林处长, 马大胆, 保安, 板寸头, 吴秀梅, 白崇礼)
- 5 scenes (lobby, room301, kitchen, basement, police_station)
- 5 clues (3 core + 2 secondary)
- 6 checks (spot hidden ×4, library use ×1, listen ×1)
- 3 endings (good, partial, bad)
- AI DM global rules explicitly requiring opposed_checks for NPC interactions

### AI Detection Logic (`src/aiOutput.js`)

**Opposed check detection** (`ACTION_DETECTION_RULES`):

| Type | activeSkill | passiveSkill | Trigger patterns |
|------|-------------|--------------|-----------------|
| social | 话术 | 心理学 | 撒谎, 说谎, 骗, 忽悠, 假装, 伪装, 冒充, 掩饰, 隐瞒, 套话 |
| social | 说服 | 心理学 | 说服, 劝说, 请求, 交涉, 谈判, 打动, 安抚 |
| social | 恐吓 | 心理学 | 恐吓, 威胁, 吓唬, 逼问, 震慑, 拔刀, 亮武器 |
| social | 魅惑 | 心理学 | 魅惑, 讨好, 套近乎, 献殷勤, 寒暄 |
| stealth | 潜行 | 侦查 | 潜行, 偷偷, 悄悄, 跟踪, 尾随, 躲藏, 溜进, 潜入 |
| stealth | 妙手 | 侦查 | 偷, 扒, 摸走, 顺走, 悄悄拿, 藏起 |
| stealth | 乔装 | 心理学 | 乔装, 易容, 伪装成, 扮成, 假扮 |
| combat | 格斗 | 闪避 | 攻击, 偷袭, 刺杀, 挥拳, 打, 砍, 制服 |
| combat | 射击 | 闪避 | 射击, 开枪, 枪击, 手枪, 步枪, 瞄准 |

**Required check detection** (`REQUIRED_CHECK_DETECTION_RULES`):

| Skill | Difficulty | Trigger patterns |
|-------|-----------|-----------------|
| 图书馆使用 | REGULAR | 查资料, 查阅, 翻阅, 检索, 档案, 卷宗, 文献, 报纸 |
| 侦查 | REGULAR | 侦查, 观察, 查看, 检查, 搜索, 搜查, 翻找, 打量, 环顾 |
| 聆听 | REGULAR | 聆听, 倾听, 听一听, 听声音, 脚步, 动静 |

**Priority**: If the latest ACTION triggers an opposed check rule, any model-provided `required_checks` are dropped. Opposed checks always take precedence.

**NPC name inference** (`NPC_ALIAS_PAIRS` + `npcCandidates`):
- First checks action text for explicit NPC names/aliases.
- Falls back to pronoun resolution (`他/她/对方/那人`) using narrative and recent chat context.
- Module NPCs dynamically merged with hardcoded alias pairs.

## Previously Finished Features

### AI Detection And Structured Events

The backend has stronger structured-event handling for AI DM output.

Key behavior:
- The prompt requires a final parseable ` ```json ` block distinguishing `opposed_checks` vs `required_checks`.
- `required_checks` execute server-side: resolve target player, resolve skill/attribute via `getCheckTarget`, roll `skill_check`, save to `dice_rolls`, broadcast system message.
- Supported attribute aliases: English keys and Chinese labels (`DEX/敏捷`, `POW/意志`, `Luck/幸运`).
- AI player-state JSON includes all skills above 0, not just top 20.
- Fixed false positive where `隐藏暗格` or `隐藏痕迹` triggered stealth detection.

### Continue Button After Checks

After an opposed/required check system message, if the room is ACTIVE and no active AI task, the chat log shows a `继续叙事` button.
- Clicking submits ACTION: `继续：请根据刚才的检定结果推进剧情。`
- Idempotency key: `continue:<checkMessageId>`
- Button disappears once a later player ACTION exists.
- Prompt instructs model to use the latest dice/check result without repeating the same check.

## What Was Just Finished

### Code Quality Refactor (commit `2e1d80d`)

- Removed ~80 lines of dead token-budget code from `aiClient.js`
- Removed unreachable branch in `aiOutput.js` `validateBySchema`
- Fixed double `normalizeCharacterSheet` in `character.js`
- Extracted `src/aiEvents.js` from `app.js` (320 lines out)
- Fixed NPC skill lookup from module JSON (was silently broken)
- Added 27 comprehensive AI detection tests
- Created reusable test module fixture

## Verification Already Run

Local:
```bash
npm run check   # passed
npm test        # 89/89 passed
```

Server:
```bash
cd /opt/dm-online && npm install && npm test   # 89/89 passed, 0 vulnerabilities
systemctl restart dm-online
curl -fsS http://127.0.0.1:4173/api/health     # ok: true, aiConfigured: true
systemctl is-active dm-online                    # active
nginx -t                                         # successful
```

Public deployment audit:
```bash
npm run audit:deployment -- http://8.153.147.137
# ok: true, aiConfigured: true, dmMessageId: 426
```

## Deployment Command

From local repo:
```bash
SSHPASS='<password>' rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'reports/' \
  --exclude '.local/' \
  --exclude '.env' \
  -e 'sshpass -e ssh -p 2233 -o StrictHostKeyChecking=accept-new' \
  ./ root@8.153.147.137:/opt/dm-online/
```

Then:
```bash
SSHPASS='<password>' sshpass -e ssh -p 2233 root@8.153.147.137 \
  'cd /opt/dm-online && npm install && npm test'

SSHPASS='<password>' sshpass -e ssh -p 2233 root@8.153.147.137 \
  'systemctl restart dm-online && sleep 1 && curl -fsS http://127.0.0.1:4173/api/health; echo; systemctl is-active dm-online; nginx -t'
```

## Notes For Next Agent

- The user prefers autonomous fixes and deployment.
- Keep doing checkpoint commits before substantial changes.
- Use `Edit` for file edits, `Write` for new files.
- Do not overwrite unrelated user changes if the worktree is dirty.
- Keep deployment exclusions so server DB, `.env`, and runtime data are not deleted.
- Avoid committing secrets.
- Test module fixture at `test/fixtures/comprehensive-test-module.json` can be uploaded via the API to manually verify AI detection in a real room.
- `src/aiEvents.js` uses a factory pattern — `createEventApplier({ database, hub, addAiLog })` returns `{ applyStructuredEvents }`. If adding new event types, extend this module, not `app.js`.
- NPC skill lookup from module JSON now works — ensure `moduleJson` is passed as the 5th argument to `applyStructuredEvents`.
- `getSkillTarget` and `getCheckTarget` in `character.js` call `normalizeCharacterSheet` once via internal `_lookupSkill`. When calling from places that already have a normalized sheet, consider using `_lookupSkill` directly (currently not exported).

## Potential Follow-Ups

- Add a dedicated automated frontend test for the `继续叙事` button.
- Consider changing the continue ACTION text to a less visible/system-like phrasing.
- Consider adding a backend endpoint for "continue after check" so the frontend doesn't create a visible player ACTION.
- Consider showing the continue button only to the acting player in multiplayer.
- Consider adding richer result-aware prompt examples for failed vs successful opposed checks.
- Cache NPC candidates per room (currently rebuilt on every AI call from `npcCandidates()`).
- Add TTL-based eviction for `_aiLogs` map (currently only cleared on ENDED/ARCHIVED).
- Split `db.js` (1206 lines) into schema / row-mappers / queries.
- Split `public/app.js` (1993 lines) into lobby / character / chat modules.
