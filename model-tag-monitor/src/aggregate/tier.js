'use strict';

const { sumCounts, calcRates, calcDelta } = require('./funnel');

/**
 * Tier 层聚合：按 tier（发展/孵化/种子）分组求和重算转化率。
 * 已下线品类：cur 含全部（因为 cur 是当周快照），delta 排除已下线后求和再算环比。
 *
 * @param {Array<{category,tier,status,cur:Record<string,number|null>}>} categoryLayerCur  当周 buildCategoryLayer 输出
 * @param {Array<{category,tier,status,cur:Record<string,number|null>}>|null} categoryLayerPrev  上周 buildCategoryLayer 输出
 * @returns {Array<{tier:string, cur:Record<string,number|null>, delta:Record<string,number|null>|null}>}
 */
function buildTierLayer(categoryLayerCur, categoryLayerPrev) {
  const cats = categoryLayerCur || [];
  const tiers = [...new Set(cats.map((c) => c.tier))].sort();

  return tiers.map((tier) => {
    // cur：该 tier 全部品类（含已下线）求和
    const tierCats = cats.filter((c) => c.tier === tier);
    const curRows = tierCats.map((c) => c.cur);
    const curSums = sumCounts(curRows);
    if (!curSums.conditionUv && curSums.jkuv) curSums.conditionUv = curSums.jkuv;
    const cur = { ...curSums, ...calcRates(curSums) };

    // delta：排除已下线
    let delta = null;
    if (categoryLayerPrev) {
      const activeCur = tierCats.filter((c) => c.status !== '已下线').map((c) => c.cur);
      const activeCurSums = sumCounts(activeCur);
      const activeCurRates = calcRates(activeCurSums);

      const prevTierCats = categoryLayerPrev.filter((c) => c.tier === tier && c.status !== '已下线');
      const activePrevSums = sumCounts(prevTierCats.map((c) => c.cur));
      const activePrevRates = calcRates(activePrevSums);

      delta = calcDelta(activeCurRates, activePrevRates);
    }

    return { tier, cur, delta };
  });
}

module.exports = { buildTierLayer };
