'use strict';

/**
 * Level 1：大盘渗透层。
 *
 * 从 App DAU → 回收入口 UV → 渗透率，位于大盘漏斗之上。
 */

/**
 * @param {{rows:Array<{week:string, appDau:number, recycleEntranceUv:number}>}|null} boardMetrics
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
    delta: { penetrationRate: null, realPenetrationRate: null },
  };

  if (!boardMetrics || !boardMetrics.rows) return nullResult;

  const curRow = boardMetrics.rows.find((r) => r.week === week);
  if (!curRow) return nullResult;

  const appDau = curRow.appDau || 0;
  const recycleEntranceUv = curRow.recycleEntranceUv || 0;

  const penetrationRate = appDau > 0 ? recycleEntranceUv / appDau : null;
  const realPenetrationRate = appDau > 0 && boardCur && boardCur.orderUv != null
    ? boardCur.orderUv / appDau
    : null;

  // 环比
  let delta = { penetrationRate: null, realPenetrationRate: null };
  if (prevWeek) {
    const prevRow = boardMetrics.rows.find((r) => r.week === prevWeek);
    if (prevRow) {
      const prevDau = prevRow.appDau || 0;
      const prevUv = prevRow.recycleEntranceUv || 0;
      const prevPenetration = prevDau > 0 ? prevUv / prevDau : null;

      if (prevPenetration != null && prevPenetration !== 0 && penetrationRate != null) {
        delta.penetrationRate = (penetrationRate - prevPenetration) / prevPenetration;
      }

      // realPenetrationRate 的环比需要上周 boardCur，此处简化：不传上周 boardCur 则为 null
      // 如果需要可扩展参数，当前设计保持轻量
    }
  }

  return { appDau, recycleEntranceUv, penetrationRate, realPenetrationRate, delta };
}

module.exports = { buildBoardPenetrationLayer };
