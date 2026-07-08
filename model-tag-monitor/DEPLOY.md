# 部署指南 · model-tag-monitor

## 连接信息

| 项目 | 值 |
|---|---|
| Host 别名 | `zz-server`（已配置在 `~/.ssh/config`） |
| IP | `47.84.94.234` |
| 端口 | `443`（非标准端口） |
| 用户 | `admin`（uid=1000） |
| 密钥 | `~/.ssh/id_ed25519` |
| sudo | 免密码，`sudo -n` 直接拿 root |

## 系统环境

| 项目 | 值 |
|---|---|
| OS | Ubuntu 22.04.5 LTS |
| 内核 | 5.15.0-142-generic |
| CPU | 2 核 |
| 内存 | 3.4G（可用 ~2.7G） |
| 磁盘 | 49G（可用 ~36G，已用 24%） |

## 工具链

| 工具 | 版本 | 路径 | 注意 |
|---|---|---|---|
| Node.js | v20.20.2 | `/root/.nvm/versions/node/v20.20.2/bin/node` | 不在 admin 用户的 PATH 里，需要写全路径或 `sudo su - -c '...'` |
| npm | 同上 | `/root/.nvm/versions/node/v20.20.2/bin/npm` | 同上 |
| PM2 | 7.0.3 | `/root/.nvm/versions/node/v20.20.2/bin/pm2` | 进程属主是 root，操作必须加 `sudo` |
| rsync | 3.2.7 | `/usr/bin/rsync` | 部署主力工具 |
| git | 2.34.1 | `/usr/bin/git` | 服务器有但生产目录不是 git 仓库 |
| curl | 7.81.0 | `/usr/bin/curl` | 支持 HTTPS/HTTP2/brotli |

## 生产目录结构

```
/root/model-tag-monitor/
├── src/              后端源码（Express）
├── public/           前端静态文件
├── data/             持久化 JSON（飞书同步数据，不入 git，不需要部署）
│   ├── cache.json    ~93MB，机型周维度原始数据
│   ├── tags.json     标签数据
│   ├── tag-vocab.json
│   └── operations.log
├── scripts/          辅助脚本
├── test/             单测
├── node_modules/     依赖（服务器上已 install）
├── package.json
└── ecosystem.config.js   PM2 配置
```

**这个目录不是 git 仓库**，没有 `.git`，不能 `git pull`。

## 部署流程

### 标准部署（改了 src/ 或 public/）

```bash
# 1. 本地文件 → 服务器 /tmp（admin 有写权限）
rsync -avc src/ zz-server:/tmp/src/
rsync -avc public/ zz-server:/tmp/public/

# 2. sudo 搬到生产目录 + 重启进程
ssh zz-server 'sudo cp -r /tmp/src/* /root/model-tag-monitor/src/ && \
  sudo cp -r /tmp/public/* /root/model-tag-monitor/public/ && \
  sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 reload model-tag-monitor'
```

### 如果改了 package.json（加了依赖）

```bash
rsync -avc package.json zz-server:/tmp/package.json
ssh zz-server 'sudo cp /tmp/package.json /root/model-tag-monitor/package.json && \
  cd /root/model-tag-monitor && \
  sudo /root/.nvm/versions/node/v20.20.2/bin/npm install --production && \
  sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 reload model-tag-monitor'
```

### 如果改了 ecosystem.config.js（PM2 配置）

```bash
rsync -avc ecosystem.config.js zz-server:/tmp/ecosystem.config.js
ssh zz-server 'sudo cp /tmp/ecosystem.config.js /root/model-tag-monitor/ecosystem.config.js && \
  sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 reload model-tag-monitor'
```

## PM2 常用操作

```bash
# 所有命令需要 sudo + 全路径
PM2="sudo /root/.nvm/versions/node/v20.20.2/bin/pm2"

# 查看状态
ssh zz-server "$PM2 list"

# 重启（graceful reload，零停机）
ssh zz-server "$PM2 reload model-tag-monitor"

# 强制重启（有短暂停机）
ssh zz-server "$PM2 restart model-tag-monitor"

# 查看日志（实时）
ssh zz-server "$PM2 logs model-tag-monitor --lines 50"

# 查看进程详情（内存/重启次数/uptime）
ssh zz-server "$PM2 describe model-tag-monitor"
```

## 数据同步（飞书 → cache.json）

不需要手动部署，crontab 自动跑：

```
30 9 * * *  /root/workspace/ZZ-AI-Business-Analysis/scripts/机型周数据_cron.sh
```

每天 9:30 从飞书多维表格拉最新周数据写入 `data/cache.json`。

## 验证部署是否成功

```bash
# API 健康检查
ssh zz-server 'curl -s http://127.0.0.1:8848/api/dashboard | python3 -m json.tool | head -20'

# 确认进程在线且没有异常重启
ssh zz-server 'sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 describe model-tag-monitor | grep -E "status|restarts|uptime"'
```

## 注意事项

1. **admin 用户没有直接写 `/root/` 的权限**——所有生产目录操作必须 `sudo`
2. **先部署到 /tmp 再 cp**——不要直接 rsync 到 /root/model-tag-monitor/，admin 写不了
3. **data/ 目录不要碰**——飞书同步数据 93MB，不是代码的一部分，部署时跳过
4. **部署前务必本地跑通**——`npm test` 全过 + 浏览器手测关键页面
5. **部署后务必同步回 git**——改完生产机后，把文件拉回本地仓库 commit + push，别再让生产和仓库脱节（教训详见 HANDOFF_v2.md）
6. **reload 优先于 restart**——`pm2 reload` 是零停机滚动重启，`restart` 会有短暂停机
