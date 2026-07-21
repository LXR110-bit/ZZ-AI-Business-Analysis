-- APP DAU / 回收入口 UV 周日均。
-- 口径模板来源：DAU&回收入口日均.sql。
-- 输出目标周及上周两行，供 Dashboard 当前周展示与环比计算。
select
    date_sub(
        to_date(a.dt),
        pmod(datediff(to_date(a.dt), '2018-01-01'), 7)
    ) as week_start_date,
    count(distinct a.dt) as day_cnt,
    round(
        sum(cast(a.dau as double)) / count(distinct a.dt),
        2
    ) as avg_dau,
    round(
        sum(cast(a.entrance_uv as double)) / count(distinct a.dt),
        2
    ) as avg_recycle_entrance_uv
from hdp_ubu_zhuanzhuan_ads_c2b.ads_bi_recycle_traffic_order_overview_inc_1d a
where a.dt between date_sub(
            next_day(date_sub('${outFileSuffix}', 7), 'MON'),
            7
          )
          and '${hiveconf:end_date}'
  and a.platform = 'all'
  and a.terminal = 'all'
  and a.perform = 'all'
  and a.c2b_cate_name = 'all'
  and a.cate_name = 'all'
  and a.business_line = 'all'
  and a.is_tradein = 'all'
  and a.cate_type = 'all'
  and a.c2b_order_brand_name = 'all'
group by
    date_sub(
        to_date(a.dt),
        pmod(datediff(to_date(a.dt), '2018-01-01'), 7)
    )
limit 100;
