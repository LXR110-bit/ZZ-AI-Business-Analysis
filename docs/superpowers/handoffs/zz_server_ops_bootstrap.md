# zz-server 运维手册

> 生产服务器 `47.84.94.234` 的入口清单、凭据取用方法、部署套路。
> 首版：2026-07-04 主控 Agent（基于早期 kiro 会话上线 log 整理）
> 未来任何 sub-agent 接手部署 / 排障时先读这份。

---

## 一、服务器基本信息

| 项 | 值 |
|---|---|
| 公网 IP | `47.84.94.234` |
| 用户 | `root`（pm2 以 root 起） |
| SSH 端口 | `22`（有备用 `443` 走 sshd，走 443 是"绕防火墙"设计） |
| ufw 防火墙 | 默认 DROP，白名单开放：22 / 443 / 8848 |
| Node 版本 | v20 |
| 进程管理 | pm2（fork 模式，**不要用 cluster**，跟 Express 有兼容问题） |

---

## 二、当前跑的服务

### `model-tag-monitor`（dashboard）

| 项 | 值 |
|---|---|
| 目录 | `/root/model-tag-monitor/` |
| 入口 | `server.js`（Express） |
| 端口 | `8848`（HTTP，无 HTTPS） |
| 公网入口 | `http://47.84.94.234:8848/` |
| 数据目录 | `/root/model-tag-monitor/data/`（cache.json / tags.json / rules.json） |
| 日志目录 | `/root/model-tag-monitor/logs/` |
| pm2 进程名 | 查 `pm2 list` |

**REST 端点**（前端在用）：
- `GET /api/monitor` — 监测结果（2.8MB，全量 pool + watchList）
- `GET /api/data` — 全量宽表（62MB，性能 tech debt）
- `GET /api/meta` — 元数据（周次、品类、同步时间）
- `GET /api/rules` / `PUT /api/rules` — 规则读写
- `GET /api/tags` / `PUT /api/tags/:key` / `POST /api/tags/import` — 标签
- `GET /api/tag-vocab` / `PUT /api/tag-vocab` — 标签字典
- `GET /api/logs?limit=` — 操作日志
- `GET /api/health` — 心跳
- `GET /api/dashboard` — 前端 Agent 本地已实现，**未部署**（curl 生产 404）
- `POST /api/sync` — 触发飞书同步（60~90 秒，26 段分页读）

**数据规模**（2026-07-04 快照）：
- 131,897 行 × 137 品类 × 4 周历史（W23 → W26）

---

## 三、飞书凭据（`cli_aab4e49b7bb95bd3`）

**不要把 app_secret 明文写进代码 / 环境变量**。服务器上有 lark-channel-bridge 的加密 keystore。

### 从 keystore 取 secret 的正确姿势

```bash
# 协议：{protocolVersion: 1, provider: <name>, ids: [<id>]}
# provider 从 bridge config 取，通常叫 bridge
echo '{"protocolVersion":1,"provider":"bridge","ids":["<secret-id>"]}' \
  | sudo <path-to-bridge> secrets get
# 返回结构：parsed.values[<secret-id>] = "<32 位 secret>"
```

**Node 侧要用 spawn 不能用 execFile**：
- `execFile` 的 `input` 选项不生效，stdin 不关，bridge 会 hang
- 用 `spawn` + `stdin.end()` 显式关闭

### 拿 tenant_access_token 跑通认证

```bash
curl -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"cli_aab4e49b7bb95bd3","app_secret":"<从 keystore 取>"}'
```

### 目标飞书表

| 项 | 值 |
|---|---|
| 表标题 | 机型维度漏斗数据中间表（6月） |
| node_token | `LaXdwebItiEBZwkr6NvcEEM0nlg` |
| obj_token | `TzkVs1LVshLaZjtH1nzcG4opnxb` |
| obj_type | `sheet`（是电子表格 sheets，**不是** bitable / wiki 普通表） |
| 授权状态 | wiki + sheets API 都已授权 |

**其他月份的表**（在 `constants.py`）：`TzkVs1...` + `LIIns3...`（5/6 月汇总 token）

---

## 四、飞书表头映射（血泪教训）

第一次同步时以为字段叫 `估价UV`，实际叫 `估价UV汇总`——**所有字段都带"汇总"后缀**。归一化后差点丢 13 万行。

正确的映射（`sync.js`）：
- 品类 → **品类名称**
- 估价UV → **估价UV汇总**
- 下单UV → **下单UV汇总**（同类：下单量 / 发货量 / 质检量 / 成交量 / 退回量 / 成交GMV 全带"汇总"）
- 机况UV → **机况UV汇总**
- 开始日期 → **周开始**
- 结束日期 → **周结束**
- 机型ID → 机型ID（无汇总后缀）
- 机型名称 → 机型名称（无汇总后缀）
- 统计周 → 统计周（无汇总后缀）
- 新增字段 → 已收到天数

---

## 五、部署套路

### 从本地推到服务器

```bash
# rsync 增量同步（比 scp 快、比 git clone 干净）
rsync -avz --delete \
  --exclude 'node_modules' --exclude 'data' --exclude 'logs' --exclude '.git' \
  ./model-tag-monitor/ root@47.84.94.234:/root/model-tag-monitor/
```

### 装依赖 / 重启

```bash
# 一定要 sudo bash -c 一次性 cd + install（分开 cd 会失败）
ssh root@47.84.94.234 "bash -c 'cd /root/model-tag-monitor && npm install --omit=dev'"

# pm2 重启（fork 模式）
ssh root@47.84.94.234 "pm2 restart model-tag-monitor --update-env"
```

### 首次启动

```bash
ssh root@47.84.94.234 "pm2 start /root/model-tag-monitor/server.js \
  --name model-tag-monitor \
  --interpreter node \
  --log /root/model-tag-monitor/logs/pm2.log"
ssh root@47.84.94.234 "pm2 save"    # 让 pm2 startup 后自动拉起
```

### 手动触发飞书同步（首次或需要刷数）

```bash
curl -X POST http://127.0.0.1:8848/api/sync  # 服务器本机
# 或者从公网：
curl -X POST http://47.84.94.234:8848/api/sync
# 60~90 秒返回，26 段分页读
```

---

## 六、排障备忘

**pm2 errored 但日志空** → 用 fork 模式（不是 cluster）。cluster 跟 Express 兼容有问题。

**secrets get 卡住不返回** → Node 里用了 `execFile` 的 `input`，改 `spawn` + `stdin.end()`。

**ssh 命令 exit 255 但操作其实完成了** → pkill / kill 波及了 sshd。分步跑，别在一条 ssh 里 pkill。

**外网访问不通** → 检查 ufw：`ufw status`。生产开的白名单端口：22 / 443 / 8848。加新端口：`ufw allow 8848/tcp`。

**443 端口冲突** → **不是 nginx / caddy**，是 sshd 借道 443。上 Web 反代前要给 sshd 换端口或用别的方案。

---

## 七、当前 SSH 通不了怎么办（2026-07-04 用户情况）

用户在**台湾 HiNet 热点**，HiNet 出口路由不通 `47.84.94.234:22`。已确认：
- 8848 端口从**用户本地**可以通（前面 curl 拿到 `/api/monitor` 2.8MB）
- 22 端口从**用户本地**通不了 → 无法 rsync / ssh 部署

**候选解法**（用户选）：
- **换网络**（4G 热点 / 蒲公英 / 咖啡厅 WiFi）—— 最简单
- **公司 VPN** —— 如果公司有
- **跳板机** —— 从能通的机器 SSH 上去，然后代理端口回来
- **cloudflared / frp 反向隧道** —— 服务器端主动出去，用户端拿到 tunnel URL 直连（但需要服务器上先装）

---

## 八、TODO / tech debt

| 项 | 优先级 | 备注 |
|---|---|---|
| HTTPS + 域名 | P2 | 现在裸 IP + HTTP，内部用够用；上前考虑 sshd 借道 443 会不会冲突 |
| 定时同步 cron | P1 | 每周一早上自动 `POST /api/sync` |
| 前端 Agent 的 `/api/dashboard` 端点部署 | P0 | 本地已实现，未 rsync 到服务器（阻塞：SSH 通路） |
| Python monitor_lib_shared 影子模式 | P0 | 数据 Agent 侧 mock 三件套已完成，等真实 fetcher 之后可跑影子 |
| `/api/data` 62MB 全量下载 | P2 | 前端加载慢的次生问题，加分页 / 增量 |
| 品类下钻视图 | P1 | 现在按机型看，加聚合视图 |
| 关注对象导出（Excel / 飞书表格） | P2 | |
