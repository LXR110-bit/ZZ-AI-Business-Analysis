set hive.exec.parallel=true;    --并发执行
set hive.map.aggr=true;     --避免倾斜
set hive.auto.convert.join=true;    --启动 Map Join自动转换
SET mapred.reduce.tasks = 800;
set spark.sql.shuffle.partition = 4000;

set start_date = ${outFileSuffix};    --功能上线的开始日期，也可以根据需求自行设置日期
set end_date = ${outFileSuffix};  --代表昨日


set order_source = 2701017  --转转邮寄
                ,2705008    --找靓机邮寄
                ,2701034    --：转转聚合回收上门
                ,2701035    --：转转聚合回收上门增单
                ,2705014    --：找靓机聚合回收上门
                ,2705013    --：找靓机聚合回收上门增单
                ,2706006	-- 线下门店-聚合回收
                
;

-- =========================================================
-- 品类维度周日均Sheet4_履约维度
-- 说明：单 Sheet 独立 SQL；不建临时表，不依赖跨语句 CTE；履约维度只统计下单及之后指标。
-- =========================================================
-- =========================================================
-- 品类维度周日均Sheet4_履约维度
-- 说明：履约维度只统计下单及之后指标；估价uv没有 order_source，不在本表输出。
-- =========================================================
with order_info as (
    SELECT DISTINCT
	'create' as classify
	,to_date(t0.c2b_create_time  ) as date_column
 	,t0.order_cate_id as cate_id
	,t0.order_brand_id  as brand_id 
	,t0.order_model_id  as model_id	
	,t0.seller_id  as uid
	,t0.rec_parent_order_id
	,t0.rec_order_id
	,'' as c1_get
    ,'' as rk 
    ,t0.buyer_id 
    ,t0.platform_id
    ,t0.order_cate_name as cate_name
    ,t0.order_brand_name  as brand_name
    ,t0.order_model_name as model_name
    ,t0.order_source
    -- ,t0.perform
    ,t0.eval_price 
    ,t0.pur_seller_act_receipt_amt
    ,t0.engineer_allowance_price
    ,t0.coupon_add_price
    ,t0.amount_coupon_add_price
    ,t0.system_maintain_price
    ,t0.kf_control_return_price
    ,t0.kf_control_return_ma_price
    ,t0.comment
    ,t0.comment_detail
    ,t0.nps_score
    ,t0.nps_score_level
    ,case when t0.snapshot_city = '' or t0.snapshot_city is null then '未知' else t0.snapshot_city end as city
    ,t0.pre_qc_code
    ,t0.qc_code 
FROM hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d t0
where t0.dt =  '$bash{date +%Y-%m-%d -d '-1 day'}'
    and  to_date(t0.c2b_create_time) BETWEEN date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:end_date}'
    and t0.order_source in (2701017,2705008,2701034,2701035,2705014,2705013,2706006)

 union all 
 SELECT DISTINCT
	'cancel' as classify
	,to_date(t0.user_cancel_time) as date_column
 	  ,t0.order_cate_id as cate_id
	,t0.order_brand_id  as brand_id 
	,t0.order_model_id  as model_id	
	,t0.seller_id  as uid
	,t0.rec_parent_order_id
	,t0.rec_order_id
	,'' as c1_get
    ,'' as rk 
    ,t0.buyer_id 
    ,t0.platform_id
    ,t0.order_cate_name as cate_name
    ,t0.order_brand_name  as brand_name
    ,t0.order_model_name as model_name
    ,t0.order_source
    -- ,t0.perform

    ,t0.eval_price 
    ,t0.pur_seller_act_receipt_amt
    ,t0.engineer_allowance_price
    ,t0.coupon_add_price
    ,t0.amount_coupon_add_price
    ,t0.system_maintain_price
    ,t0.kf_control_return_price
    ,t0.kf_control_return_ma_price
    ,t0.comment
    ,t0.comment_detail
    ,t0.nps_score
    ,t0.nps_score_level
    ,case when t0.snapshot_city = '' or t0.snapshot_city is null then '未知' else t0.snapshot_city end as city
    ,t0.pre_qc_code
    ,t0.qc_code 
    FROM hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d t0
    where t0.dt = '$bash{date +%Y-%m-%d -d '-1 day'}'
        and  to_date(t0.user_cancel_time) BETWEEN date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:end_date}'
        and t0.order_source in (2701017,2705008,2701034,2701035,2705014,2705013,2706006)
        and t0.c2b_deliver_time = ''

union ALL

--发货
SELECT DISTINCT
	'deliver' as classify
	,to_date(t0.c2b_deliver_time  ) as date_column
 	  ,t0.order_cate_id as cate_id
	,t0.order_brand_id  as brand_id 
	,t0.order_model_id  as model_id	
	,t0.seller_id  as uid
	,t0.rec_parent_order_id
	,t0.rec_order_id
	,'' as c1_get
    ,'' as rk 
    ,t0.buyer_id 
    ,t0.platform_id
    ,t0.order_cate_name as cate_name
    ,t0.order_brand_name  as brand_name
    ,t0.order_model_name as model_name
    ,t0.order_source
    -- ,t0.perform

    ,t0.eval_price 
    ,t0.pur_seller_act_receipt_amt
    ,t0.engineer_allowance_price
    ,t0.coupon_add_price
    ,t0.amount_coupon_add_price
    ,t0.system_maintain_price
    ,t0.kf_control_return_price
    ,t0.kf_control_return_ma_price
    ,t0.comment
    ,t0.comment_detail
    ,t0.nps_score
    ,t0.nps_score_level	
    ,case when t0.snapshot_city = '' or t0.snapshot_city is null then '未知' else t0.snapshot_city end as city
    ,t0.pre_qc_code
    ,t0.qc_code 
FROM hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d t0
where t0.dt = '$bash{date +%Y-%m-%d -d '-1 day'}' 
    and  to_date(t0.c2b_deliver_time) BETWEEN date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:end_date}'
    and t0.order_source in (2701017,2705008,2701034,2701035,2705014,2705013,2706006)

	  union ALL

--签收
 SELECT distinct 
	 'receive' as classify
	 ,to_date(t0.c2b_receive_time  ) as date_column  
 	,t0.order_cate_id as cate_id
	 ,t0.order_brand_id  as brand_id 
	 ,t0.order_model_id  as model_id		
	 ,t0.seller_id  as uid
	 ,t0.rec_parent_order_id
	 ,t0.rec_order_id
	 ,'' as c1_get
    ,'' as rk 
    ,t0.buyer_id 
    ,t0.platform_id
    ,t0.order_cate_name as cate_name
    ,t0.order_brand_name  as brand_name
    ,t0.order_model_name as model_name 
    ,t0.order_source
    -- ,t0.perform	

    ,t0.eval_price 
    ,t0.pur_seller_act_receipt_amt
    ,t0.engineer_allowance_price
    ,t0.coupon_add_price
    ,t0.amount_coupon_add_price
    ,t0.system_maintain_price
    ,t0.kf_control_return_price
    ,t0.kf_control_return_ma_price
    ,t0.comment
    ,t0.comment_detail
    ,t0.nps_score
    ,t0.nps_score_level
    ,case when t0.snapshot_city = '' or t0.snapshot_city is null then '未知' else t0.snapshot_city end as city
    ,t0.pre_qc_code
    ,t0.qc_code 
FROM hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d t0		 
where t0.dt = '$bash{date +%Y-%m-%d -d '-1 day'}'
    and  to_date(t0.c2b_receive_time) BETWEEN date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:end_date}'
    and t0.order_source in (2701017,2705008,2701034,2701035,2705014,2705013,2706006)

 union ALL

--质检
 SELECT distinct 
	 'qc' as classify
	 ,to_date(t0.c2b_check_finish_time  ) as date_column  
 	,t0.qc_cate_id as cate_id
	 ,t0.qc_brand_id  as brand_id 
	 ,t0.qc_model_id  as model_id		
	 ,t0.seller_id  as uid
	 ,t0.rec_parent_order_id
	 ,t0.rec_order_id
	 ,'' as c1_get
    ,'' as rk 
    ,t0.buyer_id 
    ,t0.platform_id
    ,t0.qc_cate_name as cate_name
    ,t0.qc_brand_name  as brand_name
    ,t0.qc_model_name as model_name 
    ,t0.order_source
    -- ,t0.perform	

    ,t0.eval_price 
    ,t0.pur_seller_act_receipt_amt
    ,t0.engineer_allowance_price
    ,t0.coupon_add_price
    ,t0.amount_coupon_add_price
    ,t0.system_maintain_price
    ,t0.kf_control_return_price
    ,t0.kf_control_return_ma_price
    ,t0.comment
    ,t0.comment_detail
    ,t0.nps_score
    ,t0.nps_score_level
    ,case when t0.snapshot_city = '' or t0.snapshot_city is null then '未知' else t0.snapshot_city end as city
    ,t0.pre_qc_code
    ,t0.qc_code 
FROM hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d t0		 
where t0.dt = '$bash{date +%Y-%m-%d -d '-1 day'}'
    and  to_date(t0.c2b_check_finish_time) BETWEEN date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:end_date}'
    and t0.order_source in (2701017,2705008,2701034,2701035,2705014,2705013,2706006)

	  union ALL

--成交
 SELECT distinct 
	 'deal' as classify
	 ,to_date(t0.deal_time  ) as date_column 
 	,t0.qc_cate_id as cate_id
	 ,t0.qc_brand_id  as brand_id 
	 ,t0.qc_model_id  as model_id		
	 ,t0.seller_id  as uid
	 ,t0.rec_parent_order_id
	 ,t0.rec_order_id
	 ,t0.pur_seller_act_receipt_amt/100 as c1_get
    ,row_number() over(partition by t0.rec_order_id) as rk 
    ,t0.buyer_id 
    ,t0.platform_id
    ,t0.qc_cate_name as cate_name
    ,t0.qc_brand_name  as brand_name
    ,t0.qc_model_name as model_name
    ,t0.order_source
    -- ,t0.perform

    ,t0.eval_price 
    ,t0.pur_seller_act_receipt_amt
    ,t0.engineer_allowance_price
    ,t0.coupon_add_price
    ,t0.amount_coupon_add_price
    ,t0.system_maintain_price
    ,t0.kf_control_return_price
    ,t0.kf_control_return_ma_price
    ,t0.comment
    ,t0.comment_detail
    ,t0.nps_score
    ,t0.nps_score_level
    ,case when t0.snapshot_city = '' or t0.snapshot_city is null then '未知' else t0.snapshot_city end as city
    ,t0.pre_qc_code
    ,t0.qc_code 
FROM hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d t0 
where t0.dt = '$bash{date +%Y-%m-%d -d '-1 day'}'  
    and to_date(t0.deal_time) BETWEEN date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:end_date}'
    and t0.order_source in (2701017,2705008,2701034,2701035,2705014,2705013,2706006)

union ALL

--退回
 SELECT distinct 
	 'act_return' as classify
	 ,to_date(t0.act_return_time) as date_column  
 	,t0.qc_cate_id as cate_id
	 ,t0.qc_brand_id  as brand_id 
	 ,t0.qc_model_id  as model_id		
	 ,t0.seller_id  as uid
	 ,t0.rec_parent_order_id
	 ,t0.rec_order_id
	 ,'' as c1_get
    ,'' as rk 
    ,t0.buyer_id 
    ,t0.platform_id
    ,t0.qc_cate_name as cate_name
    ,t0.qc_brand_name  as brand_name
    ,t0.qc_model_name as model_name 
    ,t0.order_source
    -- ,t0.perform	

    ,t0.eval_price 
    ,t0.pur_seller_act_receipt_amt
    ,t0.engineer_allowance_price
    ,t0.coupon_add_price
    ,t0.amount_coupon_add_price
    ,t0.system_maintain_price
    ,t0.kf_control_return_price
    ,t0.kf_control_return_ma_price
    ,t0.comment
    ,t0.comment_detail
    ,t0.nps_score
    ,t0.nps_score_level
    ,case when t0.snapshot_city = '' or t0.snapshot_city is null then '未知' else t0.snapshot_city end as city
    ,t0.pre_qc_code
    ,t0.qc_code 
FROM hdp_ubu_zhuanzhuan_dm_c2b.dm_recycle_order_detail_full_1d t0		 
where t0.dt = '$bash{date +%Y-%m-%d -d '-1 day'}'
    and  to_date(t0.act_return_time) BETWEEN date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:end_date}'
    and t0.order_source in (2701017,2705008,2701034,2701035,2705014,2705013,2706006)
)
-- Sheet 4: 周日均品类维度&履约漏斗数据
select
    date_sub(a.date_column, pmod(datediff(a.date_column, '2018-01-01'), 7)) as week_start_date,
    a.cate_name as `品类名称`,
    case a.order_source
        when '2701017' then '转转邮寄'
        when '2701034' then '转转聚合预约回收上门'
        when '2701035' then '转转聚合回收上门增单'
        when '2706006' then '线下门店-聚合回收'
        else concat('未知_', a.order_source)
    end as `履约方式（只取线上流程）`,
    case when a.date_column between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),1) then 7
         when a.date_column between next_day(date_sub('${outFileSuffix}', 7), 'MON') and '${hiveconf:end_date}' then datediff('${hiveconf:end_date}',next_day(date_sub('${outFileSuffix}', 7), 'MON'))+1
         else 0 end as day_cnt,
    count(distinct if(a.classify = 'create', a.uid, null)) as `下单uv`,
    count(distinct if(a.classify = 'create', a.rec_parent_order_id, null)) as `下单量`,
    count(distinct if(a.classify = 'deliver', a.rec_parent_order_id, null)) as `发货量`,
    count(distinct if(a.classify = 'receive', a.rec_order_id, null)) as `签收量`,
    count(distinct if(a.classify = 'qc', a.rec_order_id, null)) as `质检量`,
    count(distinct if(a.classify = 'deal', a.rec_order_id, null)) as `成交量`,
    count(distinct if(a.classify = 'act_return', a.rec_order_id, null)) as `退回量`,
    sum(if(a.classify = 'deal' and a.rk = 1, a.c1_get, 0)) as `成交GMV`
from order_info a
where a.date_column between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and '${hiveconf:end_date}'
  and a.order_source in ('2701017', '2701034', '2701035', '2706006')
group by
    date_sub(a.date_column, pmod(datediff(a.date_column, '2018-01-01'), 7)),
    a.cate_name,
    a.order_source,
    case when a.date_column between date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),7) and date_sub(next_day(date_sub('${outFileSuffix}', 7), 'MON'),1) then 7
         when a.date_column between next_day(date_sub('${outFileSuffix}', 7), 'MON') and '${hiveconf:end_date}' then datediff('${hiveconf:end_date}',next_day(date_sub('${outFileSuffix}', 7), 'MON'))+1
         else 0 end
;
