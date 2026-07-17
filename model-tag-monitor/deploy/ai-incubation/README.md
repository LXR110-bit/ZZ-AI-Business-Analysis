# AI 孵化区迁移 Runbook · model-tag-monitor

本目录是 `model-tag-monitor` 从旧服务器迁移到公司 AI 孵化区主机的可执行资产包。源码基准为本地仓库 `ai数据分析工作流`，部署源迁移到 gitclaw Private 仓库后，新服务器只从 gitclaw 拉取代码。

## 0. 安全前置

- 不要把 Git token、SSH 私钥、飞书 App Secret、模型 API Key、看板访问码写进聊天、Git、日志或命令历史。
- 如果 token 已经进入聊天或日志，必须立刻 revoke 并重新生成。
- `ACCESS_CODE` 必须从 `/root/secrets/.env` 或 systemd 环境文件注入；生产环境禁止依赖硬编码兜底。
- GitHub 仅作为历史备份；新服务器部署源为 gitclaw Private。

## 1. 需要用户提供的非敏感信息

| 信息 | 示例 | 说明 |
|-|-|-|
| 新机实例 ID | `ins-xxx` | 飞书开通通知里获取 |
| 新机内网 IP | `10.x.x.x` | 用于堡垒机内 `root@<ip>` 登录 |
| OA 账号 | `name` | 堡垒机登录名 |
| gitclaw 仓库 URL | `https://gitclaw.../ZZ-AI-Business-Analysis.git` | Private 项目地址 |
| 看板访问入口 | `http://<新机内网IP>/` | 有内网域名时替换为域名 |
| 迁移窗口 | `20:00-20:30` | 默认非 06:50 调度窗口 |

不要提供密码或 token；需要 token 的步骤使用交互输入或 credential helper。

## 2. 本地仓库迁移步骤

在本地源码目录执行：

```bash
cd /Users/lilixiaoran/工作/转转/ai数据分析工作流
bash model-tag-monitor/deploy/ai-incubation/scripts/local-preflight.sh
```

确认无敏感信息后，将 GitHub remote 保留为 `github`，gitclaw 设为新的 `origin`：

```bash
bash model-tag-monitor/deploy/ai-incubation/scripts/setup-gitclaw-remote.sh \
  'https://<gitclaw-host>/<group>/ZZ-AI-Business-Analysis.git'
```

首次 push 时不要把 token 写入 URL；让 Git 交互提示输入用户名和新生成 token，或提前配置系统 credential helper。

```bash
git push -u origin main
git push origin --tags
```

### 2.1 本机到目标主机的文件上传通道

AI 孵化区主机经堡垒机登录时，如果不能从办公电脑直接 `scp`/`rsync` 到目标主机，用本机 Python 临时 HTTP 服务，让目标主机从办公电脑下载文件。对办公电脑来说是“上传”，对服务器来说是“下载”。

AI Agent 读取区：

```text
通道：本机 python3 http.server (port 23456) -> 目标主机 wget
约束：端口必须为 23456；目的侧办公网 IP 段优先使用 10.238.0.0/16 或 10.240.0.0/16
原因：安全组出向规则仅放通办公网 TCP 23456
辅助：本地 IP 获取、python3 安装、目标机 wget 命令可由 AI 代为执行
```

```bash
# Step 1：在本地待上传文件所在目录执行，端口必须监听 23456
python3 -m http.server 23456

# Step 2：获取本机办公网 IP
ifconfig | awk '/inet / {print $2}' | grep -E '^(10\.238\.|10\.240\.)'
```

然后经堡垒机登录目标主机，在目标主机执行：

```bash
# Step 3：在目标主机下载文件，把 <office_ip> 和 <filename> 换成真实值
wget http://<office_ip>:23456/<filename>
```

2026-07-16 本机实测 IP 为 `10.242.26.7`，不在当前文档写明的 `10.238.*`/`10.240.*` 范围内；如果目标机下载失败，先切换办公网/VPN 到放通网段，或让运维确认是否放通 `10.242.0.0/16`。

## 3. 新服务器初始化

经堡垒机进入新机后，先只读检查：

```bash
bash server-preflight.sh
```

检查通过后，按 AI 孵化区目录约定创建：

```bash
mkdir -p /opt/soft/model-tag-monitor/{app,conf,releases}
mkdir -p /opt/data/model-tag-monitor/{current,releases,snapshots,raw}
mkdir -p /opt/log/model-tag-monitor/{nginx,worker,release,migration}
```

安装 Node.js 20、npm、Python 3.11、uv、git、nginx、jq、curl、rsync、tar、lark-cli。pip/npm 优先使用国内镜像。

## 4. 应用部署

```bash
git clone <gitclaw-private-url> /opt/soft/model-tag-monitor/app
cd /opt/soft/model-tag-monitor/app/model-tag-monitor
npm ci --omit=dev
```

复制模板并按机器实际情况替换占位：

```bash
cp deploy/ai-incubation/templates/model-tag-monitor.env.example /opt/soft/model-tag-monitor/conf/model-tag-monitor.env
cp deploy/ai-incubation/templates/model-tag-monitor-nginx.conf /etc/nginx/conf.d/model-tag-monitor.conf
cp deploy/ai-incubation/templates/model-tag-monitor-api.service /etc/systemd/system/model-tag-monitor-api.service
cp deploy/ai-incubation/templates/model-tag-monitor-refresh.service /etc/systemd/system/model-tag-monitor-refresh.service
cp deploy/ai-incubation/templates/model-tag-monitor-refresh.timer /etc/systemd/system/model-tag-monitor-refresh.timer
```

`/opt/soft/model-tag-monitor/conf/model-tag-monitor.env` 中填入真实 secrets；不要提交回 Git。API service 使用 `HOST=127.0.0.1`，只供本机刷新脚本调用，办公网入口由 Nginx 提供。

## 5. 静态看板发布

生产目标是 Nginx 服务单页和 `/data/dashboard.json`。刷新脚本生成/校验 dashboard 后，用 `scripts/publish-dashboard-json.js` 原子发布：

```bash
cd /opt/soft/model-tag-monitor/app/model-tag-monitor
ACCESS_CODE='<从环境文件读取，不要写进历史>' \
node scripts/publish-dashboard-json.js \
  --api-base http://127.0.0.1:8848 \
  --out-dir /opt/data/model-tag-monitor/current \
  --dashboard-url /data/dashboard.json
```

正式定时任务由 systemd timer 执行；切换前先 `FEISHU_DRY_RUN=1` 演练。

## 6. 切换和回滚

切换窗口内：停旧机 cron → 新机最后一次刷新 → 校验 `/health`、`/data/dashboard.json`、页面 → 更新访问入口 → 启用新机 timer。

回滚：停新机 timer，恢复旧机 cron 和旧看板地址，保留新机 `/opt/log/model-tag-monitor` 与 `/opt/data/model-tag-monitor/snapshots` 供排查。
