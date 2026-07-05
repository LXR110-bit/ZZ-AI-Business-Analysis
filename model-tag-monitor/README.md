# 机型标签监测面板

服务器：`zz-server` (47.84.94.234)，端口 `8848`
访问：`http://47.84.94.234:8848`
部署路径：`/root/model-tag-monitor/`

## 目录结构

```
src/         后端源码
public/      前端静态文件
data/        持久化 JSON（标签库、规则、缓存的表数据、操作日志）
logs/        pm2 日志
```

## 数据源

飞书 sheets：
- Wiki node: `LaXdwebItiEBZwkr6NvcEEM0nlg`
- Obj token: `TzkVs1LVshLaZjtH1nzcG4opnxb`
- App ID: `cli_aab4e49b7bb95bd3`
- Secret 通过 lark-channel-bridge secrets get 拿

## 常用命令

```bash
# 拉最新代码到服务器
rsync -av --exclude node_modules --exclude data --exclude logs \
  /Users/lilixiaoran/工作/转转/model-tag-monitor/ \
  zz-server:/root/model-tag-monitor/

# 服务管理
ssh zz-server 'pm2 restart model-tag-monitor'
ssh zz-server 'pm2 logs model-tag-monitor'
ssh zz-server 'pm2 status'
```

## 本地开发

不想真连飞书时用 mock 数据跑：

```bash
npm run mock        # 造 24 机型 × 5 周 mock 数据到 data/cache.json
npm run dev         # 起服务，访问 http://127.0.0.1:8848
npm run mock:reset  # 清掉 data 里的 cache/tags/rules，重造 mock
```

`data/` 只本地用，不进仓库；线上还是走「同步飞书数据」按钮。

### 本地 UI + 线上真数据（代理模式）

要在本地新版 UI 上直接看线上服务的真数据，把 `PROXY_UPSTREAM` 指到线上：

```bash
PROXY_UPSTREAM=http://47.84.94.234:8848 npm run dev
# 启动日志会打印 [proxy] mode=upstream target=...
```

行为：

- `/api/meta` `/api/monitor` `/api/data` `/api/tags` `/api/rules` `/api/logs` `/api/sync` 等全部透传到上游
- `/api/dashboard` **不透传**（上游没这个端点），本地会拉上游 `/api/monitor` + 5 周 `/api/data?week=` 现场组装，60s 内存缓存
- 前端代码零改动，浏览器仍然 fetch 相对路径

不设 `PROXY_UPSTREAM` 就退回本地模式（读 `data/cache.json`），启动日志会打 `[proxy] mode=local`。

⚠️ 代理模式下 `PUT /api/rules` 等写请求会**直接落到线上服务**。改规则前想清楚。

## 页面结构

- `#page-dashboard` **概览**（默认页）
  - 4 张 KPI：覆盖机型 / 需关注机型 / 周环比上涨 / 最新周次
  - GMV 5 周折线，圆点 → 跳到该周 monitor
  - 需关注品类环形 + 图例，任一 → 筛到该品类
  - Top 10 异常机型表，点行 → 下钻并高亮该机型
- `#page-monitor` **监测结果**
  - 从概览下钻时顶部显示面包屑（返回概览 / 清除定位）
  - 顶部 filter：品类 / 周次 / 视图 / 趋势（新增：仅上涨 · 仅下跌）
  - 手改任一 filter 会自动断掉下钻上下文
- 其他 tab：标签管理 / 规则配置 / 操作日志

## URL 状态

概览下钻会把状态写进 URL，可复制/分享/前进后退：

```
?tab=monitor&week=2025-W27&category=手机&view=pool&highlight=M1218440332&from=dashboard
```

参数：`tab` `week` `category` `view` (`watch|pool`) `trend` (`up|down`) `highlight` (modelId) `from` (`dashboard`)

## 后端接口

- `GET /api/meta` 同步状态
- `GET /api/dashboard` 概览页数据（KPI / GMV 趋势 / 品类分布 / Top10）
- `GET /api/monitor?week=&category=&view=` 监测结果
- 其余 tags / rules / logs / sync 见 `src/server.js`
