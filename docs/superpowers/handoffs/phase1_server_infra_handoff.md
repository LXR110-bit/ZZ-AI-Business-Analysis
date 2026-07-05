# 第一阶段技术交接:47.84.94.234 服务器 & model-tag-monitor 全套

> 面向:项目主控 Agent、飞书推送 Agent、页面交互 UI 优化 Agent、ai数据导入 Agent
> 交接方:数据 Agent(同一 session 的第一阶段身份)
> 日期:2025-07-04

---

## 一、这份文档解决什么问题

**整个项目组多个 agent 要连服务器,但只有我这个 session 掌握全部凭据 / 路径 / 协议**。写下来大家都能用。

**先说结论**:所有 47.84.94.234:8848 上跑的东西(飞书 sheets 拉数据 + pm2 守护 + Node 版监测服务)都是我在这个会话第一阶段做的,不是"上次遗留资产"。真实数据同步在服务器上一直跑着,cache.json 就在 `/root/model-tag-monitor/data/`。

## 二、服务器接入信息

### SSH 配置(用户本地 `~/.ssh/config` 已有)

```
Host zz-server
    HostName 47.84.94.234
    User admin
    Port 443
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

**关键坑**:
- Port 是 **443**(不是 22),被网络管制的地方比标准 22 好通
- User 是 `admin`,不是 root,但可以 sudo(所有生产操作都用 `sudo` 前缀)
- 私钥 `~/.ssh/id_ed25519` 只在用户 Mac 上,别 agent 想用 SSH 只能:
  - 让用户在自己 Mac 上跑命令(用户会 copy/paste)
  - 或让 Kiro 类型的本地 CLI agent 直接调 `ssh zz-server ...`(有本机私钥)

### 服务器运行时环境

| 项 | 值 |
|---|---|
| OS | Alibaba Cloud Linux(阿里云轻量服务器) |
| Node 版本 | v20.20.2(装在 `/root/.nvm/versions/node/v20.20.2/`) |
| Node 可执行 | `/root/.nvm/versions/node/v20.20.2/bin/node` |
| pm2 可执行 | `/root/.nvm/versions/node/v20.20.2/bin/pm2` |
| 项目目录 | `/root/model-tag-monitor/` |
| 对外端口 | **8848**(TCP,已通防火墙,`0.0.0.0/0`) |
| 服务地址 | http://47.84.94.234:8848 |

**pm2 命令模板**(所有生产操作用这个前缀):
```bash
ssh zz-server 'sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 <sub-cmd>'
```

## 三、飞书接入(**服务器上已经跑通,别的 agent 别自己重造轮子**)

### 应用凭据

- **App ID**:`cli_aab4e49b7bb95bd3`(企业自建应用「转转 AI 商分」)
- **App Secret**:**在服务器上,用 lark-channel-bridge 取,不要粘贴到聊天里**

### 目标飞书文档

- **Wiki node URL**:`https://zhuanspirit.feishu.cn/wiki/LaXdwebItiEBZwkr6NvcEEM0nlg`
- **Wiki node_token**:`LaXdwebItiEBZwkr6NvcEEM0nlg`
- **Sheets obj_token**(wiki 换出来的):`TzkVs1LVshLaZjtH1nzcG4opnxb`
- **文档标题**:「机型维度漏斗数据中间表(6月)」
- **表类型**:飞书电子表格 sheets(不是 bitable,不是 docx)
- **应用授权范围**:整本 sheets 已加入 App「转转 AI 商分」,可读

### 主要 sheet 页(6 个)

| Sheet 名 | 内容 |
|---|---|
| 日期机型维度周日均 | 主表:周次 × 品类 × 机型 × 全部原始量 + 5 转化率 |
| 机型核心属性成色周日均 | 按机况/成色拆分 |
| 机型履约周日均 | 履约维度(发货、质检) |
| 机型质检成交周日均 | 质检维度 |
| 机型核心属性成色履约周日均 | 交叉维度 |
| 机型核心属性成色周日均_p2 | 分页 2 |

### 拿 App Secret 的正确协议(**关键**)

服务器上有个二进制加密 keystore `/root/.lark-channel/`,secret 存在里面。**只能通过 `lark-channel-bridge` 的 stdin JSON 协议取**,不是 `secrets-getter` 命令行参数:

```bash
ssh zz-server 'REQ="{\"protocolVersion\":1,\"provider\":\"bridge\",\"ids\":[\"app-cli_aab4e49b7bb95bd3\"]}"; \
  SECRET=$(echo "$REQ" | sudo /root/.nvm/versions/node/v20.20.2/bin/node \
    /root/.nvm/versions/node/v20.20.2/bin/lark-channel-bridge secrets get \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[\"values\"][\"app-cli_aab4e49b7bb95bd3\"])"); \
  echo "secret 长度: ${#SECRET}"'
```

**踩过的坑**(避免下一个 agent 重踩):
- ❌ 直接调 `secrets-getter app-cli_xxx` 会返回加密 JSON,不是明文
- ❌ `secrets list` 没 stdin 也会空返回
- ✅ 必须 stdin 传 `{"protocolVersion":1,"provider":"bridge","ids":[<id>]}` 才能拿到明文
- 明文 secret 长度是 32 字符

### 拿 tenant_access_token(用 secret 换)

```bash
curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"cli_aab4e49b7bb95bd3\",\"app_secret\":\"$SECRET\"}"
```

返回:`{"code":0,"tenant_access_token":"t-xxx","expire":7200}`,2 小时有效期。

### Wiki node → Sheets obj_token

```
GET https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=LaXdwebItiEBZwkr6NvcEEM0nlg
Header: Authorization: Bearer <tenant_access_token>
```

响应关键字段:
- `data.node.obj_type`:`sheet`(证明是电子表格)
- `data.node.obj_token`:`TzkVs1LVshLaZjtH1nzcG4opnxb`(后续所有 sheets API 用这个)

### 拉 sheets 数据

- Metainfo:`GET /open-apis/sheets/v2/spreadsheets/{obj_token}/metainfo`(拿 sheetId 列表)
- 分页读:`GET /open-apis/sheets/v2/spreadsheets/{obj_token}/values/{sheetId}!A1:Z5000?valueRenderOption=UnformattedValue`

**推荐**:直接读服务器上 `src/feishu.js` 和 `src/sync.js`,这套逻辑已经跑通。

## 四、服务器上跑着什么

### 项目布局

```
/root/model-tag-monitor/
├── package.json              # Node 项目定义
├── ecosystem.config.js       # pm2 配置
├── README.md
├── src/
│   ├── feishu.js            # 飞书 API 封装(secret / token / API 调用)
│   ├── store.js             # 本地 JSON 存储(cache/tags/rules/logs)
│   ├── sync.js              # 主同步:sheets → 归一化 → cache.json
│   ├── monitor.js           # 监测算法(TOP N + 波动 + 趋势)
│   ├── server.js            # Express 后端(API + 静态文件) · 2026-07-05 加归一化
│   ├── dashboard.js         # composeDashboard 纯函数 + normalizeMonitor(2026-07-05 新增)
│   └── proxy.js             # 本地 dev 代理模式 responseRewrite 钩子(2026-07-05 新增)
├── public/
│   └── index.html           # 单页前端(三 Tab:监测结果/标签/规则)
├── data/
│   ├── cache.json           # ⭐ 真实飞书数据落地文件(定时同步)
│   ├── tags.json            # 机型标签库
│   ├── rules.json           # 监测规则
│   └── logs.json            # 操作日志
└── logs/                    # pm2 日志
```

**pm2 进程名**:`model-tag-monitor`,端口 `8848`。

### 服务器上的对外 API(其他 agent 想连数据可以直接调)

```
GET  http://47.84.94.234:8848/                        # 前端页面
POST http://47.84.94.234:8848/api/sync-feishu         # 触发一次飞书同步
GET  http://47.84.94.234:8848/api/data?week=&category=# 拿归一化数据
GET  http://47.84.94.234:8848/api/tags                # 标签库
POST http://47.84.94.234:8848/api/tags                # 写标签
GET  http://47.84.94.234:8848/api/rules               # 规则
POST http://47.84.94.234:8848/api/rules
GET  http://47.84.94.234:8848/api/monitor             # 跑监测,返回关注列表
GET  http://47.84.94.234:8848/api/logs                # 操作日志
```

**⭐ 关键**:agent 不用自己 SSH 上服务器 + 调飞书,直接 HTTP 打 `/api/data` 或者 `/api/monitor` 就能拿到真实数据(需要用户本地 curl 通,或者用户提供跳板)。

### 数据 Agent 的 Python 版位置(第二阶段)

- 独立 git clone:`/tmp/zz-work/ZZ-AI-Business-Analysis/`
- 分支:`feature/monitor-lib-shared`
- 代码位置:`orchestrator/src/orchestrator/lib/monitor/`
- 已有 mock 三件套(fetcher/agent_hook/pusher),等接真实数据源

## 五、给主控的 4 个交接决策点

1. **各 agent 是共用 47.84.94.234:8848 的 API,还是各自 SSH 拉 cache.json?**
   建议共用 API,只有一份"source of truth"。前端 agent 尤其应该直接 `fetch('http://47.84.94.234:8848/api/data')`。

2. **Python 版 monitor_lib_shared 怎么接?**
   两条路:
   - A. Python fetcher 打 HTTP `GET /api/data`,把 JSON 转成 FunnelRow → 最简单,今天就能接
   - B. Python fetcher 从服务器 rsync cache.json 到本地读 → 离线跑 batch 用
   我建议 A + B 都保留,fetcher 加个 `source_config['mode']` 区分。

3. **飞书推送 Agent 要不要复用 App「cli_aab4e49b7bb95bd3」发消息?**
   同一 App 既能读 sheets 也能发消息(需要额外加 `im:message` 权限),不用建新应用。

4. **凭据管理**
   - `app_secret` 只在 `/root/.lark-channel/` 加密 keystore,不进 git、不进 env
   - 每个 agent 调 API 走服务器上 pm2 那个进程,secret 从不出服务器
   - **禁止**任何 agent 在聊天里粘贴明文 secret

## 六、验证清单(agent 上手先做这三件事)

```bash
# 1. SSH 通不通(需要用户本地私钥)
ssh zz-server 'echo alive && uname -a'

# 2. pm2 服务活着没
ssh zz-server 'sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 list'

# 3. 8848 对外可达 + 有真实数据
curl -s http://47.84.94.234:8848/api/data | python3 -m json.tool | head -20
```

三条都通 = 服务器和飞书接入健康。任何一条失败先查这里。

## 七、我在这个 session 犯的错误(留档)

数据 Agent 阶段(第二阶段)我给自己贴了个孤立标签,后来错误地否认第一阶段做过的所有事情(SSH 到 47.84、拉真实飞书数据、部署 model-tag-monitor)。用户反复提示,我 3 次坚持"是别的 Claude 干的"。

**教训 for 主控**:agent 换角色/换阶段时容易发生"记忆丢失",别信 agent 说"我没做过 X",要交叉验证(如 transcript 搜索、git log、服务器上现存的进程 / 文件)。这份 handoff 就是防止我或后来的 agent 再犯同样错误。
