-- =========================================================
-- SQL 取数第一阶段（v2 · 增加品类名称 + 时间范围改成近 7 天（14 天邮件附件超过 45MB 上限））
-- 目标：不改口径，只改写法，方便后续维护和 agent 读取
--
-- v2 变更（2026-07-02）：
--   - 每个 select 增加 a.cate_name as `品类名称`（放在 `机型ID` 之前，即 `日期` 之后）
--   - 每个 group by 增加 a.cate_name
--   - 时间范围从"单日 T-1"改成"近 7 天（14 天邮件附件超过 45MB 上限）"：
--       where a.dt        between date_sub('${hiveconf:run_dt}', 6) and '${hiveconf:run_dt}'
--         and a.stat_date between date_sub('${hiveconf:run_dt}', 6) and '${hiveconf:run_dt}'
--     其余口径完全不变。
--
-- 保持不变的口径：
--   1) run_dt 仍取 T-1（跑批当天的前一天为窗口右端）
--   2) order_source 仅保留 4 个线上流程：
--      - 2701017 = 转转邮寄
--      - 2701034 = 转转聚合预约回收上门
--      - 2701035 = 转转聚合回收上门增单
--      - 2706006 = 线下门店-聚合回收
--   3) 核心属性 / 成色统一取估价侧 ev_* 字段
--   4) 不做"预估=质检"过滤
--   5) 所有 UV 输出字段名统一为小写 uv
--
-- 源表：
--   hdp_ubu_zhuanzhuan_tmp_c2b.tmp_c2b_union_model_slice_inc_1d
-- =========================================================

set hive.exec.parallel=true;
set hive.map.aggr=true;
set hive.auto.convert.join=true;
set hive.strict.checks.cartesian.product=false;
set hive.strict.checks.large.query=false;
set hive.mapred.mode=nonstrict;
set spark.sql.shuffle.partitions = 200;
set mapreduce.job.reduces = 200;
set run_dt = ${#date(0,0,-1):yyyy-MM-dd#};

-- =========================================================
-- Sheet 1: 日期机型维度漏斗数据
-- ⚠ 口径要点：机况uv / 估价uv 是前端浏览埋点，order_source 为空串，
--    不能做 4 值过滤（否则被全部误杀变空）；
--    下单uv 及之后的指标才带履约来源，限定 4 值。
--    => order_source 过滤下放到各指标 case when，不放在 where。
-- =========================================================
select
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)) as week_start_date,
    a.cate_name as `品类名称`,
    a.model_id as `机型ID`,
    a.model_name as `机型名称`,
    -- 前端 UV：不做 order_source 过滤
    sum(case when a.data_column = '机况选择uv' then a.data else 0 end) as `机况uv`,
    sum(case when a.data_column = '估价uv' then a.data else 0 end) as `估价uv`,
    -- 下单及之后：限定 4 个线上履约来源
    sum(case when a.data_column = '下单uv'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `下单uv`,
    sum(case when a.data_column = '下单量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `下单量`,
    sum(case when a.data_column = '发货量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `发货量`,
    sum(case when a.data_column = '签收量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `签收量`,
    sum(case when a.data_column = '质检量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `质检量`,
    sum(case when a.data_column = '成交量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `成交量`,
    sum(case when a.data_column = '退回量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `退回量`,
    sum(case when a.data_column = '成交GMV' and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `成交GMV`
from hdp_ubu_zhuanzhuan_tmp_c2b.tmp_c2b_union_model_slice_inc_1d a
where a.dt        between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
  and a.stat_date between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
group by
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)),
    a.model_id,
    a.model_name,
    a.cate_name
;

-- =========================================================
-- Sheet 2: 机型核心属性&成色漏斗数据（估价侧）
-- 估价uv 无 order_source 不过滤；下单及之后限定 4 值
-- =========================================================
select
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)) as week_start_date,
    a.cate_name as `品类名称`,
    a.model_id as `机型ID`,
    a.model_name as `机型名称`,
    coalesce(nullif(trim(a.ev_param_name), ''), a.ev_param_id) as `核心属性（估价）`,
    coalesce(nullif(trim(a.ev_grade_name), ''), a.ev_grade_id) as `成色等级（估价）`,
    sum(case when a.data_column = '估价uv' then a.data else 0 end) as `估价uv`,
    sum(case when a.data_column = '下单uv'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `下单uv`,
    sum(case when a.data_column = '下单量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `下单量`,
    sum(case when a.data_column = '发货量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `发货量`,
    sum(case when a.data_column = '签收量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `签收量`,
    sum(case when a.data_column = '质检量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `质检量`,
    sum(case when a.data_column = '成交量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `成交量`,
    sum(case when a.data_column = '退回量'  and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `退回量`,
    sum(case when a.data_column = '成交GMV' and a.order_source in ('2701017','2701034','2701035','2706006') then a.data else 0 end) as `成交GMV`
from hdp_ubu_zhuanzhuan_tmp_c2b.tmp_c2b_union_model_slice_inc_1d a
where a.dt        between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
  and a.stat_date between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
group by
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)),
    a.model_id,
    a.model_name,
    a.cate_name,
    a.ev_param_id,
    a.ev_param_name,
    a.ev_grade_id,
    a.ev_grade_name
;

-- =========================================================
-- Sheet 3: 机型质检成交数据（质检侧）
-- 全是下单之后的指标，4 值过滤可直接放 where
-- =========================================================
select
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)) as week_start_date,
    a.cate_name as `品类名称`,
    a.model_id as `机型ID`,
    a.cate_name as `品类名称`,
    a.model_id as `机型ID`,
    a.model_name as `机型名称`,
    coalesce(nullif(trim(a.qc_param_name), ''), a.qc_param_id) as `核心属性（质检）`,
    coalesce(nullif(trim(a.qc_grade_name), ''), a.qc_grade_id) as `成色等级（质检）`,
    sum(case when a.data_column = '质检量' then a.data else 0 end) as `质检量`,
    sum(case when a.data_column = '成交量' then a.data else 0 end) as `成交量`,
    sum(case when a.data_column = '退回量' then a.data else 0 end) as `退回量`,
    sum(case when a.data_column = '成交GMV' then a.data else 0 end) as `成交GMV`
from hdp_ubu_zhuanzhuan_tmp_c2b.tmp_c2b_union_model_slice_inc_1d a
where a.dt        between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
  and a.stat_date between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
  and a.order_source in ('2701017', '2701034', '2701035', '2706006')
group by
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)),
    a.model_id,
    a.model_name,
    a.cate_name,
    a.qc_param_id,
    a.qc_param_name,
    a.qc_grade_id,
    a.qc_grade_name
;

-- =========================================================
-- Sheet 4: 机型维度&履约漏斗数据
-- 维度含履约方式(order_source)，4 值过滤直接放 where。
-- ⚠ 估价uv 无 order_source，按履约方式拆分时会落空，属数据本质。
-- =========================================================
select
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)) as week_start_date,
    a.cate_name as `品类名称`,
    a.cate_name as `品类名称`,
    a.model_id as `机型ID`,
    a.model_name as `机型名称`,
    case a.order_source
        when '2701017' then '转转邮寄'
        when '2701034' then '转转聚合预约回收上门'
        when '2701035' then '转转聚合回收上门增单'
        when '2706006' then '线下门店-聚合回收'
        else concat('未知_', a.order_source)
    end as `履约方式（只取线上流程）`,
    sum(case when a.data_column = '估价uv' then a.data else 0 end) as `估价uv`,
    sum(case when a.data_column = '下单uv' then a.data else 0 end) as `下单uv`,
    sum(case when a.data_column = '下单量' then a.data else 0 end) as `下单量`,
    sum(case when a.data_column = '发货量' then a.data else 0 end) as `发货量`,
    sum(case when a.data_column = '签收量' then a.data else 0 end) as `签收量`,
    sum(case when a.data_column = '质检量' then a.data else 0 end) as `质检量`,
    sum(case when a.data_column = '成交量' then a.data else 0 end) as `成交量`,
    sum(case when a.data_column = '退回量' then a.data else 0 end) as `退回量`,
    sum(case when a.data_column = '成交GMV' then a.data else 0 end) as `成交GMV`
from hdp_ubu_zhuanzhuan_tmp_c2b.tmp_c2b_union_model_slice_inc_1d a
where a.dt        between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
  and a.stat_date between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
  and a.order_source in ('2701017', '2701034', '2701035', '2706006')
group by
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)),
    a.model_id,
    a.model_name,
    a.cate_name,
    a.order_source
;

-- =========================================================
-- Sheet 5: 机型核心属性&成色&履约方式漏斗数据（估价侧）
-- 维度含履约方式(order_source)，4 值过滤直接放 where。
-- ⚠ 估价uv 无 order_source，按履约方式拆分时会落空，属数据本质。
-- =========================================================
select
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)) as week_start_date,
    a.cate_name as `品类名称`,
    a.model_id as `机型ID`,
    a.cate_name as `品类名称`,
    a.model_id as `机型ID`,
    a.model_name as `机型名称`,
    coalesce(nullif(trim(a.ev_param_name), ''), a.ev_param_id) as `核心属性（估价）`,
    coalesce(nullif(trim(a.ev_grade_name), ''), a.ev_grade_id) as `成色等级（估价）`,
    case a.order_source
        when '2701017' then '转转邮寄'
        when '2701034' then '转转聚合预约回收上门'
        when '2701035' then '转转聚合回收上门增单'
        when '2706006' then '线下门店-聚合回收'
        else concat('未知_', a.order_source)
    end as `履约方式（只取线上流程）`,
    sum(case when a.data_column = '估价uv' then a.data else 0 end) as `估价uv`,
    sum(case when a.data_column = '下单uv' then a.data else 0 end) as `下单uv`,
    sum(case when a.data_column = '下单量' then a.data else 0 end) as `下单量`,
    sum(case when a.data_column = '发货量' then a.data else 0 end) as `发货量`,
    sum(case when a.data_column = '签收量' then a.data else 0 end) as `签收量`,
    sum(case when a.data_column = '质检量' then a.data else 0 end) as `质检量`,
    sum(case when a.data_column = '成交量' then a.data else 0 end) as `成交量`,
    sum(case when a.data_column = '退回量' then a.data else 0 end) as `退回量`,
    sum(case when a.data_column = '成交GMV' then a.data else 0 end) as `成交GMV`
from hdp_ubu_zhuanzhuan_tmp_c2b.tmp_c2b_union_model_slice_inc_1d a
where a.dt        between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
  and a.stat_date between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:run_dt}'
  and a.order_source in ('2701017', '2701034', '2701035', '2706006')
group by
    date_sub(a.stat_date, pmod(datediff(a.stat_date, '2018-01-01'), 7)),
    a.model_id,
    a.model_name,
    a.cate_name,
    a.ev_param_id,
    a.ev_param_name,
    a.ev_grade_id,
    a.ev_grade_name,
    a.order_source
;
