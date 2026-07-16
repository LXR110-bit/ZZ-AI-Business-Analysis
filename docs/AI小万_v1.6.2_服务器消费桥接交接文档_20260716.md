# AI 小万 v1.6.2 服务器消费桥接交接文档

更新时间：2026-07-16  
代码仓库：`/Users/lilixiaoran/工作/转转/ai数据分析工作流`  
远端仓库：gitclaw `origin` = `https://gitclaw.zhuanspirit.com/lixiaoran03/ai_wxjyfx.git`

---

## 1. 当前状态

### 1.1 zloop Loop 已跑通

当前验证通过的 Loop：

```text
job_id = 98cd6ff0-007a-4796-b0fc-1addf37f1add
run_id = 9141d6ce-ea02-464c-afec-44c9ea57012b
business_run_id = loop-v162-2026-W29-20260716T201500_0800
business = 聚合回收 (5)
schedule = daily 06:10 Asia/Shanghai
next_run = 2026-07-17 06:10
status = succeeded
```

旧 AI 小万 v1.5/v3 Loop 已关闭，当前只启用上述 v1.6.2 Loop。

### 1.2 Loop 四阶段产物齐全

本次运行产物：

```text
read_result_W29.json
processed_data_W29.json
analysis_result_W29.json
validation_result_W29.json
```

validate 阶段确认：

```text
server_write_confirmed = true
revision = 1
checks = 10/10 passed
publish_allowed = true
overall_status = warn
```

### 1.3 API 写入服务正常

下游接口：

```text
POST http://10.47.193.16/api/aiwan/read
POST http://10.47.193.16/api/aiwan/write
```

APIHub 接口：

```text
POST /gw/v2/aiwan/api/aiwan/read
POST /gw/v2/aiwan/api/aiwan/write
```

当前可用 curl 验证：

```bash
curl -sS -X POST 'http://10.47.193.16/api/aiwan/read' \
  -H 'Content-Type: application/json' \
  --data '{
    "run_id":"loop-v162-2026-W29-20260716T201500_0800",
    "stage":"validate",
    "week":"2026-W29",
    "include":["run_meta"],
    "history_weeks":0
  }' | python3 -m json.tool
```

目前返回关键结构：

```json
{
  "ok": true,
  "context": {
    "run_meta": {
      "status": "running",
      "stages": {
        "validate": {
          "status": "warn",
          "revision": 1,
          "output_type": "validation_result"
        }
      }
    }
  },
  "current_output": {
    "stage": "validate",
    "status": "warn",
    "output_type": "validation_result",
    "revision": 1,
    "payload": {
      "processed_data": {},
      "analysis_result": {},
      "validation_result": {}
    }
  }
}
```

---

## 2. 当前问题

现在不是 Loop 没跑通，也不是 API 没写入，而是服务器侧还没把 AIWAN 写入结果消费到页面/dashboard 当前读取的数据结构中。

### 2.1 写入位置

AIWAN write 当前只写入：

```text
model-tag-monitor/data/aiwan-runs/<run_id>/validate.json
model-tag-monitor/data/aiwan-runs/<run_id>/run.json
```

对应代码：

```text
model-tag-monitor/src/aiwan-run-store.js
```

### 2.2 dashboard 当前消费位置

`/api/dashboard` 当前消费的是：

```text
category-cache.json
board-metrics.json
business-overview-insights-<week>.json
business-overview-insights.json
```

关键代码：

```text
model-tag-monitor/src/server.js
model-tag-monitor/src/compose-dashboard.js
model-tag-monitor/scripts/generate-business-overview-insights.js
```

`server.js` 当前逻辑：

```js
const businessOverviewInsights = readBusinessOverviewInsights(week);
const result = mergeBusinessOverviewInsights(
  composeDashboardV2({ categoryCache, taxonomy, boardMetrics, week, prevWeek }),
  businessOverviewInsights
);
```

`readBusinessOverviewInsights(week)` 只读：

```text
business-overview-insights-<week>.json
business-overview-insights.json
```

没有读取：

```text
aiwan-runs/<run_id>/validate.json
```

所以当前表现是：**AIWAN 数据已写入，但 dashboard 不会消费。**

### 2.3 run_meta 状态仍是 running

`aiwan-run-store.js` 中 `updateRunFromStage(record)` 目前要求四个阶段文件都存在才将 run 标记为 success：

```js
const allDone = STAGE_ORDER.every((s) =>
  stages[s] && ['success', 'warn', 'skipped'].includes(stages[s].status)
);
```

但 v1.6.2 新契约是：

```text
read    不写服务器
process 不写服务器
analyze 只读服务器，不写服务器
validate 最终一次性写服务器，payload 中包含 processed_data + analysis_result + validation_result
```

因此服务器只看到 `validate` 一个阶段文件，导致：

```text
run_meta.status = running
```

这会影响后续消费逻辑，如果消费方判断 `run.status !== success` 则不会使用该结果。

---

## 3. 本次要做的事情

本次建议做两个最小闭环改动。

### 改动 A：修正 AIWAN validate-only 最终写入的 run 状态

目标：当 validate 最终写入包含完整 payload 时，run_meta 应标记为 `success` 或 `warn`，不能继续 `running`。

建议规则：

```text
如果 record.stage === 'validate'
且 record.output_type === 'validation_result'
且 record.payload 包含 processed_data、analysis_result、validation_result
且 record.status in ['success', 'warn']
则 run.status = record.status
```

也就是说：

```text
validate.status = success -> run.status = success
validate.status = warn    -> run.status = warn
validate.status = failed  -> run.status = failed
```

注意：目前 `VALID_STATUSES` 支持 `warn`，但 run.status 之前只用了 `success/running/failed`。如果前端或脚本不接受 `warn`，可以采用：

```text
run.status = success
run.overall_status = warn
```

建议优先方案：

```text
run.status = record.status === 'failed' ? 'failed' : 'success'
run.overall_status = record.status
```

这样兼容已有只判断 success 的消费逻辑，同时保留 warn 语义。

需要修改文件：

```text
model-tag-monitor/src/aiwan-run-store.js
```

建议新增 helper：

```js
function isValidateFinalRecord(record) {
  const payload = record && record.payload && typeof record.payload === 'object' ? record.payload : {};
  return record.stage === 'validate'
    && record.output_type === 'validation_result'
    && payload.processed_data
    && payload.analysis_result
    && payload.validation_result;
}
```

然后在 `updateRunFromStage(record)` 中：

```js
const validateFinal = isValidateFinalRecord(record);
const runStatus = failed
  ? 'failed'
  : validateFinal
    ? 'success'
    : allDone
      ? 'success'
      : 'running';

const run = {
  ...current,
  status: runStatus,
  overall_status: validateFinal ? record.status : current.overall_status || null,
  ...
};
```

### 改动 B：把 AIWAN validate 结果桥接到 dashboard insights 缓存

目标：dashboard 可以消费 Loop 产出的 `analysis_result`。

最小实现路径：在 validate 写入成功后，同步生成/覆盖：

```text
business-overview-insights-<week>.json
```

这样现有 `/api/dashboard` 不用大改，就可以通过已有的：

```js
readBusinessOverviewInsights(week)
mergeBusinessOverviewInsights(...)
```

消费新分析结果。

建议新增转换函数：

```text
model-tag-monitor/src/aiwan-insights-bridge.js
```

职责：

```text
AIWAN validate payload -> business-overview-insights-<week>.json
```

输入：

```js
record.payload.processed_data
record.payload.analysis_result
record.payload.validation_result
```

输出文件结构需兼容：

```text
model-tag-monitor/scripts/business-overview-insights.schema.json
```

当前 schema 最小结构：

```json
{
  "insights": {
    "board": "string",
    "tiers": {
      "发展": "string",
      "孵化": "string",
      "种子": "string"
    },
    "secondaryCategories": [],
    "categories": [],
    "category": "string",
    "monitor": "string"
  },
  "warnings": []
}
```

实际 `mergeBusinessOverviewInsights` 还会判断：

```js
if (cached.week !== result.week) return result;
```

所以输出必须包含：

```json
{
  "week": "2026-W29",
  "insights": {},
  "warnings": [],
  "generatedAt": "...",
  "generatedBy": "aiwan-v1.6.2-loop",
  "mode": "aiwan_loop",
  "analysisStatus": {}
}
```

注意：schema 当前 `additionalProperties=false`，但线上缓存文件可能已有额外字段。落地时有两个选择：

1. 如果 `check-ai-insights-quality.js` 接受现有扩展字段，则按现有 `generate-business-overview-insights.js` 输出风格写。
2. 如果严格按 schema 校验，则同步更新 schema，让 `week/generatedAt/generatedBy/mode/analysisStatus/inputHash` 合法。

建议先参考现有线上/本地缓存：

```bash
ls model-tag-monitor/data/business-overview-insights*.json
cat model-tag-monitor/data/business-overview-insights.json | head
```

转换建议：

```js
function buildAiwanBusinessOverviewInsights(record) {
  const payload = record.payload || {};
  const processed = payload.processed_data || {};
  const analysis = payload.analysis_result || {};
  const validation = payload.validation_result || {};

  const summary = analysis.summary || {};
  const findings = Array.isArray(analysis.findings) ? analysis.findings : [];
  const warnings = [
    ...(Array.isArray(record.warnings) ? record.warnings : []),
    ...(Array.isArray(validation.warnings) ? validation.warnings : []),
    ...(Array.isArray(analysis.warnings) ? analysis.warnings : []),
  ].filter(Boolean).map(String);

  return {
    week: record.week,
    insights: {
      board: buildBoardInsight(summary, findings, processed),
      tiers: {
        "发展": buildTierInsight("发展", findings),
        "孵化": buildTierInsight("孵化", findings),
        "种子": buildTierInsight("种子", findings)
      },
      secondaryCategories: buildSecondaryCategoryInsights(findings),
      categories: buildCategoryInsights(findings),
      category: buildCategorySummary(findings),
      monitor: buildMonitorInsight(validation, warnings)
    },
    warnings,
    generatedAt: new Date().toISOString(),
    generatedBy: "aiwan-v1.6.2-loop",
    mode: "aiwan_loop",
    analysisStatus: {
      state: "rolling",
      source: "aiwan-v1.6.2-loop",
      run_id: record.run_id,
      status: record.status,
      revision: record.revision,
      written_at: record.written_at
    }
  };
}
```

最小文本兜底策略：

- `board`：用 `analysis.summary` 或 findings 中 overall 级别内容；没有则写 “AI 小万已完成本周滚动分析，详见品类观察”。
- `categories`：把 finding 中 `entity_type=category` 的项转换为 `{ name, insight }`。
- `secondaryCategories`：如果没有二级类目映射，可先输出空数组或按 finding 的 `level=cluster` 输出。
- `tiers`：暂时保持兜底文案，避免破坏 dashboard 结构。
- `monitor`：写校验状态、数据缺口、是否 publish_allowed。

建议在 `writeStageResult(body)` 后，当 record 是 validate final 时调用：

```js
const { publishAiwanInsightsFromValidate } = require('./aiwan-insights-bridge');
...
if (isValidateFinalRecord(record)) {
  publishAiwanInsightsFromValidate(record);
}
```

注意要保证失败不影响 write 主路径：

```js
try {
  publishAiwanInsightsFromValidate(record);
} catch (e) {
  store.appendLog({ action: 'aiwan-insights-bridge-failed', ... });
}
```

---

## 4. 推荐实施步骤

### Step 1：本地修改

```bash
cd /Users/lilixiaoran/工作/转转/ai数据分析工作流
```

修改：

```text
model-tag-monitor/src/aiwan-run-store.js
model-tag-monitor/src/aiwan-insights-bridge.js   # 新增
```

必要时修改：

```text
model-tag-monitor/scripts/business-overview-insights.schema.json
model-tag-monitor/scripts/check-ai-insights-quality.js
```

### Step 2：本地测试 run_meta 状态

可以直接写一个临时 Node 测试脚本，模拟 validate record：

```bash
node - <<'NODE'
const aiwan = require('./model-tag-monitor/src/aiwan-run-store');
const result = aiwan.writeStageResult({
  run_id: 'local-aiwan-bridge-smoke-20260716',
  week: '2026-W29',
  stage: 'validate',
  status: 'warn',
  output_type: 'validation_result',
  payload: {
    processed_data: { status: 'warn' },
    analysis_result: {
      status: 'warn',
      summary: { text: '测试分析摘要' },
      findings: [
        {
          entity_type: 'category',
          entity_name: '测试品类',
          metric: 'gmv',
          direction: 'up',
          severity: 'medium',
          confidence: 'medium',
          evidence: ['测试证据'],
          recommended_drilldowns: ['测试下钻']
        }
      ]
    },
    validation_result: { status: 'warn', publish_allowed: true, warnings: ['测试 warning'] }
  },
  warnings: ['测试 warning']
});
console.log(JSON.stringify(result.run, null, 2));
NODE
```

预期：

```text
run.status = success
run.overall_status = warn
```

### Step 3：本地测试 dashboard insight 文件生成

检查是否生成：

```bash
ls -l model-tag-monitor/data/business-overview-insights-2026-W29.json
cat model-tag-monitor/data/business-overview-insights-2026-W29.json | python3 -m json.tool | head -120
```

### Step 4：本地启动服务验证 dashboard 消费

```bash
cd model-tag-monitor
npm install   # 如已安装可跳过
PORT=8848 npm start
```

另开终端：

```bash
curl -sS 'http://127.0.0.1:8848/api/dashboard?week=2026-W29' \
  -H 'Cookie: wxfx_access=<如本地需要门禁则先登录>' \
  | python3 -m json.tool | grep -n 'aiwan\|generatedBy\|测试品类\|测试分析摘要' -C 3
```

如果本地门禁影响测试，可以直接用模块测试 `mergeBusinessOverviewInsights` 或临时在开发环境带 cookie。

### Step 5：部署到 10.47.193.16

之前部署目录是：

```text
/opt/soft/model-tag-monitor/app/model-tag-monitor
```

建议部署前备份：

```bash
ssh 10.47.193.16 '
cd /opt/soft/model-tag-monitor/app/model-tag-monitor &&
cp src/aiwan-run-store.js src/aiwan-run-store.js.bak-aiwan-bridge-20260716
'
```

拷贝文件并重启服务：

```bash
scp model-tag-monitor/src/aiwan-run-store.js \
  10.47.193.16:/opt/soft/model-tag-monitor/app/model-tag-monitor/src/aiwan-run-store.js

scp model-tag-monitor/src/aiwan-insights-bridge.js \
  10.47.193.16:/opt/soft/model-tag-monitor/app/model-tag-monitor/src/aiwan-insights-bridge.js

ssh 10.47.193.16 'sudo systemctl restart model-tag-monitor-api.service && sudo systemctl status model-tag-monitor-api.service --no-pager -l'
```

如果 SSH 不通，使用现有部署通道处理。

### Step 6：线上验证

1）重新 POST 一个 validate 测试写入，或等明天 06:10 Loop 自动跑。也可以用现有 payload 重新写一次新的测试 run_id。

2）验证 AIWAN read：

```bash
curl -sS -X POST 'http://10.47.193.16/api/aiwan/read' \
  -H 'Content-Type: application/json' \
  --data '{
    "run_id":"loop-v162-2026-W29-20260716T201500_0800",
    "stage":"validate",
    "week":"2026-W29",
    "include":["run_meta"],
    "history_weeks":0
  }' | python3 -m json.tool
```

预期：

```text
context.run_meta.status = success
context.run_meta.overall_status = warn
current_output.revision >= 1
```

3）验证 dashboard 消费：

```bash
curl -sS 'http://10.47.193.16/api/dashboard?week=2026-W29' \
  -H 'Cookie: wxfx_access=<cookie>' \
  | python3 -m json.tool | grep -n 'aiwan-v1.6.2-loop\|generatedBy\|analysisStatus' -C 5
```

预期：

```text
dashboard.insights.generatedBy = aiwan-v1.6.2-loop
dashboard.insights.mode = aiwan_loop
dashboard.analysisStatus.source = aiwan-v1.6.2-loop
```

---

## 5. 验收标准

必须同时满足：

1. zloop 当前 v1.6.2 Loop 仍是唯一 enabled 的 AI 小万 Loop。
2. 每日调度是 `06:10 Asia/Shanghai`。
3. `POST /api/aiwan/write` validate 最终写入后：
   - `data/aiwan-runs/<run_id>/validate.json` 存在。
   - `data/aiwan-runs/<run_id>/run.json` 中 `status=success`。
   - `overall_status=warn|success` 正确保留业务状态。
4. 服务器生成：
   - `data/business-overview-insights-<week>.json`
5. `/api/dashboard?week=<week>` 返回中能看到 AIWAN 生成的 insights。
6. 旧 dashboard 数据聚合不受影响：`category-cache/board-metrics/taxonomy` 仍正常参与 compose。
7. 如果 AIWAN bridge 转换失败，不能影响 `/api/aiwan/write` 主写入；只能记录 log。

---

## 6. 风险点

1. **schema 兼容风险**  
   `business-overview-insights.schema.json` 当前写得比较窄，但实际缓存和 merge 逻辑可能已有扩展字段。修改前先看本地/线上实际缓存结构。

2. **week 口径风险**  
   当前 Loop 写的是 `2026-W29`。dashboard week 也应使用同样格式，否则 `cached.week !== result.week` 会导致 merge 被跳过。

3. **warn 状态兼容风险**  
   run.status 如果直接写 `warn`，可能有消费方只认 `success`。建议 `run.status=success`，另加 `overall_status=warn`。

4. **AIWAN 数据与 dashboard 原始聚合口径差异**  
   AIWAN 分析结果来自 Loop SQL 和服务器上下文；dashboard 原始指标来自现有 cache。短期只把 AIWAN 作为 insights 文案来源，不替换底层指标。

5. **现有 v1.6 data-read SQL 模板缺失问题**  
   当前这次 Loop 是运行时自己探表写 SQL 跑通的，但长期看，`ai-wan-v16-data-read` 还需要恢复/迁移 v1.5.5 的 SQL templates 和 xinghe 委托说明。这个是另一个待办，不属于本次服务器消费桥接的最小闭环。

---

## 7. 建议提交信息

```bash
git add model-tag-monitor/src/aiwan-run-store.js \
        model-tag-monitor/src/aiwan-insights-bridge.js \
        docs/AI小万_v1.6.2_服务器消费桥接交接文档_20260716.md

git commit -m "feat(aiwan): bridge v1.6 validate output to dashboard insights"

git push origin codex/server-migration-20260714
```

注意：当前仓库还有其他未提交改动，提交前要先 `git status --short`，只 stage 本次相关文件，避免混入 Skill 同步过程中的中间产物。
