---
name: deploy
description: 一键部署到远程服务器 8.153.147.137。先本地测试，再同步文件到正确路径，重启服务，验证健康检查。
disable-model-invocation: true
---

# 部署到服务器

服务器信息：`root@8.153.147.137:2233`，密码 `ZZyoung20061018`

## 步骤

### 1. 本地测试

```bash
cd "/Users/young/Documents/dm online" && npm test
```

确保全部通过后再继续。

### 2. 同步文件

**关键规则**：使用完整目标路径，不要只传到 `/opt/dm-online/` 根目录！

```bash
# src 文件 → /opt/dm-online/src/
sshpass -p 'ZZyoung20061018' scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P 2233 \
  "/Users/young/Documents/dm online/src/xxx.js" root@8.153.147.137:/opt/dm-online/src/xxx.js

# public 文件 → /opt/dm-online/public/
sshpass -p 'ZZyoung20061018' scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P 2233 \
  "/Users/young/Documents/dm online/public/xxx.html" root@8.153.147.137:/opt/dm-online/public/xxx.html
```

每个文件用完整路径单独上传，避免 `src/app.js` 和 `public/app.js` 互相覆盖。

### 3. 修复权限并重启

```bash
sshpass -p 'ZZyoung20061018' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2233 root@8.153.147.137 '
chown -R dm-online:dm-online /opt/dm-online /var/lib/dm-online
find /opt/dm-online -name "._*" -delete 2>/dev/null
systemctl restart dm-online
'
```

### 4. 验证

```bash
sshpass -p 'ZZyoung20061018' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2233 root@8.153.147.137 '
echo "=== 服务状态 ===" && systemctl status dm-online --no-pager -l | head -8
echo "" && echo "=== 健康检查 ===" && curl -sf http://127.0.0.1:4173/api/health
echo "" && echo "=== 外网检查 ===" && curl -sf http://8.153.147.137/api/health
echo "" && echo "=== 错误日志 ===" && journalctl -u dm-online --no-pager -n 3 2>&1
'
```
