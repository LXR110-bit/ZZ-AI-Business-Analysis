# AGENTS.md — 转转数据分析知识库 · bot 查询协议

> **读者**：任何要基于飞书 base 知识库（4 张表）拼 SQL 的 AI bot。
> **目标**：拿到自然语言提问 → 查 base → 输出可执行的 Hive SQL。
> **base URL**：https://zhuanzhuan.feishu.cn/wiki/N6OVb2qz5aKxf9sY9kRc7y6onYd
> **base token**：`N6OVb2qz5aKxf9sY9kRc7y6onYd`

---

## 0. 四张表的角色

| 表 | 表 ID | 干什么 | 谁会引用它 |
|---|---|---|---|
| **01.底表清单** | `tblftpX7cOIusYmF` | Hive 物理表登记 | 02 表的「所属底表」字段 |
| **02.字段清单** | `tblWdOaeJzyxWdOe` | 字段类型、主键、坑点 | 04 表的「引用字段」 |
| **03.维值表** | `tblJ6CSz02t6NIaI` | 枚举值 → 业务含义 | 04 表的「引用维值」 |
| **04.口径表** | `tbl1hVd85juddTNY` | 业务问题 → SQL 片段 + 上下文 | 业务 bot 主入口 |

**底表统计**：14 张物理表 · 68 个核心字段 · 29 条维值 · 18 条核心口径（v1.0）。

---

## 1. bot 查询的标准流程（5 步）

```
[自然语言提问]
   ↓
1. 关键词路由：抽业务名词（"GMV"、"机况页 UV"、"未触达组"等）
   ↓
2. 查 04.口径表 → +record-search keyword=<关键词>
   ↓
3. 顺着「引用字段」link 拿字段类型 / 坑点 / 所属底表
   ↓
4. 顺着「引用维值」link 拿枚举值（如 order_state=80）
   ↓
5. 顺着 02 表的「所属底表」link 拿底表的更新频率 / 分区策略
   ↓
[拼 SQL，带齐分区条件 + 排除条件 + 类型转换]
```

**心法**：永远先查 04，**不要直接查 02 或 01**。04 表已经把 SQL 片段写好了，bot 只要做"组装"，不做"创造"。

---

## 2. 关键 CLI 命令清单

### 2.1 查口径（最常用，从这里开始）

```bash
# 按关键词搜口径
lark-cli base +record-search --as user \
  --base-token N6OVb2qz5aKxf9sY9kRc7y6onYd \
  --table-id tbl1hVd85juddTNY \
  --keyword "GMV" --search-field "口径名" --limit 5

# 列所有口径（看全貌）
lark-cli base +record-list --as user \
  --base-token N6OVb2qz5aKxf9sY9kRc7y6onYd \
  --table-id tbl1hVd85juddTNY \
  --field-id "口径ID" --field-id "口径名" --field-id "计算公式"
```

### 2.2 查字段坑点

```bash
# 按字段名找
lark-cli base +record-search --as user \
  --base-token N6OVb2qz5aKxf9sY9kRc7y6onYd \
  --table-id tblWdOaeJzyxWdOe \
  --keyword "uid" --search-field "字段名"
```

### 2.3 查底表更新频率 / 分区策略

```bash
lark-cli base +record-search --as user \
  --base-token N6OVb2qz5aKxf9sY9kRc7y6onYd \
  --table-id tblftpX7cOIusYmF \
  --keyword "回收订单" --search-field "中文名"
```

### 2.4 查枚举值含义

```bash
lark-cli base +record-search --as user \
  --base-token N6OVb2qz5aKxf9sY9kRc7y6onYd \
  --table-id tblJ6CSz02t6NIaI \
  --keyword "Push" --search-field "业务含义"
```

---

## 3. 典型问答示例

### 3.1 用户问："本周回收业务的 GMV 是多少？"

bot 应该做：

1. 关键词路由 → 抽出 **GMV** + **本周** + **回收**
2. 查 04.口径表 `--keyword "GMV"` → 命中 **DEF003 GMV(元)** + **DEF002 成交单**
3. DEF002 的「引用字段」link 到 FLD006 `order_source` 和 FLD007 `order_state`，「引用维值」link 到 DIM001(成交=80) DIM002(测试=66)
4. DEF002 的「计算公式」直接给：`order_state = 80 AND order_source not in (66)`
5. DEF003 的「计算公式」直接给：`sum(order_amount) / 100`
6. 字段 FLD003 `dt` 备注："T+1 表，必须取 T-1 最新分区" → 查 DEF004
7. 字段 FLD003 的「所属底表」link 到 TBL001 → 底表名 `hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d`

**最终 SQL**：

```sql
SELECT sum(order_amount) / 100 AS gmv
FROM hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d
WHERE dt BETWEEN '${week_start}' AND '${week_end}'
  AND order_state = 80
  AND order_source NOT IN (66);
```

### 3.2 用户问："Push 未触达组的用户有多少？"

bot 应该做：

1. 抽出 **Push** + **未触达**
2. 查 04 → 命中 **DEF016 Push 触达 / 未触达分组**
3. DEF016 的「计算公式」直接给：`app_id=7 AND ((push_status=2) OR (push_status=7 AND is_arrive=0))`
4. 引用字段 FLD058/059/060 → 所属底表 TBL012 `hdp_zhuanzhuan_dw_global.dw_push_opperation_handling_detail_inc_1d`
5. 引用维值 DIM023(app_id=7=转转 APP) DIM025(push_status=2=被过滤) DIM026(push_status=7=已发出) DIM024(is_arrive=1=成功)

**最终 SQL**：

```sql
SELECT count(distinct uid) AS not_arrived_users
FROM hdp_zhuanzhuan_dw_global.dw_push_opperation_handling_detail_inc_1d
WHERE dt = '${target_date}'
  AND app_id = 7
  AND ( push_status = 2 OR (push_status = 7 AND is_arrive = 0) );
```

---

## 4. 高频坑点速查（出现频率从高到低）

| # | 字段 / 表 | 坑 | 对应口径 |
|---|---|---|---|
| 1 | TBL001.order_source | 必须 `not in (66)` 排除内部测试，否则 GMV 偏高 | DEF001 |
| 2 | TBL001.order_amount | 单位**分**，GMV 必须 `/100` | DEF003 |
| 3 | 所有 T+1 表 | `dt` 必须取 **T-1**，不能取 current_date() | DEF004 |
| 4 | TBL003 估价 / TBL005 埋点 | 增量表必须 `dt between T and T+1` + `to_date(time)=T`，单分区少 0.17% 数据 | DEF005 |
| 5 | TBL006 token→uid | 50% token 对应多 uid，必须 `row_number()` 选主 uid | DEF009 |
| 6 | TBL002 t_zhuanzhuan_dau | 流失用户判断**必须**用本表（平台日活），不能用业务表 | DEF010 |
| 7 | TBL008.label_value | 布尔标签实际存 `'1.0'`/`'0.0'` 浮点字符串，写 `='1'` 查不到 | DEF013 |
| 8 | TBL011.create_time | **毫秒**时间戳，必须 `/1000` | DEF015 |
| 9 | TBL012 Push 未触达 | `push_status=2 OR (push_status=7 AND is_arrive=0)` | DEF016 |
| 10 | TBL013.user_flag | 同存 token 和 uid，必须 `user_type='uid'` 过滤后 cast | DEF017 |
| 11 | 品类 GMV 分布 | 必须先建 uid+cate_id 桥表去重，否则笛卡尔积放大 | DEF011 |
| 12 | 活动用户画像 | 取活动**前一天**快照，避免被活动行为污染 | DEF014 |

---

## 5. 不在库里时怎么办

如果 04 表里搜不到匹配口径：

1. **明确告诉用户**："这个口径在知识库里没找到，可能是新业务或未审核口径，建议联系数据团队补录后再分析"
2. **不要凭印象拼 SQL** — 没有口径保障的 SQL 容易出错（最常见：忘了 `not in (66)`、忘了 `/100`、忘了分区条件）
3. 如果用户能口头给口径，**请用户先把口径写到 04 表里**（带 `状态=草稿`），下次就能命中

---

## 6. 写入回知识库（仅人工审核后）

bot **不能**自动写入 04 口径表。新口径必须经过人工审核才能进入"已审核"状态。流程：

1. 数据分析师提议新口径 → 飞书 base 02/03/04 表填入，`状态=草稿`
2. Owner 审核 → 改为 `状态=待审核` → `已审核`
3. bot 只查 `状态=已审核` 的口径

---

## 7. 一些约定

- **金额单位**：分（cent），展示前 `/100`
- **时间格式**：日期 `yyyy-MM-dd`、时间戳默认**毫秒**（已知例外见 04 表）
- **品类**：手机 / 3C / 家电 / 奢侈品 / 黄金（DIM003-007）
- **平台**：画像 / DMP 默认 `platform='zz'`（转转，DIM016）
- **APP**：Push / 实验 默认 `app_id=7`（转转 APP，DIM023）

---

## 8. 版本

- v1.0 · 2026-06-28 · 首版灌库完成（14 表 · 68 字段 · 29 维值 · 18 口径）
- v1.1 · 2026-06-29 · 新增 `scripts/wiki_seed_push.py` / `wiki_seed_pull.py` 双向同步脚本（见 §9）

---

## 9. 同步脚本使用（v1.1+）

> **飞书 base 是 source of truth**，本地 `wiki_seed/*.json` 是镜像。当前版本只做 **pull**（飞书 → 本地）。push 推迟到 schema reconcile 完成后的下个 PR。

### 9.1 从飞书拉到本地（pull）

> 场景：你或同事在飞书上改了口径 / 加了字段，要同步回 git 仓库做版本控制。

```bash
# 在 zz-server 上跑（lark-cli 认证齐全）
ssh zz-server 'cd /root/workspace/ZZ-AI-Business-Analysis && python3 scripts/wiki_seed_pull.py'

# 只拉某一张表（如只改了 04 口径）
ssh zz-server 'cd /root/workspace/ZZ-AI-Business-Analysis && python3 scripts/wiki_seed_pull.py 04_definitions'
```

跑完后：

1. `git diff wiki_seed/` 看变更
2. 满意 → `git add wiki_seed/ && git commit -m "sync(wiki_seed): pull 飞书改动"`
3. 不满意 → `git checkout wiki_seed/` 撤销

⚠️ 跑之前请 `git status` 干净，否则会覆盖未提交改动。

### 9.2 merge 语义（不是覆盖）

pull 按业务主键（口径ID / 字段ID / ...）merge 飞书记录到本地：

| 情况 | 行为 |
|---|---|
| 飞书有 + 本地有的字段 | 飞书覆盖本地（飞书是 source of truth） |
| 飞书没有 + 本地有的字段 | **保留本地**（包括所有 `_` 前缀 helper：`_所属字段` `_备注`） |
| 飞书有 + 本地没有的记录 | 新增到本地 |
| 飞书没有 + 本地有的记录 | **保留本地**（pull 永不删本地数据） |

`_` 前缀字段是本地辅助元数据（如 03 表的 `_所属字段` 标注维值属于哪张底表的哪个字段），不进飞书 base，pull 不主动创建也不删除它们。

### 9.3 已知 schema 漂移（v1.1 baseline）

baseline commit `6e60d41` 把飞书 v1.1 状态完整拉回。预期会有大量首次 diff，因为飞书在 JSON 草稿之后加了字段：

| 表 | 飞书 v1.1 新加的字段 |
|---|---|
| 01_tables | 责任人、关联字段 (双向 link → 02_fields) |
| 02_fields | 责任人、关联口径 (link → 04_definitions) |
| 03_dim_values | 责任人、状态、生效起、生效止、版本、关联口径 (link → 04_definitions) |
| 04_definitions | 责任人、变更说明、业务场景、详细说明文档链接、引用维值 (link → 03_dim_values) |

**04_definitions 表有冷余字段**：JSON 旧名 `业务描述/SQL片段/关联维值/备注` 与飞书新名 `业务定义/计算公式/引用维值/变更说明` 同时存在。merge 语义不替用户决定哪份是真相，下个 PR 手动 reconcile。

### 9.4 已知限制

- 默认走 `ssh zz-server`，因为 lark-cli 认证在那台机器上。本地直接跑需在本机装 lark-cli + 配认证
- 4 张表共约 129 条记录，全表 pull 约 30 秒
- 单表 pull 时若该表 link 字段指向其他表，会自动调 `record-list` 只投影业务主键拉目标表的 id_map（不 merge 不写盘）
- 当前用 `--limit 200` 一次拿完。如果某表行数超过 200，脚本会因 `has_more=True` 断言抛 `RuntimeError`，需要在脚本里加分页
- push（本地 → 飞书）当前未实现。schema 对齐后另 PR 接入 `record-upsert`

### 9.5 单测

脚本是 standalone，纯函数有单测，不依赖 pytest：

```bash
python3 scripts/tests/test_wiki_seed_common.py    # 6 passed
python3 scripts/tests/test_wiki_seed_pull.py      # 19 passed
```

测试覆盖：列存 → 行存 zip、`has_more=True` 守卫、record_id_list 平行数组对齐、link 字段 `[{"id":"rec..."}]` 解析、`_` 前缀字段 merge 保护、未知 record_id 降级。

