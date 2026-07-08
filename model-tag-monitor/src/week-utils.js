'use strict';

/**
 * ISO week 日期工具。
 *
 * ISO 8601 规则：
 * - 一周从周一开始
 * - W01 是包含该年第一个周四的那周（等价于包含 1 月 4 日的那周）
 */

/**
 * 将 "YYYY-Www" 格式解析为周一和周日的日期字符串。
 * @param {string} weekStr  e.g. "2026-W27"
 * @returns {{monday: string, sunday: string}}  e.g. {monday:'2026-06-29', sunday:'2026-07-05'}
 */
function isoWeekToRange(weekStr) {
  const match = weekStr.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid ISO week format: "${weekStr}"`);

  const year = Number(match[1]);
  const week = Number(match[2]);

  if (week < 1 || week > 53) throw new Error(`Week out of range: ${week}`);

  const monday = isoWeekMonday(year, week);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  return {
    monday: formatDate(monday),
    sunday: formatDate(sunday),
  };
}

/**
 * 格式化为 weekRange 字符串。
 * @param {string} weekStr
 * @returns {string}  e.g. "2026-06-29 ~ 2026-07-05"
 */
function isoWeekToRangeStr(weekStr) {
  const { monday, sunday } = isoWeekToRange(weekStr);
  return `${monday} ~ ${sunday}`;
}

/**
 * 计算 ISO year/week 对应的周一日期。
 * 算法：该年 1 月 4 日所在周的周一 + (week-1)*7
 */
function isoWeekMonday(year, week) {
  // 1 月 4 日一定在 W01 中
  const jan4 = new Date(Date.UTC(year, 0, 4));
  // jan4 的星期几（周一=1 ... 周日=7）
  const dayOfWeek = jan4.getUTCDay() || 7; // getUTCDay: 0=Sun → 7
  // W01 的周一
  const w01Monday = new Date(jan4);
  w01Monday.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1));
  // 目标周的周一
  const target = new Date(w01Monday);
  target.setUTCDate(w01Monday.getUTCDate() + (week - 1) * 7);
  return target;
}

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { isoWeekToRange, isoWeekToRangeStr };
