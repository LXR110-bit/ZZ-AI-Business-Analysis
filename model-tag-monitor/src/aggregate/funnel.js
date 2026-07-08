'use strict';

/**
 * 共享计算原语：计数字段求和、转化率计算、环比计算。
 * 被 category/tier/board 三层共用。
 */

const COUNT_KEYS = [
  // 兼容旧契约：jkuv=机况 UV，evaUv=估价/可下单基准 UV
  'jkuv', 'evaUv', 'evaCnt',
  // v2 周会漏斗补充：聚合 → 品牌 → 机型 → 机况
  'aggregationUv', 'brandPageUv', 'modelPageUv', 'conditionUv',
  // 下游转化与成交
  'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv',
];
const RATE_KEYS = ['evaRate', 'orderRate', 'shipRate', 'dealRate'];

/**
 * 多行计数字段求和。
 * @param {Array<Record<string,number>>} rows
 * @returns {Record<string,number>}
 */
function sumCounts(rows) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = 0;
  for (const row of rows) {
    for (const k of COUNT_KEYS) {
      out[k] += Number(row[k]) || 0;
    }
  }
  return out;
}

/**
 * 从求和后的计数字段计算 4 个转化率。
 * 分母为 0 时转化率为 null。
 * @param {Record<string,number>} sums  sumCounts 的返回值
 * @returns {{evaRate: number|null, orderRate: number|null, shipRate: number|null, dealRate: number|null}}
 */
function calcRates(sums) {
  const conditionUv = sums.conditionUv || 0;
  const jkuv = conditionUv || sums.jkuv || 0;
  const evaUv = sums.evaUv || 0;
  return {
    evaRate: jkuv > 0 ? evaUv / jkuv : null,
    orderRate: evaUv > 0 ? (sums.orderUv || 0) / evaUv : null,
    shipRate: evaUv > 0 ? (sums.shipCnt || 0) / evaUv : null,
    dealRate: evaUv > 0 ? (sums.dealCnt || 0) / evaUv : null,
  };
}

/**
 * 计算环比变化率：(cur - prev) / prev。
 * cur 或 prev 为 null 时对应字段返回 null；prev 为 0 时返回 null（除零保护）。
 * @param {Record<string,number|null>|null} cur
 * @param {Record<string,number|null>|null} prev
 * @returns {Record<string,number|null>}
 */
function calcDelta(cur, prev) {
  const out = {};
  for (const k of RATE_KEYS) {
    const c = cur && cur[k];
    const p = prev && prev[k];
    if (c == null || p == null || p === 0) {
      out[k] = null;
    } else {
      out[k] = (c - p) / p;
    }
  }
  return out;
}

/**
 * 计算计数字段的绝对变化和百分比变化。
 * 用于异动检测（anomaly detection）。
 * @param {Record<string,number|null>|null} cur
 * @param {Record<string,number|null>|null} prev
 * @param {string[]} [keys=COUNT_KEYS]
 * @returns {Record<string,{abs:number|null, pct:number|null}>}
 */
function calcCountDelta(cur, prev, keys) {
  const ks = keys || COUNT_KEYS;
  const out = {};
  for (const k of ks) {
    const c = cur && cur[k];
    const p = prev && prev[k];
    if (c == null || p == null) {
      out[k] = { abs: null, pct: null };
    } else {
      out[k] = { abs: c - p, pct: p === 0 ? null : (c - p) / p };
    }
  }
  return out;
}

module.exports = { COUNT_KEYS, RATE_KEYS, sumCounts, calcRates, calcDelta, calcCountDelta };
