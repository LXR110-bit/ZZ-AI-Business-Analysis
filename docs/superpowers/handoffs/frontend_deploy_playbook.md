# 前端 Agent 归一化改造 · 部署 Playbook

> **触发场景**：前端 Agent 在本地重构了 `/root/model-tag-monitor/`（拆出 `src/dashboard.js` 纯函数 + `src/proxy.js` responseRewrite 钩子 + normalizeTrend/normalizeMonitor 归一化层），需部署回 zz-server。
>
> **目标**：把本地工作树同步到 zz-server 现役 `model-tag-monitor` 进程，**零下线时间、可回滚**。
>
> **作者**：主控 Agent
>
> **最后更新**：2026-07-04
>
> **状态**：定稿，等用户执行

---

## 一、为什么这份文档存在

前端 Agent 交付了归一化改造：
- `src/dashboard.js` 拆出 `composeDashboard` 纯函数 + 12 case 单测
- `src/proxy.js` 加 responseRewrite 钩子，`/api/monitor` 挂上归一化 + 强制 `Cache-Control: no-store` + 剥 ETag
- 本地 curl 验证：1887 items 全干净，0 badKeys、0 invalidVal

改动**只在前端 Agent 的本地工作树**，服务器 `/root/model-tag-monitor/` 上还是老代码。主控没 SSH 私钥（在用户 Mac 上），**部署必须走用户**。

这份 playbook 让用户复制粘贴执行，主控/前端 Agent 全程可见。

---

## 二、部署前提清单（前端 Agent 完成）

- [x] 本地 `npm test` 全绿（12 单测）
- [x] 本地 `curl` 验证归一化输出 1887 items 无污染
- [ ] 起 PR 到某个 git repo（**下一步决策，见 §三**）
- [ ] 主控 preflight 三值确认（state=OPEN / base=main / mergeable=MERGEABLE）
- [ ] PR merge 到 main

---

## 三、关键决策：`model-tag-monitor` 有 git repo 吗？

主控查过服务器上的项目布局（`phase1_server_infra_handoff.md`）：

```
/root/model-tag-monitor/
├── package.json
├── ecosystem.config.js
├── src/{feishu,store,sync,monitor,server}.js  ← 5 个原始文件
├── public/index.html
├── data/{cache,tags,rules,logs}.json
└── logs/
```

Handoff 没写这个目录是否 `git init` 过。**如果没有 git repo**：
- 前端 Agent 本地一定是**从服务器 rsync 或 scp 下来**的（否则改代码从哪来？）
- 那部署路径是：**本地打包 → 用户上传 → 服务器解压 → pm2 restart**

**如果有 git repo**：
- 部署路径：**本地起 PR → merge → 用户在服务器 `git pull` → pm2 restart**

**第一步**（**用户执行**）：
```bash
ssh zz-server 'cd /root/model-tag-monitor && (git status || echo NOT_A_REPO)'
```
用输出决定走哪条路。

---

## 四、路径 A：项目已 git 化（推荐路径）

### 4.1 本地起 PR

前端 Agent 现在的工作树：
```bash
cd <前端 Agent 本地工作树>
git status                       # 确认有 dashboard.js / proxy.js / test/ 改动
git checkout -b feature/monitor-normalize
git add src/ test/ package.json
git commit -m "feat(monitor): 归一化 + proxy responseRewrite + 12 单测

- src/dashboard.js: 拆出 composeDashboard 纯函数
- src/proxy.js: /api/monitor 挂 normalizeTrend + normalizeMonitor
  - 5 项 rate 补齐、非法值归 null
  - 强制 Cache-Control: no-store，剥 ETag/Last-Modified
- test/: 12 case 覆盖 {} / null / 部分泄漏 / 非法值 / pool+watchList / 端到端排序
- 本地 curl 1887 items 全绿，0 badKeys 0 invalidVal

Refs: Issue #21（Node 版 wave.js trend 兜底，本层为消费端防御）"
git push -u origin feature/monitor-normalize
gh pr create --title "feat(monitor): 归一化 + proxy responseRewrite + 12 单测" \
             --body "..."
```

### 4.2 主控 preflight 检查

**主控铁律**（Merge Preflight 教训固化）：
```bash
gh pr view <N> --json state,baseRefName,mergeable --jq '{state, base: .baseRefName, mergeable}'
```
三值必须齐全：`state=OPEN` / `base=main` / `mergeable=MERGEABLE`。

### 4.3 合入 main

```bash
gh pr merge <N> --squash --delete-branch
```

### 4.4 服务器拉取部署（**用户执行**）

```bash
ssh zz-server 'sudo bash -c "
  set -euo pipefail
  cd /root/model-tag-monitor

  # 备份现役代码（rollback 用）
  BACKUP=/root/backups/model-tag-monitor-$(date +%Y%m%d_%H%M%S)
  mkdir -p /root/backups
  cp -a /root/model-tag-monitor \$BACKUP
  echo \"[backup] created: \$BACKUP\"

  # 拉取
  git fetch origin main
  git log HEAD..origin/main --oneline
  git reset --hard origin/main

  # 装依赖（如果 package.json 变了）
  /root/.nvm/versions/node/v20.20.2/bin/npm ci --production || \
  /root/.nvm/versions/node/v20.20.2/bin/npm install --production

  # 灰度：先 dry-run 起一个临时端口验证
  # (可选，如果要严谨；简单场景可以直接 pm2 restart)

  # 重启 pm2
  /root/.nvm/versions/node/v20.20.2/bin/pm2 restart model-tag-monitor
  /root/.nvm/versions/node/v20.20.2/bin/pm2 list | grep model-tag-monitor
"'
```

### 4.5 部署后验证（**主控可远程验证**）

```bash
# 主控本地 curl（不需要 SSH）
curl -s http://47.84.94.234:8848/api/monitor | jq '.pool[:3] | map({item: .modelName, trend})'
```

**成功标志**：所有 `trend` 是 `{evaRate, orderRate, shipRate, dealRate, returnRate}` 五键齐全的对象，每键是 `"up" | "down" | null` 三值之一。**不再出现 `{}`**。

Cache-Control：
```bash
curl -sI http://47.84.94.234:8848/api/monitor | grep -i cache
# 期望: Cache-Control: no-store
```

### 4.6 回滚（如果验证失败）

```bash
ssh zz-server 'sudo bash -c "
  cd /root/model-tag-monitor
  # 恢复上一版
  LATEST_BACKUP=\$(ls -td /root/backups/model-tag-monitor-* | head -1)
  rsync -a --delete \$LATEST_BACKUP/ /root/model-tag-monitor/
  /root/.nvm/versions/node/v20.20.2/bin/pm2 restart model-tag-monitor
  echo \"[rollback] restored from: \$LATEST_BACKUP\"
"'
```

---

## 五、路径 B：项目未 git 化

### 5.1 服务器现役先 git init（**用户执行**）

```bash
ssh zz-server 'sudo bash -c "
  set -euo pipefail
  cd /root/model-tag-monitor

  # 备份
  BACKUP=/root/backups/model-tag-monitor-$(date +%Y%m%d_%H%M%S)
  mkdir -p /root/backups
  cp -a /root/model-tag-monitor \$BACKUP

  # 起 git（如未起）
  if [ ! -d .git ]; then
    git init
    git config user.email 'admin@zz-server.local'
    git config user.name 'zz-server'

    # .gitignore：排除数据文件和日志
    cat > .gitignore <<'EOF'
data/
logs/
node_modules/
*.log
.env
EOF

    git add -A
    git commit -m 'chore: initial commit (server baseline before frontend Agent changes)'
    git tag pre-normalize-baseline
    echo '[git] initialized, tagged pre-normalize-baseline'
  fi
"'
```

### 5.2 本地 rsync 上传（**用户 Mac 执行**）

```bash
# 用户在自己 Mac 上，前端 Agent 的本地工作树目录
cd <前端 Agent 本地工作树>

# 只同步代码，不同步数据/日志/依赖
rsync -avz --delete \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'logs/' \
  --exclude '.git/' \
  --exclude '*.log' \
  ./ zz-server:/root/model-tag-monitor/

# 服务器上装依赖 + restart
ssh zz-server 'sudo bash -c "
  cd /root/model-tag-monitor
  /root/.nvm/versions/node/v20.20.2/bin/npm install --production
  /root/.nvm/versions/node/v20.20.2/bin/pm2 restart model-tag-monitor
  /root/.nvm/versions/node/v20.20.2/bin/pm2 list | grep model-tag-monitor
"'
```

### 5.3 验证 + 回滚

同 §4.5、§4.6。

### 5.4 后续 git 化建议

Path B 只是应急，长期建议在服务器上 `git remote add origin <github>` + push 一次，然后本项目跟 `ZZ-AI-Business-Analysis` 一样走 PR → merge → server pull 的标准流程。

---

## 六、部署检查表（用户 checklist）

**部署前**：
- [ ] 前端 Agent 起了 PR / 打了 rsync 打包
- [ ] 主控 preflight 三值确认（如果走 git 路径）
- [ ] 用户确认部署时间窗口（避开业务高峰）

**部署中**：
- [ ] 备份现役代码到 `/root/backups/`
- [ ] 拉新代码 / rsync
- [ ] `npm install`（如依赖有变化）
- [ ] `pm2 restart model-tag-monitor`
- [ ] `pm2 list` 显示进程 online

**部署后（5 分钟内）**：
- [ ] 主控 curl `/api/monitor`，验证 `trend` 五键齐全、无 `{}`
- [ ] 主控 curl `-I /api/monitor`，验证 `Cache-Control: no-store`
- [ ] 用户浏览器打开 `http://47.84.94.234:8848/` 页面能加载
- [ ] pm2 日志 `pm2 logs model-tag-monitor --lines 50` 无报错

**回滚触发**：任一验证失败 → 立即执行 §4.6

---

## 七、常见故障预案

### 7.1 pm2 restart 后进程反复 crash

**症状**：`pm2 list` 显示 status=errored，restart count 快速上涨

**排查**：
```bash
ssh zz-server 'sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 logs model-tag-monitor --lines 100 --nostream'
```

**常见原因**：
- 新代码引用了没装的依赖 → `npm install --production` 再 restart
- Node 版本不兼容（新代码用了新语法） → 检查 `package.json engines`
- 环境变量丢失 → 对比 `.env` 或 `ecosystem.config.js`

**恢复**：立即 §4.6 回滚

### 7.2 `/api/monitor` 500 或返回空

**排查**：
```bash
curl -v http://47.84.94.234:8848/api/monitor 2>&1 | head -30
ssh zz-server 'sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 logs model-tag-monitor --lines 50 --nostream'
```

**常见原因**：
- proxy.js responseRewrite 钩子 throw 未捕获 → 归一化代码有 bug
- 上游 `/api/data` 数据 shape 突变，归一化没 defensive

**恢复**：立即 §4.6 回滚 + 前端 Agent 修 bug 再重发

### 7.3 归一化没生效（`trend` 还是 `{}`）

**排查**：
```bash
# 检查 proxy 是否挂上
curl -sI http://47.84.94.234:8848/api/monitor | grep -i cache
# 如果没 Cache-Control: no-store，说明 proxy responseRewrite 没生效
```

**常见原因**：
- `server.js` 没引入新的 proxy 中间件
- 路由顺序错误，请求没进 proxy 就返回了

**恢复**：前端 Agent 检查 `server.js` 是否正确挂载 proxy

---

## 八、部署完成后的记账

用户执行完部署后，请**回声主控**，主控会：

1. 更新 `PROJECT_STATUS.md`：
   - 关联 PR 表加"前端归一化改造已部署"一行
   - Sub-agent 分工表更新前端 Agent 状态到"归一化改造已上线"
   - 已知阻塞列表：如果 Issue #21（Node 版 trend `{}`）被本次部署 workaround 掉，标记为"已由前端消费层兜底，Node 版可延后修"

2. 更新 `docs/superpowers/handoffs/phase1_server_infra_handoff.md`：
   - `src/` 目录结构从 5 文件更新为 6+ 文件（加 dashboard.js / proxy.js）
   - 部署命令模板补充

3. 主控自己 spawn_task 或直接跟你确认下一步（机型下钻页 / Phase 7 待命 / 其他）

---

## 九、给未来同类部署的模板价值

**这份 playbook 的通用性**：任何 sub-agent 在本地改了 zz-server 上跑的项目，都可以套这个流程：

1. §三判断 git repo 归属
2. §四或 §五 二选一路径
3. §六 checklist 逐项过
4. §四.5 / §四.6 验证 + 回滚
5. §七 故障预案
6. §八 部署后记账

**留给未来的 Kiro 用**：把这份 handoff 作为"服务器部署 SOP"，下次 model-tag-monitor 或其他生产项目改动都可以直接引用。

---

## 十、参考

- `docs/superpowers/handoffs/phase1_server_infra_handoff.md` —— zz-server 服务器基础设施权威描述
- `docs/superpowers/handoffs/data_to_frontend_contract.md` —— 数据契约 v1.0（本次归一化的契约依据）
- Issue #21 —— Node 版 wave.js trend `{}` bug（本次归一化改造的直接触发因素）
- 前端 Agent 交付（2026-07-04）—— 归一化改造 12 单测 + curl 1887 items 验证
