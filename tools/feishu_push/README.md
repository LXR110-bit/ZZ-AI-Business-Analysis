# tools/feishu_push

飞书群卡片推送.支持 **webhook** 自定义机器人 和 **bot 身份**(lark-cli)双通道,自动降级.

- 无第三方依赖,只用 Python 标准库(urllib / subprocess)
- 三级降级链:`interactive card` → `post` 富文本 → `text` 纯文本 → `outbox` 落盘兜底
- 30 KB 卡片大小保护(超限直接跳过 interactive,从 post 开始)
- dry-run 模式:不发消息,只把渲染结果写到 outbox 目录

## 快速开始

### 场景一 · 自定义机器人 webhook(推荐给业务群)

前置:飞书群 → 设置 → 群机器人 → 添加自定义机器人,拿到 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx`.

```bash
python tools/feishu_push/send_card.py \
  --template monitor_weekly \
  --payload tools/feishu_push/examples/example_monitor_payload.json \
  --webhook-url "$FEISHU_WEBHOOK_URL"
```

### 场景二 · Bot 身份(zz-server 上用)

前置:同机 `lark-cli` 已用 `--as bot` 登录,bridge 存有 App Secret.

```bash
# zz-server 上 lark-cli 归 root 独占,admin 用户需 sudo
LARK_CLI_CMD="sudo -n lark-cli" \
python3 -m tools.feishu_push.send_card \
  --template monitor_weekly \
  --payload tools/feishu_push/examples/example_monitor_payload.json \
  --chat-id oc_f84e79531cfbd11c42196c774094dafd
```

### 场景三 · Dry-run(本地验证渲染)

```bash
python tools/feishu_push/send_card.py \
  --template monitor_weekly \
  --payload examples/example_monitor_payload.json \
  --dry-run --outbox-dir /tmp/feishu_outbox
```

Dry-run 不联网,把渲染后的完整消息 JSON 写到 outbox 目录,方便肉眼检查.

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LARK_CLI_CMD` | `lark-cli` | bot 通道调用命令.zz-server 上设为 `sudo -n lark-cli` |
| `FEISHU_WEBHOOK_URL` | — | 自定义机器人 URL,CLI 会读它作为 `--webhook-url` 默认值(见 send_card.py) |
| `FEISHU_OUTBOX_DIR` | `tools/feishu_push/outbox` | 兜底 outbox 落盘目录 |

## 代码里调用

```python
from tools.feishu_push import push_card

result = push_card(
    template="monitor_weekly",
    payload={"week": "2025-W27", "top_anomalies": [...], "dashboard_url": "..."},
    chat_id="oc_f84e79531cfbd11c42196c774094dafd",  # 或 webhook_url="..."
)
# result = {"status": "sent", "message_id": "om_xxx", "channel": "bot", ...}
```

## 卡片模板

模板放在 `card_templates/`,当前提供:

| 模板名 | 用途 | 关键 payload 字段 |
|---|---|---|
| `monitor_weekly` | 周报主卡:标题、周次、Top 异常列表、dashboard 链接 | `week`, `top_anomalies[]`, `dashboard_url`, `subtitle?` |
| `monitor_weekly_item` | 单条异常项(被 `monitor_weekly` 循环引用) | `title`, `metric`, `delta`, `severity` |
| `generic_alert` | 通用告警 | `title`, `body`, `level?`, `link?` |

模板里的循环用结构化占位:

```json
{ "__loop__": "top_anomalies", "item_template": "monitor_weekly_item" }
```

不用手拼字符串,避免 JSON 破损.

## 降级链

`interactive card` → `post` 富文本 → `text` 纯文本 → outbox 落盘

任何一层失败(网络 / 大小 / 权限),自动尝试下一层.四层都失败才抛 `PushError`.

## 测试

```bash
python -m pytest tools/feishu_push/tests -q
```

17 个用例,覆盖模板渲染、循环展开、缺字段、双通道、降级链、oversize 保护、outbox 落盘、CLI 退出码.不联网、不调 lark-cli.

## 已知 warning

用 `python -m tools.feishu_push.send_card` 会看到:

```
RuntimeWarning: 'tools.feishu_push.send_card' found in sys.modules ...
```

这是 `__init__.py` 里 re-export 时 Python 的双 import 提示,不影响功能.如果介意,直接跑 `python tools/feishu_push/send_card.py` 即可.

