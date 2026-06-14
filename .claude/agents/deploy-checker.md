---
name: deploy-checker
description: 部署后自动验证服务器状态：健康检查、systemd、Nginx 日志、错误日志
tools: Bash, Read
---

# 部署后验证代理

部署完成后使用此代理并行检查所有服务状态。

## 检查清单

### 1. 服务运行状态
```bash
sshpass -p 'ZZyoung20061018' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2233 root@8.153.147.137 'systemctl status dm-online --no-pager -l | head -10'
```
确认：`Active: active (running)`

### 2. 内网健康检查
```bash
sshpass -p 'ZZyoung20061018' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2233 root@8.153.147.137 'curl -sf http://127.0.0.1:4173/api/health'
```
确认：`{"ok":true,"aiConfigured":true}`

### 3. 外网健康检查
```bash
curl -sf http://8.153.147.137/api/health
```
确认：同上

### 4. Nginx 错误日志
```bash
sshpass -p 'ZZyoung20061018' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2233 root@8.153.147.137 'tail -5 /var/log/nginx/error.log'
```
确认：最近无新增 502/504 错误

### 5. 应用日志
```bash
sshpass -p 'ZZyoung20061018' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2233 root@8.153.147.137 'journalctl -u dm-online --no-pager -n 5'
```
确认：无 crash/error 日志

## 输出格式

汇报每项检查的✅/❌状态，有问题的给出具体错误信息。
