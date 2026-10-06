'use strict';

/* Workbook ingest. Column layout of the template (see Шаблон.xlsx):
 *
 *   A Номер | B Приоритет | C Название | D Общая длительность, дн
 *   E Начало базовое | F Окончание базовое | G Начало фактическое | H Окончание фактическое
 *   I Оценка SP
 *   J C++, ч   | K Исполнитель C++
 *   L Питон, ч | M Исполнитель питон
 *   N Дотнет, ч| O Исполнитель дотнет
 *   P Фронт, ч | Q Исполнитель фронт
 */

/** Колонка «Не раньше» (ограничение начала) и тройки доп. фаз идут после 17
 * стандартных колонок. Раскладка определяется по заголовкам, поэтому читаются
 * и файлы старого формата (тройки сразу с R), и новые (R = «Не раньше»). */
const NOT_BEFORE_HEADER = /не\s*раньше/i;
const EXTRA_BLOCK_HEADER = /стек/i;
const EXTRA_BLOCK_STRIDE = 3;


const COL_NUM = 0;
const COL_PRIORITY = 1;
const COL_NAME = 2;
const COL_DURATION = 3;
const COL_BASE_START = 4;
const COL_BASE_FINISH = 5;
const COL_ACT_START = 6;
const COL_ACT_FINISH = 7;
const COL_SP = 8;

/** Значение ячейки -> UTC-дата без времени (см. src/dates.js). */
const toDate = excelDateValue;

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : null;
}

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * Parse an xlsx ArrayBuffer into the project model.
 * Returns {tasks, skipped, warnings}.
 */
function parseWorkbook(data) {
  // cellDates stays off: raw serial numbers go through serialToDate(), which
  // is timezone-independent. ISO date cells (t="d") still arrive as Date
  // objects and are handled by toDate().
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  const tasks = [];
  const skipped = [];
  const warnings = [];

  // Раскладка колонок по заголовкам: где «Не раньше», где начинаются тройки.
  const headerRow = rows[0] || [];
  const colAfterStandard = 17; // 17 стандартных колонок шаблона
  const headerCell = (i) => toStr(headerRow[i]);
  let notBeforeCol = -1;
  let extraStartCol = colAfterStandard;
  if (NOT_BEFORE_HEADER.test(headerCell(colAfterStandard))) {
    notBeforeCol = colAfterStandard;
    extraStartCol = colAfterStandard + 1;
  } else if (EXTRA_BLOCK_HEADER.test(headerCell(colAfterStandard))) {
    extraStartCol = colAfterStandard; // старый формат: тройки сразу после Q
  }

  // Защита от загрузки РКК.xlsx напрямую: у него названия задач тоже лежат в
  // колонке H, но колонки J-Q значат совсем другое.
  const headerText = headerRow.map(toStr).join(' | ');
  if (!/Название/i.test(headerText)) {
    warnings.push({
      kind: 'wrong-format',
      message: 'Заголовки не похожи на Шаблон.xlsx. Если это РКК.xlsx — сконвертируйте его кнопкой «Конвертер РКК» в шапке.'
    });
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const name = toStr(row[COL_NAME]);
    const num = toNum(row[COL_NUM]);
    if (name === '' && num === null) continue; // blank line

    const phases = [];
    for (const stack of STACKS) {
      const hours = toNum(row[stack.hoursCol]);
      const executor = toStr(row[stack.execCol]);
      if (hours === null || hours <= 0) continue;
      if (executor === '') {
        warnings.push({
          kind: 'missing-executor',
          taskNum: num,
          message: `${name}: ${stack.label} — ${hours} ч без исполнителя, фаза пропущена`
        });
        continue;
      }
      phases.push({ stack: stack.key, label: stack.label, series: stack.series, hours, executor });
    }

    // Дополнительные фазы: один стек может повторяться (несколько исполнителей
    // на одном стеке). Тройки колонок: стек | часы | исполнитель.
    for (let col = extraStartCol; ; col += EXTRA_BLOCK_STRIDE) {
      const stack = stackByLabel(row[col]);
      if (!stack) break; // тройки идут подряд, пустая ячейка стека = конец
      const hours = toNum(row[col + 1]);
      const executor = toStr(row[col + 2]);
      if (hours === null || hours <= 0 || executor === '') {
        if (hours || executor) {
          warnings.push({
            kind: 'missing-executor',
            taskNum: num,
            message: `${name}: доп. фаза ${stack.label} без часов или исполнителя, пропущена`
          });
        }
        continue;
      }
      phases.push({ stack: stack.key, label: stack.label, series: stack.series, hours, executor });
    }

    // Фазы идут по каноническому порядку стеков (C++ -> Питон -> Дотнет ->
    // Фронт); несколько фаз одного стека сохраняют порядок записи в файле.
    phases.forEach((p, i) => { p.id = i; });
    const stackRank = (p) => {
      const i = STACK_ORDER.indexOf(p.stack);
      return i === -1 ? 99 : i;
    };
    const order = phases.map((_, i) => i).sort((a, b) => stackRank(phases[a]) - stackRank(phases[b]) || a - b);

    const task = {
      num: num !== null ? num : tasks.length + 1,
      priority: toNum(row[COL_PRIORITY]) ?? 99,
      name: name || `Задача ${num}`,
      durationDays: toNum(row[COL_DURATION]),
      baselineStart: toDate(row[COL_BASE_START]),
      baselineFinish: toDate(row[COL_BASE_FINISH]),
      actualStart: toDate(row[COL_ACT_START]),
      actualFinish: toDate(row[COL_ACT_FINISH]),
      notBefore: notBeforeCol >= 0 ? toDate(row[notBeforeCol]) : null,
      sp: toNum(row[COL_SP]),
      phases,
      phaseOrder: order // индексы фаз в порядке выполнения
    };

    if (phases.length === 0) {
      // Keep the row on the chart (marked "нет фаз") rather than dropping it
      // silently: an empty row in the source file is something to fix.
      skipped.push(task);
      warnings.push({ kind: 'no-phases', taskNum: task.num, message: `${task.name}: нет ни одной фазы с часами и исполнителем` });
    }
    tasks.push(task);
  }

  return { tasks, skipped, warnings, sheetName };
}
