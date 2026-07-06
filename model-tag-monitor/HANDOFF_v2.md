# 交接文档 · model-tag-monitor 2.0 改造

**交接时间**：2026-07-05
**上一位处理人**：Kiro（本次会话，处理了 Top10 面板的两处生产 bugfix）
**分支**：`feature/dashboard-drilldown`（PR #12，仓库 `ZZ-AI-Business-Analysis`）

---

## 一句话说清楚现状

v1.0（概览页 + 下钻链路）已经**全部实施完毕并在生产跑着**，不是待实施状态。这次是从 v1.0 的基础上做 2.0 改造，具体改什么由你和用户在新对话里确认——这份文档只负责讲清楚"接手前必须知道的坑和事实"。

---

## 部署拓扑（先搞懂这个，否则容易踩坑）

有**三个**地方都叫"model-tag-monitor"，别搞混：

| 路径 | 是什么 | 是否是 git 仓库 |
|---|---|---|
| `zz-server:/root/model-tag-monitor/` | **生产环境，唯一的事实来源（source of truth）** | 不是，纯文件目录 |
| `/Users/lilixiaoran/工作/转转/model-tag-monitor/` | 本地"生产同步副本"，用来 rsync 部署 | 不是，也不是 git 仓库 |
| `/Users/lilixiaoran/工作/转转/ai数据分析工作流/model-tag-monitor/` | git 仓库里的路径，对应 PR #12 | 是，分支 `feature/dashboard-drilldown` |

**踩过的坑**：这三份曾经互相不同步。之前所有开发迭代都是直接改生产机 → `pm2 restart` → 验证，从来没同步回 git 仓库。今天（2026-07-05）才第一次把生产机代码补录回仓库（commit `05f047a`），补录过程中还翻车过一次（`0b185a5` 误用了本地过期副本覆盖，把已修复的代码退回未修复版本），后来重新现场 SSH 拉取才修正。

**教训，务必遵守**：
1. **改代码前，先从生产机现场 `sudo cat` / `scp` 拉最新文件**，不要相信任何本地"副本"路径是最新的，除非你刚刚验证过。
2. **改完部署后，必须同步回 git 仓库**（`ai数据分析工作流/model-tag-monitor/` 这份），commit + push 到 `feature/dashboard-drilldown`。不要再让生产和仓库脱节。
3. **验证的时候做逐字节 diff**（`diff` 命令，不是"看起来一致"），别只信任跑测试通过或别的 agent 的自述。

---

## 生产环境信息

- 服务器：`zz-server`（`47.84.94.234`），SSH 需要 sudo 权限（目录属主是 root）
- 端口：`8848`，访问 `http://47.84.94.234:8848`
- 进程管理：`pm2`，进程名 `model-tag-monitor`，路径 `/root/.nvm/versions/node/v20.20.2/bin/pm2`（不在默认 PATH，需要写全）
- 部署方式：
  ```bash
  rsync -avc src/ zz-server:/tmp/src/
  rsync -avc public/ zz-server:/tmp/public/
  ssh zz-server 'sudo cp -r /tmp/src/* /root/model-tag-monitor/src/ && \
    sudo cp -r /tmp/public/* /root/model-tag-monitor/public/ && \
    sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 reload model-tag-monitor'
  ```
- 数据源：飞书多维表格 → `data/cache.json`（93MB，生产机上，不入 git）。同步靠 crontab：`30 9 * * * /root/workspace/ZZ-AI-Business-Analysis/scripts/机型周数据_cron.sh`，每天 9:30 跑一次。
- `data/` 目录下还有 `tags.json`、`tag-vocab.json`、`rules.json`（规则引擎配置），也都不入 git。

---

## 代码结构（当前行数，2026-07-05）

```
src/dashboard.js    423行  概览页数据聚合（KPI/趋势/环形图/Top10），核心逻辑都在这
src/monitor.js      172行  监测核心逻辑，输出 pool/watchList，其他模块只读不改
src/server.js       226行  Express 入口，路由
src/proxy.js        124行  代理模式，本地开发时联调线上真数据用
src/sync.js         220行  飞书数据同步
src/feishu.js       143行  飞书 API 封装
src/store.js         61行  data/*.json 读写封装

public/app.js      1124行  前端全部逻辑（监测页 + 概览页渲染、URL 参数处理、下钻交互）
public/style.css    879行  老监测/规则/标签页样式，别动
public/dashboard.css 478行  概览页专用样式，独立命名空间 .dash-*
public/index.html   280行  主 HTML
public/dashboard-preview.html 441行  概览页 UI 参考稿（假数据，仅供参考，非最新实现）

test/compose-dashboard.test.js   217行  单测，覆盖 composeDashboard 逻辑
test/api-monitor-handler.test.js 113行  HTTP 层集成测试
```

`npm test` 跑 `node --test test/*.test.js`，12 条测试全过。

---

## Top10 面板的两处 bugfix（今天刚做的，2.0 改造时别回退）

`src/dashboard.js` 里 `build()`（第136行附近）和 `composeDashboard()`（第343行附近）两处 `rankable` 链路：

1. **数据源从 `pool` 改为 `watchList`**：避免估价 UV 个位数的机型算出虚高倍数（曾出现 23.95× 这种噪音）
2. **追加 `.filter((row) => row.gmv > 0)`**：排除本周零成交机型，UV 倍数再高也没业务意义

如果 2.0 改造涉及重写 Top10 排序逻辑，这两条业务规则要保留（除非用户明确要改）。

---

## v1.0 已完成的功能（供 2.0 改造参考基线）

- 顶部 tab：`概览 / 监测 / 规则 / 标签`，默认落地概览
- `/api/dashboard` 聚合接口，60s 内存缓存，响应体积和首屏时间达标
- 概览页：4 张 KPI 卡、GMV 近5周折线图、异常品类Top5环形图、Top10 异常机型表格
- 下钻链路：概览页点击任意元素 → 跳转监测页并预填筛选（URL 参数：`tab/view/week/category/trend/highlight/from`）
- 监测页：面包屑（`from=dashboard` 时显示）、行高亮+滚动定位、trend 上涨/下跌筛选
- 手动改筛选后自动断开面包屑上下文

视觉规范（冰蓝极简科技风）、下钻映射表、验收标准等详细设计，历史存档在同目录 `HANDOFF.md` 里（v1.0 的交接文档，现状说明已过时但设计细节仍可参考）。

---

## 明确的历史约束（除非用户在新对话里改口，否则继续遵守）

- 不引入前端框架，项目至今零依赖前端库
- `src/monitor.js` 核心逻辑别改，只读
- 老监测/规则/标签页现有逻辑不受影响，改动走增量
- 不动飞书同步、规则引擎、标签系统（除非 2.0 明确要改这些）
- 不改端口/域名/pm2 配置

---

## 新对话开始时建议先做的事

1. 问用户 2.0 具体要改什么范围（这份文档没有 2.0 的需求细节，需要重新收集）
2. 现场 SSH 到 `zz-server` 确认生产代码跟本仓库 `feature/dashboard-drilldown` 分支（当前 HEAD `05f047a`）是否还一致（防止这期间又有人直接改了生产机）
3. 看 `README.md`（生产最新版）和 `HANDOFF.md`（v1.0 交接文档 + 现状更新章节）补全背景
