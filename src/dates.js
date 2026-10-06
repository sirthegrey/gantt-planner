'use strict';

/* Чтение дат из xlsx. Общий код для Ганта и конвертера: одна и та же ячейка
 * должна давать одну и ту же календарную дату в обоих файлах. */

/** Excel serial (система 1900) -> UTC-дата без времени. */
function serialToDate(n) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
}

/**
 * Значение ячейки (Date из SheetJS, serial, строка) -> UTC-дата без времени.
 * SheetJS отдаёт Date в той системе, в которой построил его сам, поэтому
 * берём ту интерпретацию, где время - полночь: так сдвиг часового пояса не
 * может перекинуть дату на сутки.
 */
function excelDateValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    const localMidnight = v.getHours() === 0 && v.getMinutes() === 0;
    if (localMidnight) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  if (typeof v === 'number' && isFinite(v)) return serialToDate(v);
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const m2 = v.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m2) return new Date(Date.UTC(+m2[3], +m2[2] - 1, +m2[1]));
  }
  return null;
}

/** UTC-дата -> 'YYYY-MM-DD'. */
function isoDay(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Сегодняшняя дата (UTC-полночь). */
function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function addDaysUtc(date, days) {
  return new Date(date.getTime() + days * 86400000);
}
