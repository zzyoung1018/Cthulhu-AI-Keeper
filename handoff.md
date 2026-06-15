# DM Online Handoff

Last updated: 2026-06-15 12:45 CST

## Current State

- Local repo: `/Users/young/Documents/dm online`
- Deployed app: `http://8.153.147.137`
- Server app path: `/opt/dm-online`
- SSH port: `2233`
- Service: `dm-online` managed by systemd
- Reverse proxy: Nginx
- Database: SQLite, server data preserved under `/opt/dm-online/data`
- Current local branch: `main`
- Current latest commit: `ea2a9e4 fix: add continue action after checks`
- Local worktree was clean after the last deployment.

Do not write server credentials into committed files. Use the conversation context or ask the user if credentials are needed again.

## Recent Commits

- `ea2a9e4 fix: add continue action after checks`
- `80da90d chore: checkpoint before continue action UI fix`
- `2f6ded8 fix: execute ai required checks`
- `b599c4c chore: checkpoint before ai detection execution fix`
- `32b6edf fix: avoid reinferring saved skill allocations`
- `0c55b14 fix: persist skill allocations in character sheets`

## What Was Just Finished

### AI Detection And Structured Events

The backend now has stronger structured-event handling for AI DM output.

Key files:

- `src/prompts.js`
- `src/aiOutput.js`
- `src/app.js`
- `src/character.js`
- `src/playerState.js`
- `test/aiOutput.test.mjs`
- `test/app.test.mjs`
- `test/character.test.mjs`

Important behavior:

- The prompt now requires a final parseable ```json block and distinguishes:
  - `opposed_checks`: active opposition such as lying, persuasion, intimidation, stealth past NPCs, theft, attack.
  - `required_checks`: static/environment checks such as Spot Hidden, Listen, Library Use, Lockpick, First Aid, Medicine, Driving, Climb, attributes.
- `required_checks` are no longer only validated. They now execute:
  - Resolve target player from `targetPlayerId`, falling back to the triggering player.
  - Resolve skill or attribute with `getCheckTarget`.
  - Roll server-side `skill_check`.
  - Save to `dice_rolls`.
  - Broadcast a `必要检定` system message.
- Supported attribute aliases include English keys and Chinese labels such as `DEX/敏捷`, `POW/意志`, `Luck/幸运`.
- AI player-state JSON now includes all skills above 0, not just the top 20.
- If the latest player action must be an opposed check but the model incorrectly returns `required_checks`, those required checks are dropped and backend-inferred or model-provided `opposed_checks` take precedence.
- Fixed a false positive where words like `隐藏暗格` or `隐藏痕迹` triggered stealth detection.

Regression coverage added:

- Lying -> `话术` vs `心理学`
- Persuasion -> `说服` vs `心理学`
- Intimidation -> `恐吓` vs `心理学`
- Stealth -> `潜行`
- Theft -> `妙手`
- Attack -> `格斗`
- Ordinary Spot Hidden -> `侦查`
- Library Use -> `图书馆使用`
- Required checks execute through the room API and create server-side dice rolls.

### Continue Button After Checks

The user reported that after an opposed check result there was no interaction button to continue.

Key files:

- `public/app.js`
- `public/styles.css`
- `src/prompts.js`
- `test/aiOutput.test.mjs`

Implemented behavior:

- After the latest `对抗检定` or `必要检定` system message, if:
  - the room is `ACTIVE`,
  - the current participant exists,
  - there is no active AI task,
  - no later player ACTION or DM message already continued,
  then the chat log shows a `继续叙事` button below the check result.
- Clicking the button submits this ACTION:
  - `继续：请根据刚才的检定结果推进剧情。`
- The action uses an idempotency key based on the check message id:
  - `continue:<checkMessageId>`
- Once clicked, the button disappears because a later player ACTION now exists.
- Prompt now says that when the latest action is continue, the model must use the latest dice/system check result and must not repeat the same check.

Browser verification done locally:

- Created a temporary local room with an existing `对抗检定` result.
- Verified exactly one `继续叙事` button appeared.
- Clicked it.
- Verified the button disappeared, a continue ACTION was created, and AI generation was triggered.

## Verification Already Run

Local:

```bash
npm run check
npm test
```

Result:

- `npm run check`: passed
- `npm test`: 62/62 passed

Server:

```bash
cd /opt/dm-online && npm install && npm test
systemctl restart dm-online
curl -fsS http://127.0.0.1:4173/api/health
systemctl is-active dm-online
nginx -t
```

Result:

- `npm install`: up to date, 0 vulnerabilities
- `npm test`: 62/62 passed
- Health endpoint returned `ok: true`, `aiConfigured: true`, `localFallback: false`
- `systemctl is-active dm-online`: `active`
- `nginx -t`: successful

Public deployment audit:

```bash
npm run audit:deployment -- http://8.153.147.137
```

Latest audit result:

- `ok: true`
- `roomCode: FDHS83`
- `aiConfigured: true`
- `dmMessageId: 420`

Server logs showed the public audit AI returned `required_checks`, and `apply-events` applied them.

## Deployment Command Used

From local repo:

```bash
SSHPASS='<password from user/context>' rsync -az --delete \
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
SSHPASS='<password from user/context>' sshpass -e ssh -p 2233 \
  -o StrictHostKeyChecking=accept-new \
  root@8.153.147.137 \
  'cd /opt/dm-online && npm install && npm test'

SSHPASS='<password from user/context>' sshpass -e ssh -p 2233 \
  -o StrictHostKeyChecking=accept-new \
  root@8.153.147.137 \
  'systemctl restart dm-online && sleep 1 && curl -fsS http://127.0.0.1:4173/api/health; echo; systemctl is-active dm-online; nginx -t'
```

## Notes For Next Agent

- The user prefers autonomous fixes and deployment.
- Original instruction included making a Git commit before major modifications. Keep doing checkpoint commits before substantial changes.
- Use `apply_patch` for manual file edits.
- Do not overwrite unrelated user changes if the worktree is dirty.
- For frontend changes, use the Browser plugin/in-app browser for verification when practical.
- Keep deployment exclusions so server DB, `.env`, and runtime data are not deleted.
- Avoid committing secrets.

## Potential Follow-Ups

- Add a dedicated automated frontend test for the `继续叙事` button. It is currently browser-verified manually, not covered by Node tests.
- Consider changing the continue ACTION text to a less visible/system-like phrasing if the user wants it hidden from normal chat.
- Consider adding a backend endpoint for "continue after check" so the front end does not need to create a visible player ACTION.
- Consider showing the continue button only to the acting player, if multiplayer UX requires that. Currently any participant in the active room can see/use it when no active AI task exists.
- Consider adding richer result-aware prompt examples for failed vs successful opposed checks.
