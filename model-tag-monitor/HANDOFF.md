# 交接文档 · Dashboard 下钻链路

**分支**: `feature/dashboard-drilldown`
**接手人**: 另一个 AI Agent
**交接时间**: 2025-07-04
**上一位处理人**: Kiro（本次会话）

---

## 一句话说清楚

给「机型标签监测」加一个 AI 金融风的**概览首页**（Dashboard），核心是**下钻交互链路**：用户从概览的 KPI 卡片 / 图表 / Top 表格点击后，跳到监测详情页并自动预填筛选、滚动定位、支持面包屑返回。

**任务边界**：只做这一件事。不要顺手重构别的模块。

---

## 你需要先知道的项目背景

这是一个内部数据分析工具，服务于转转"机型标签监测"业务。技术栈：

- **后端**: Node.js + Express（`src/server.js` 入口）
- **前端**: 无框架，纯 HTML/CSS/JS，`public/` 目录直接托管
- **数据源**: 飞书多维表格拉过来的机型周维度数据，存在 `data/cache.json`
- **部署**: pm2 跑在阿里云 `zz-server`，端口 `8848`，反代域名走 `47.84.94.234`
- **访问**: <http://47.84.94.234:8848>

看 `README.md` 了解更多。

---

## 项目现状（你接手时的状态）

### 已完成

1. **接口性能优化**（上一轮）
   - `src/server.js` 已挂 `compression` 中间件，`/api/monitor` 响应 2.86MB → 311KB
   - 前端 `public/app.js` 的 `refreshMonitor()` 加了 loading 态
   - 结果：首屏 21s → 5.4s

2. **概览页预览稿**
   - 文件：`public/dashboard-preview.html`
   - 独立 HTML，用假数据展示了目标 UI 效果
   - 风格已定：**冰蓝极简科技**（见下方 "视觉规范"）
   - 用户已确认此风格，UI 结构基本按此实现即可

3. **交互设计已通过 brainstorming 确认**（就是这份文档要实现的东西）

### 未做

- 概览页真实实现（用 `dashboard-preview.html` 作参考稿即可）
- 后端 `/api/dashboard` 聚合接口
- 监测页支持 URL 参数预填 / 面包屑 / 行高亮定位 / trend 筛选
- 顶部 tab 导航接入"概览"

---

## 需求（用户已确认的 5 项决策）

| # | 决策 | 用户选择 |
|---|---|---|
| 1 | 打磨重点 | **下钻链路**（不是微交互动画） |
| 2 | 下钻终点 | **全部到监测页**，用 URL 带参 |
| 3 | Top 行点击 | **自动定位到该行 + 高亮** |
| 4 | 返回体验 | **面包屑 + 返回按钮** |
| 5 | 筛选叠加 | **手动改筛选后，上下文自动断开** |
| 6 | 开发范围 | **完整包**：概览页 + 下钻基础 + trend 筛选 |

---

## 详细设计

### 一、页面结构

新增顶部 tab 导航（当前监测/规则/标签基础上加"概览"）：

```
[ 概览 ]  [ 监测 ]  [ 规则 ]  [ 标签 ]
   ↑ 默认落地页
```

**概览页元素**：

```
┌──────────────────────────────────────────────────────┐
│  背景光晕(左上蓝+右下青,径向渐变纯 CSS)                 │
│                                                      │
│  ┌顶栏──────────────────────────────────────────────┐│
│  │ Logo·标题   [tab tab tab tab]   同步时间  [进入监测]││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌KPI①─────┐ ┌KPI②─────┐ ┌KPI③─────┐ ┌KPI④─────┐  │
│  │覆盖机型  │ │本周异常  │ │周涨机型  │ │最新周次  │  │
│  │12,847   │ │438      │ │1,203    │ │W27      │  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘  │
│                                                      │
│  ┌折线图───────────────────┐ ┌环形图──────────────┐  │
│  │ GMV 近 5 周走势          │ │ 异常品类 Top 5     │  │
│  └────────────────────────┘ └────────────────────┘  │
│                                                      │
│  ┌Top 10 表格─────────────────────────────────────┐  │
│  │ # 机型  品类  orderRate  周变化  GMV           │  │
│  │ ...                                             │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 二、下钻映射表（**这是核心**）

概览页每个可点击元素，跳转到监测页时带的 URL 参数：

| 概览页元素 | 跳转 URL（相对） |
|---|---|
| KPI①覆盖机型 | `?tab=monitor&view=pool&from=dashboard` |
| KPI②本周异常 | `?tab=monitor&view=watch&from=dashboard` |
| KPI③周涨机型 | `?tab=monitor&view=pool&trend=up&from=dashboard` |
| KPI④最新周次 | `?tab=monitor&view=pool&week=<最新周>&from=dashboard` |
| 折线图·某周点 | `?tab=monitor&view=pool&week=<该周>&from=dashboard` |
| 环形图·某品类段 | `?tab=monitor&view=watch&category=<品类名>&from=dashboard` |
| Top 10 表某行 | `?tab=monitor&view=pool&category=<品类>&highlight=<modelId>&from=dashboard` |

**参数含义**：
- `tab`: 落地哪个 tab（这里固定 `monitor`）
- `view`: `pool`（全部池）/ `watch`（观察名单）
- `week`: 周次，格式 `2025-W27` 或跟现有下拉一致
- `category`: 品类名（跟现有下拉一致，UTF-8 编码）
- `trend`: `up` / `down`（**新增筛选维度**）
- `highlight`: 需要滚动定位并高亮的 modelId
- `from=dashboard`: 面包屑判断从哪来

### 三、监测页需要的改造

监测页 = 现有 `refreshMonitor()` / `renderMonitor()` 渲染的部分，位于 `public/app.js` 和 `public/index.html`。

**改造点**：

1. **URL 参数预填**
   - 页面加载或 tab 切换到 monitor 时，读 `location.search`
   - 把 `view` / `week` / `category` / `trend` 应用到对应筛选控件
   - 触发一次 `refreshMonitor()`

2. **面包屑组件**
   - 只在 `from=dashboard` 时显示
   - 位置：监测页顶部（在筛选控件上方）
   - 内容：`← 从概览 · <参数摘要>`
   - 参数摘要示例：`品类: CPU处理器 · 视图: 观察名单 · 周: W27`
   - 点"←"或"从概览"两个字：回概览（`?tab=dashboard`）

3. **行高亮 + 滚动定位**
   - URL 有 `highlight=<modelId>` 时：
     - `renderMonitor()` 完成后 setTimeout 一下（等 DOM）
     - 找到该行，`scrollIntoView({behavior:'smooth', block:'center'})`
     - 加 class `.row-highlight`，3 秒后移除
   - `.row-highlight` 样式：淡蓝背景 + 左侧强调条

4. **trend 筛选（新增能力）**
   - 在筛选控件里加一个下拉：`趋势: 全部 / 上涨 / 下跌`
   - 判定规则：若行的 orderRate 本周 vs 上周变化 > 0 → up；< 0 → down
     - 具体阈值和字段位置见 `src/monitor.js` 里已有的 wave 计算
   - 只影响前端过滤，不改后端逻辑

5. **手动改筛选 → 断开上下文**
   - 任一筛选控件的 change 事件里：
     - 检测 URL 是否含 `from=dashboard`
     - 若是：删除 `from` / `highlight` 两个参数（用 `history.replaceState` 更新 URL）
     - 面包屑区域变成"自定义筛选"或直接隐藏

### 四、后端 `/api/dashboard` 聚合接口

**目的**：概览页一次请求拿到所有数据，别让前端凑 3 个接口。

**响应结构**：

```json
{
  "meta": {
    "syncedAt": "2025-07-04T12:43:00Z",
    "latestWeek": "2025-W27",
    "weekRange": "06-29 ~ 07-05"
  },
  "kpi": {
    "totalModels": 12847,
    "totalCategories": 139,
    "watchCount": 438,
    "watchDelta": 12,
    "upCount": 1203,
    "upDeltaLabel": "评价率提升 · orderRate 上升"
  },
  "gmvTrend": [
    {"week": "2025-W23", "gmv": 6.2},
    ... 共 5 周
  ],
  "watchByCategory": [
    {"name": "CPU处理器", "count": 123},
    ... Top 5
  ],
  "topRows": [
    {
      "rank": 1,
      "modelId": "iphone15promax256",
      "modelName": "iPhone 15 Pro Max 256G",
      "category": "手机",
      "orderRate": 0.184,
      "deltaLabel": "↑ 4.76×",
      "deltaDir": "up",
      "gmv": 1284530
    },
    ... 共 10 行
  ]
}
```

**实现要点**：
- 复用 `src/monitor.js` 里的 `monitor()` 逻辑，别重复算
- 结果内存缓存 60 秒（`(week, rulesHash)` 作 key）
- 目标响应体积 < 20KB
- 加进 `src/server.js` 的路由，紧挨着 `/api/monitor`

### 五、视觉规范（用户已确认，直接照抄）

参考 `public/dashboard-preview.html`，色板：

```css
:root {
  --dash-bg: #F5F9FF;
  --dash-card-bg: rgba(255,255,255,0.62);
  --dash-card-border: rgba(255,255,255,0.75);
  --dash-blur: blur(22px);
  --dash-accent: #3B82F6;     /* 主蓝 */
  --dash-accent-2: #0EA5E9;   /* 青 */
  --dash-num: #1E3A8A;        /* 数字深蓝 */
  --dash-text: #1E293B;
  --dash-text-2: #64748B;
  --dash-text-3: #94A3B8;
  --dash-up: #059669;
  --dash-down: #DC2626;
}
```

背景光晕（body::before）：
```css
background:
  radial-gradient(circle at 12% 18%, rgba(59,130,246,0.22), transparent 45%),
  radial-gradient(circle at 88% 82%, rgba(14,165,233,0.18), transparent 50%),
  radial-gradient(circle at 60% 5%, rgba(165,180,252,0.15), transparent 40%);
```

卡片：`background: rgba(255,255,255,0.62); backdrop-filter: blur(22px); border: 1px solid rgba(255,255,255,0.75); border-radius: 18px;`

**别自己重新调色板。** 直接沿用预览稿里的所有 CSS 变量和玻璃拟态参数。

---

## 建议实施顺序

**Phase 1（打地基）** — 半天
1. 顶部 tab 导航接入，加"概览"tab，默认落地
2. 后端 `/api/dashboard` 聚合接口 + 60s 缓存
3. 概览页真实数据接入（HTML/CSS 直接改 `dashboard-preview.html` 里的骨架）

**Phase 2（下钻核心）** — 半天
4. 概览页所有元素挂点击事件，按映射表拼 URL 跳转
5. 监测页 URL 参数解析 + 应用到筛选控件
6. 面包屑组件

**Phase 3（收尾）** — 半天
7. 行高亮 + 滚动定位
8. trend 筛选（前端过滤）
9. 手动改筛选 → 上下文断开
10. 全链路测试

---

## 验收标准

必须全部满足：

- [ ] 顶部 tab 有 4 个：`概览 · 监测 · 规则 · 标签`，默认在"概览"
- [ ] 概览页 4 张 KPI 卡片显示真实数据
- [ ] 折线图显示近 5 周真实 GMV
- [ ] 环形图显示本周异常 Top 5 品类真实数据
- [ ] Top 10 表格显示本周涨跌 Top 10 真实机型
- [ ] `/api/dashboard` 响应 < 20KB，首屏 < 2s
- [ ] 每一个可点击元素都能正确跳转到监测页并预填筛选
- [ ] `from=dashboard` 时，监测页顶部显示面包屑，点"←"能回概览
- [ ] Top 行点击后，监测页自动滚动到该行并高亮 3 秒
- [ ] 手动改筛选后，面包屑消失，URL 里 `from` 参数被移除
- [ ] trend 下拉筛选生效，能只看"上涨"或"下跌"
- [ ] 老监测/规则/标签页功能不受影响
- [ ] Safari / Chrome 玻璃拟态渲染正常

---

## 明确不要做的事

- **不重构老代码**。老监测页的现有筛选逻辑保持原样，只做增量。
- **不改 `src/monitor.js` 核心逻辑**。它已经在生产跑了，只在 dashboard 接口里读它的输出。
- **不引入前端框架**。项目至今零依赖前端库，保持这个约束。
- **不做动效/粒子/全息光球**。用户明确说了要"下钻链路"，不是微交互。
- **不改老 UI 的样式**。dashboard 用独立命名空间 `.dash-*` 或 `dashboard.css`，不污染 `style.css`。
- **不动飞书同步、规则引擎、标签系统**。
- **不改端口/域名/pm2 配置**。

---

## 关键文件索引

| 路径 | 说明 |
|---|---|
| `src/server.js` | Express 入口，路由都在这，在这加 `/api/dashboard` |
| `src/monitor.js` | 监测核心逻辑，`monitor()` 函数输出 pool/watchList，别改，只读 |
| `src/store.js` | 读写 data/*.json 的封装 |
| `public/index.html` | 主 HTML，加 tab 和 dashboard 容器 |
| `public/app.js` | 前端所有逻辑，加 dashboard 渲染 + URL 参数处理 |
| `public/style.css` | 老样式，别动，加 dashboard 样式请新建文件 |
| `public/dashboard-preview.html` | UI 参考稿（假数据） |
| `data/cache.json` | 飞书同步下来的原始数据，不入库 |

---

## 部署方式

改完后：

```bash
# 本地测试
npm install
node src/server.js
# 打开 http://localhost:8848

# 部署到线上
rsync -avc src/ zz-server:/tmp/src/
rsync -avc public/ zz-server:/tmp/public/
ssh zz-server 'sudo cp -r /tmp/src/* /root/model-tag-monitor/src/ && \
  sudo cp -r /tmp/public/* /root/model-tag-monitor/public/ && \
  sudo /root/.nvm/versions/node/v20.20.2/bin/pm2 reload model-tag-monitor'
```

**部署前必须**：本地跑通，浏览器手测每一个下钻点。

---

## 一些历史背景（不重要但有用）

- 项目 6 月才上，用户只有内部同事，可用性 > 完美主义
- 之前的性能问题：monitor JSON 2.86MB 未压缩，用户抱怨"没数据"，实际是加载慢。已修。
- 用户对海报级 AI 金融风感兴趣，但明确表示表格页保持 Linear 风就好。
- 用户偏好中文回复、直接了当、少花哨。

---

## 有问题时

看 `README.md` 和 `docs/superpowers/specs/` 里同名 spec（如果有）。实在拿不准，宁可少做，别自作主张扩大范围。

祝顺利。
