---
name: prompt
description: 查看或修改 AI 提示词。提示词集中在 src/prompts.js。用法：/prompt <intro|dm|events|all> 查看，/prompt edit 修改。
---

# 提示词管理

所有 AI 提示词在 `/Users/young/Documents/dm online/src/prompts.js` 统一管理。

## 子命令

### 查看提示词

- `/prompt intro` — 准备阶段模组介绍提示词（`buildIntroSystemPrompt` + `buildIntroUserContext`）
- `/prompt dm` — 游玩阶段 DM 提示词（`buildDmSystemPrompt` + `buildDmUserContext`）
- `/prompt events` — 结构化事件输出指令（`buildStructuredOutputPrompt`）
- `/prompt fallback` — 本地回退文本（`FALLBACK_TEXT`）
- `/prompt all` — 显示全部

### 修改提示词

- `/prompt edit intro` — 修改准备阶段提示词
- `/prompt edit dm` — 修改游玩阶段提示词
- `/prompt edit events` — 修改结构化输出指令

## 提示词函数速查

| 函数 | 用途 | 调用位置 |
|------|------|----------|
| `buildDmSystemPrompt(aiConfig)` | 游玩 DM 系统提示 | `aiClient.js:buildDmMessages()` |
| `buildDmUserContext({...})` | 游玩上下文组装 | `aiClient.js:buildDmMessages()` |
| `buildIntroSystemPrompt(roomCfg)` | 准备阶段提示 | `app.js:generateModuleIntro()` |
| `buildIntroUserContext({...})` | 准备阶段上下文 | `app.js:generateModuleIntro()` |
| `buildStructuredOutputPrompt()` | 结构化事件格式 | `app.js:generateDmReply()` |
| `FALLBACK_TEXT` | API未配置时回退 | `aiClient.js:streamLocalFallback()` |

## 修改注意事项

1. 保持字符串拼接风格与现有代码一致
2. 不要硬编码特定模组名称或角色名
3. 修改后运行 `npm test` 确保 `aiClient.test.mjs` 通过
4. 修改后需要部署到服务器才能生效
