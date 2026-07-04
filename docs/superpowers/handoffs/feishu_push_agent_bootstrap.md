# 飞书推送 Agent 启动包

> 你的职责:今天跑通"飞书群消息推送 + 网站链接"最小闭环,并把它固化成可复用脚本。
> 交接时间:2025-07-04
> 交接人:Kiro(本次会话)

---

## 一、你是谁

你是**飞书推送 Agent**,专职做一件事:让项目能自动往飞书群里发**带 dashboard 链接的富文本卡片**。

产物是一个**独立、可复用、可测试**的推送模块,未来给 monitor skill(机型/品类监测周报)、project_status skill(项目状态周报)、告警系统等所有需要"发消息到飞书群"的场景调用。

**你不做的事**:
- 不做数据处理(那是数据 agent 的活)
- 不做前端页面(那是前端 agent 的活)
- 不做业务判断(推什么内容由调用方决定,你只负责"能推出去")

---

## 二、今天的目标(MVP)

跑通这条端到端链路:

```
命令行执行脚本
   ↓
读一份示例 payload(标题 + 摘要 + 3 个异常项 + dashboard URL)
   ↓
渲染成飞书交互式卡片
   ↓
POST 到测试群 webhook
   ↓
群里能看到卡片,点 "查看详情" 按钮能跳 http://47.84.94.234:8848/?...
```

**成功标准**:
1. 卡片视觉跟 spec 里画的一致(标题/分栏/异常列表/按钮)
2. 按钮能跳 dashboard 且带 URL 参数
3. 脚本支持 `--dry-run`,不真发只打印
4. 脚本支持 `--webhook-url` 参数或环境变量,不硬编码
5. 失败降级:卡片发不出去 → 降级富文本 post → 再失败降级 text → 再失败写 outbox JSON

---

## 三、参考现成代码

**同工作区已有成熟的飞书推送实现**,你先读透:

```
/Users/lilixiaoran/工作/转转/行情追踪AI助手/scripts/feishu_utils.py
/Users/lilixiaoran/工作/转转/行情追踪AI助手/scripts/send_signal_digest.py
/Users/lilixiaoran/工作/转转/行情追踪AI助手/scripts/send_daily_report.py
```

关键函数:
- `post_json(url, payload, timeout=20)` — POST 到 webhook 的通用发送
- `text_payload(text)` — 纯文本消息
- `post_payload(title, lines)` — 富文本 post 消息
- 卡片(interactive)消息目前那个项目没用,**你要新增**

**飞书交互式卡片文档**:
- 官方:<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/feishu-cards/quick-start/introduction>
- 关键 msg_type: `"interactive"`
- 卡片 JSON schema 有 header / elements / actions(按钮) 三大块

---

## 四、目录布局

```
tools/feishu_push/                    ← 新建,顶层工具目录
├── README.md                         ← 用法说明
├── send_card.py                      ← 主脚本(你写)
├── card_templates/
│   ├── monitor_weekly.json           ← 机型/品类周报卡片模板
│   ├── project_status.json           ← 项目状态卡片模板
│   └── generic_alert.json            ← 通用告警卡片模板
├── examples/
│   ├── example_monitor_payload.json  ← 示例数据,便于测试
│   └── example_project_payload.json
└── tests/
    ├── test_send_card.py             ← 单测
    └── test_dry_run.py               ← dry_run 场景
```

**语言选择**:Python 3.11+,标准库 urllib(不引依赖),跟 `行情追踪AI助手` 保持一致。

---

## 五、send_card.py 接口设计

```bash
# 基本用法
python tools/feishu_push/send_card.py \
  --template monitor_weekly \
  --payload examples/example_monitor_payload.json \
  --webhook-url "$FEISHU_TEST_WEBHOOK"

# Dry run(不真发,只打印渲染后的 JSON)
python tools/feishu_push/send_card.py \
  --template monitor_weekly \
  --payload examples/example_monitor_payload.json \
  --dry-run

# 降级链(卡片失败自动降级)
python tools/feishu_push/send_card.py \
  --template monitor_weekly \
  --payload examples/example_monitor_payload.json \
  --webhook-url "$FEISHU_TEST_WEBHOOK" \
  --fallback  # 默认开启
```

**核心 API 供 skill 调用**:
```python
from tools.feishu_push.send_card import push_card

result = push_card(
    template="monitor_weekly",
    payload={...},
    webhook_url=WEBHOOK_URL,
    dry_run=False,
    fallback=True,
)
# result: {"status": "sent"|"outbox", "message_id": str, "fallback_used": bool}
```

---

## 六、卡片模板要点(monitor_weekly 为例)

参考 `docs/superpowers/specs/model_weekly_monitor.spec.md` 第四节的模板设计:

```json
{
  "msg_type": "interactive",
  "card": {
    "header": {
      "title": {"tag": "plain_text", "content": "🔷 机型监测周报 · {{week}}"},
      "template": "blue"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**📊 本周概况**\n覆盖机型 {{total}} · 命中异常 {{watch_count}} · 环比 {{delta_symbol}}{{delta}}"
        }
      },
      {"tag": "hr"},
      {
        "tag": "div",
        "text": {"tag": "lark_md", "content": "**⚠️ Top 3 需关注**"}
      },
      // ... 循环渲染 top_anomalies (每个是一个 div,含机型名/波动/AI 归因)
      {"tag": "hr"},
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "查看完整报告"},
            "type": "primary",
            "url": "{{report_url}}"
          },
          {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "进入监测详情"},
            "type": "default",
            "url": "{{dashboard_url}}"
          }
        ]
      }
    ]
  }
}
```

**模板变量**用 `{{key}}` 占位,`send_card.py` 里做简单字符串替换即可,不引 Jinja 之类的依赖。

---

## 七、示例 payload(用来跑测试)

创建 `examples/example_monitor_payload.json`:

```json
{
  "week": "2025-W27",
  "total": 12847,
  "watch_count": 438,
  "delta_symbol": "+",
  "delta": 12,
  "top_anomalies": [
    {
      "rank": 1,
      "name": "iPhone 15 Pro Max 256G",
      "metric_current": "orderRate 12.1%",
      "metric_prev": "orderRate 18.4%",
      "delta_label": "(-34.2%)",
      "hypothesis": "疑似上周官方降价,GMV 相应下滑"
    },
    {
      "rank": 2,
      "name": "Redmi K70 Pro",
      "metric_current": "orderRate 12.6%",
      "metric_prev": "orderRate 8.2%",
      "delta_label": "(+53.6%)",
      "hypothesis": "疑似小米 618 尾款释放,可持续观察"
    },
    {
      "rank": 3,
      "name": "华为 Mate 60 Pro",
      "metric_current": "orderRate 15.3%",
      "metric_prev": "orderRate 19.8%",
      "delta_label": "(-22.7%)",
      "hypothesis": "无法在现有数据内解释,建议人工排查"
    }
  ],
  "report_url": "https://example.feishu.cn/docs/xxx",
  "dashboard_url": "http://47.84.94.234:8848/?dimension=model&week=2025-W27&from=alert"
}
```

---

## 八、需要用户提供

**阻塞项**(你自己解不了,必须找用户):

1. **测试群 webhook URL**
   - 用户需要在飞书里建一个测试群(可以就他一个人),添加"自定义机器人",拿到 webhook
   - URL 形如:`https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx`
   - 用户提供后,你放环境变量 `FEISHU_TEST_WEBHOOK`,**绝对不能提交到 git**

**你要提前告诉用户**的准备步骤:

1. 打开飞书 → 建群 → 群设置 → 群机器人 → 添加机器人 → 自定义机器人
2. 名字随便,比如"周报测试"
3. **加签校验**:v1 暂时不开(简化),v2 我们再加
4. **关键词**:也不设(不开就发什么都行)
5. 拷贝 webhook 链接给你

---

## 九、验收清单

- [ ] `tools/feishu_push/` 目录结构完整
- [ ] `send_card.py` 支持 CLI 4 个参数(template/payload/webhook-url/dry-run)
- [ ] 3 个卡片模板文件都建好(即使只跑通了 monitor_weekly)
- [ ] `dry_run` 模式输出的 JSON 结构合法(能用 <https://open.feishu.cn/tool/cardbuilder> 在线预览)
- [ ] 用户提供的测试群 webhook 实测收到卡片
- [ ] 按钮能跳到 dashboard URL 并带参数
- [ ] 降级链完整:卡片失败 → post → text → outbox JSON
- [ ] `tests/` 单测跑通(mock urlopen)
- [ ] `README.md` 写清楚:环境变量、CLI 用法、如何添加新模板

---

## 十、进阶(时间够就做,不够就写 TODO)

- 卡片模板支持 elements 列表循环渲染(top_anomalies 目前需要在 Python 里手拼字符串,能优化)
- 加签验证(增强安全)
- 消息重发去重(避免 cron 重跑发两遍)
- 富文本 markdown 消息模板(降级用)

---

## 十一、协作接口

- 你的工作日志写在 `data/agent_notes/feishu_agent_log.md`(自己建,gitignore 挡掉)
- 主控 Agent 会在 `data/agent_notes/master_to_feishu.md` 给你留话
- 数据 Agent 完成 monitor_lib_shared 后,`pusher.py` 会调用你的 `push_card()`,提前跟数据 agent 对接口

---

## 十二、开工顺序建议

1. 读参考代码(20 分钟):`行情追踪AI助手/scripts/feishu_utils.py` 全文
2. 找用户要 webhook(阻塞项,同时并行做下面的)
3. 搭目录 + 写 send_card.py 骨架(1 小时)
4. 写 monitor_weekly.json 模板 + 示例 payload(30 分钟)
5. dry-run 跑通,用飞书 CardBuilder 在线预览确认视觉(30 分钟)
6. 等到 webhook,真实发送测试(15 分钟)
7. 写降级链 + 单测(1.5 小时)
8. 写 README + 交付(30 分钟)

**总估工**:半天到一天。

---

## 十三、第一句话你可以这么开场

对用户说:

> 我是飞书推送 Agent。目标:今天跑通"飞书群卡片推送 + dashboard 链接"最小闭环。
>
> 我先并行做两件事:
> 1. 读现成参考代码,搭 tools/feishu_push/ 骨架
> 2. 等你提供测试群的 webhook URL
>
> 你能在飞书建个测试群 + 加个自定义机器人吗?步骤我可以发给你。

不要上来就大段解释项目,用户已经知道。直接推。

---

祝顺利。
