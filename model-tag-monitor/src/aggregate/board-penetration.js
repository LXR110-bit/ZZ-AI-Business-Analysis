'use strict';

/**
 * Level 1：大盘渗透层。
 *
 * 飞书/board_metrics 补充边界固定为：APP DAU、回收入口 UV。
 * 大盘漏斗字段仍由 category-cache 的品类维度周日均数据聚合，不从这里读取。
 */

/**
 * @param {{rows:Array<{week:string, appDau:number, recycleEntranceUv:number, penetrationRate?:number, realPenetrationRate?:number}>}|null} boardMetrics
 * @param {string} week
 * @param {string|null} prevWeek
 * @param {{orderUv:number}|null} boardCur  大盘漏斗层 cur（用于计算真实渗透率）
 * @returns {{appDau, recycleEntranceUv, penetrationRate, realPenetrationRate, delta}}
 */
function buildBoardPenetrationLayer(boardMetrics, week, prevWeek, boardCur) {
  const nullResult = {
    appDau: null,
    recycleEntranceUv: null,
    penetrationRate: null,
    realPenetrationRate: null,
    delta: { appDau: null, recycleEntranceUv: null, penetrationRate: null, realPenetrationRate: null },
  };

  if (!boardMetrics || !boardMetrics.rows) return nullResult;

  const curRow = boardMetrics.rows.find((r) => r.week === week);
  if (!curRow) return nullResult;

  const appDau = Number(curRow.appDau) || 0;
  const recycleEntranceUv = Number(curRow.recycleEntranceUv) || 0;

  const penetrationRate = curRow.penetrationRate == null
    ? (appDau > 0 ? recycleEntranceUv / appDau : null)
    : Number(curRow.penetrationRate);
  const realPenetrationRate = curRow.realPenetrationRate == null
    ? (appDau > 0 && boardCur && boardCur.orderUv != null
      ? boardCur.orderUv / appDau
      : null)
    : Number(curRow.realPenetrationRate);

  // 环比
  let delta = { appDau: null, recycleEntranceUv: null, penetrationRate: null, realPenetrationRate: null };
  if (prevWeek) {
    const prevRow = boardMetrics.rows.find((r) => r.week === prevWeek);
    if (prevRow) {
      const prevDau = Number(prevRow.appDau) || 0;
      const prevUv = Number(prevRow.recycleEntranceUv) || 0;
      const prevPenetration = prevRow.penetrationRate == null
        ? (prevDau > 0 ? prevUv / prevDau : null)
        : Number(prevRow.penetrationRate);
      const prevRealPenetration = prevRow.realPenetrationRate == null
        ? null
        : Number(prevRow.realPenetrationRate);

      delta.appDau = appDau - prevDau;
      delta.recycleEntranceUv = recycleEntranceUv - prevUv;

      if (prevPenetration != null && prevPenetration !== 0 && penetrationRate != null) {
        delta.penetrationRate = penetrationRate - prevPenetration;
      }
      if (prevRealPenetration != null && realPenetrationRate != null) {
        delta.realPenetrationRate = realPenetrationRate - prevRealPenetration;
      }
    }
  }

  return { appDau, recycleEntranceUv, penetrationRate, realPenetrationRate, delta };
}

module.exports = { buildBoardPenetrationLayer };
