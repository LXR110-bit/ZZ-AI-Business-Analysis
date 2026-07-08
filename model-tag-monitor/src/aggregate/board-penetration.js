'use strict';

/**
 * Level 1：大盘渗透层。
 *
 * 从 App DAU → 回收入口 UV → 渗透率，位于大盘漏斗之上。
 */

/**
 * @param {{rows:Array<{week:string, appDau:number, recycleEntranceUv:number, brandPageUv?:number, penetrationRate?:number, realPenetrationRate?:number}>}|null} boardMetrics
 * @param {string} week
 * @param {string|null} prevWeek
 * @param {{orderUv:number}|null} boardCur  大盘漏斗层 cur（用于计算真实渗透率）
 * @returns {{appDau, recycleEntranceUv, brandPageUv, penetrationRate, realPenetrationRate, delta}}
 */
function buildBoardPenetrationLayer(boardMetrics, week, prevWeek, boardCur) {
  const nullResult = {
    appDau: null,
    recycleEntranceUv: null,
    brandPageUv: null,
    penetrationRate: null,
    realPenetrationRate: null,
    delta: { appDau: null, recycleEntranceUv: null, brandPageUv: null, penetrationRate: null, realPenetrationRate: null },
  };

  if (!boardMetrics || !boardMetrics.rows) return nullResult;

  const curRow = boardMetrics.rows.find((r) => r.week === week);
  if (!curRow) return nullResult;

  const appDau = Number(curRow.appDau) || 0;
  const recycleEntranceUv = Number(curRow.recycleEntranceUv) || 0;
  const brandPageUv = curRow.brandPageUv == null ? null : (Number(curRow.brandPageUv) || 0);

  const penetrationRate = curRow.penetrationRate == null
    ? (appDau > 0 ? recycleEntranceUv / appDau : null)
    : Number(curRow.penetrationRate);
  const realPenetrationRate = curRow.realPenetrationRate == null
    ? (appDau > 0 && boardCur && boardCur.orderUv != null
      ? boardCur.orderUv / appDau
      : null)
    : Number(curRow.realPenetrationRate);

  // 环比
  let delta = { appDau: null, recycleEntranceUv: null, brandPageUv: null, penetrationRate: null, realPenetrationRate: null };
  if (prevWeek) {
    const prevRow = boardMetrics.rows.find((r) => r.week === prevWeek);
    if (prevRow) {
      const prevDau = Number(prevRow.appDau) || 0;
      const prevUv = Number(prevRow.recycleEntranceUv) || 0;
      const prevBrand = prevRow.brandPageUv == null ? null : (Number(prevRow.brandPageUv) || 0);
      const prevPenetration = prevRow.penetrationRate == null
        ? (prevDau > 0 ? prevUv / prevDau : null)
        : Number(prevRow.penetrationRate);
      const prevRealPenetration = prevRow.realPenetrationRate == null
        ? null
        : Number(prevRow.realPenetrationRate);

      delta.appDau = appDau - prevDau;
      delta.recycleEntranceUv = recycleEntranceUv - prevUv;
      delta.brandPageUv = brandPageUv == null || prevBrand == null ? null : brandPageUv - prevBrand;

      if (prevPenetration != null && prevPenetration !== 0 && penetrationRate != null) {
        delta.penetrationRate = penetrationRate - prevPenetration;
      }
      if (prevRealPenetration != null && realPenetrationRate != null) {
        delta.realPenetrationRate = realPenetrationRate - prevRealPenetration;
      }
    }
  }

  return { appDau, recycleEntranceUv, brandPageUv, penetrationRate, realPenetrationRate, delta };
}

module.exports = { buildBoardPenetrationLayer };
