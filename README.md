# Cthulhu AI Keeper

一个多人线上跑团 DM 网站，支持房间、最多 5 名玩家、实时聊天、AI DM 流式回复、SQLite 持久化、房间级 AI 队列、Nginx 反向代理和 systemd 服务。

## 仓库内容

仓库保留应用源码、前端资源、测试、部署脚本和公开配置示例。以下内容属于本地运行或私有素材，不应提交到 GitHub：

- `.env`、数据库和运行数据：`data/`、`*.db*`
- 依赖和测试输出：`node_modules/`、`test-results/`、`playwright-report/`
- 游玩报告与交接笔记：`reports/`、`handoff.md`
- 本地模组源文件：`测试模组*/`

## 本地运行

```bash
npm install
cp .env.example .env
npm test
npm start
```

默认监听 `http://127.0.0.1:4173`。

## 模组格式

当前上传链路仅支持结构化 JSON 模组文件（`.json`，需包含 `schema_version`）。TXT/PDF/DOCX 会被拒绝，以保证 AI DM 能稳定读取场景、NPC、线索、检定和全局规则。

## AI 配置

服务使用 OpenAI-compatible Chat Completions 流式接口：

```bash
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=你的_key
AI_MODEL=gpt-4.1-mini
```

没有配置外部模型时，`AI_LOCAL_FALLBACK=true` 会启用本地占位流式回复，便于测试房间、聊天和流式 UI。正式部署时请设置真实的 `AI_API_KEY` 和 `AI_MODEL`。推荐先使用 `gpt-4.1-mini` 这类响应较快且流式输出稳定的模型，再按预算和质量需求调整。

服务器上可以用下面的方式安全写入配置并重启服务；脚本不会把密钥打印到终端：

```bash
AI_BASE_URL=https://api.openai.com/v1 \
AI_MODEL=gpt-4.1-mini \
AI_API_KEY=你的_key \
bash deploy/configure_ai.sh
```

## 部署

将仓库复制到服务器后，以 root 身份执行：

```bash
bash deploy/install_server.sh
```

脚本会安装 Node 22、Nginx，执行 `npm install` 和 `npm test`，然后安装 systemd 服务与 Nginx 反代配置。

部署后的主要路径：

- 应用目录：`/opt/dm-online`
- SQLite 数据：`/var/lib/dm-online/dm-online.db`
- 环境变量：`/etc/dm-online.env`
- 服务：`dm-online.service`
- Nginx 站点：`/etc/nginx/conf.d/dm-online.conf`

常用排错命令：

```bash
systemctl status dm-online --no-pager
journalctl -u dm-online -n 100 --no-pager
nginx -t
curl -s http://127.0.0.1:4173/api/health
```

## 线上审计

部署后可从任意能访问服务器的机器运行：

```bash
npm run audit:deployment -- http://your-server.example
```

外部 AI 配置完成后运行严格模式：

```bash
npm run audit:deployment -- http://your-server.example --require-ai
```
