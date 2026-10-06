'use strict';

/* Конвертер РКК.xlsx -> формат Шаблон.xlsx.
 *
 * Из РКК берётся только то, что нужно Ганту:
 *   - названия задач: лист "26 4к", колонка H, строки 60-97;
 *   - приоритет: колонка A;
 *   - часы: колонки AG..AY (строка 48 - фамилии исполнителей);
 *   - стек исполнителя: таблица H/I (строки 4-36), значение вида "Python / meth".
 *
 * Стек мапится на 4 стека шаблона: C# -> Дотнет, Python -> Питон, C++ -> C++,
 * TS -> Фронт. Остальные роли (meth, Тест, DevOps, Сист. анализ, ...) в отчёт.
 * Если один стек в задаче делают несколько человек, лишние фазы уходят в
 * дополнительные тройки колонок (стек, часы, исполнитель) - Гант читает их
 * как обычные последовательные фазы того же стека.
 */

const RKK_CONFIG = {
  sheetName: '26 4к',
  taskRowStart: 60,
  taskRowEnd: 97,
  nameCol: 'H',
  priorityCol: 'A',
  readyCol: 'E',          // Готовность ТТ: раньше этой даты задача не начинается
  startCol: 'F',          // Дата начала - уходит в «Начало базовое» шаблона
  finishCol: 'G',         // Дата окончания - уходит в «Окончание базовое»
  defaultDelayDays: 7,    // если даты нет - сдвиг минимум на неделю от сегодня
  executorHeaderRow: 48,
  executorColStart: 'AG',
  executorColEnd: 'AY',
  skillsRowStart: 4,
  skillsRowEnd: 36,
  skillsNameCol: 'H',
  skillsStackCol: 'I'
};

const TEMPLATE_HEADER = [
  'Номер', 'Приоритет', 'Название', 'Общая длительность, дн',
  'Начало базовое', 'Окончание базовое', 'Начало фактическое', 'Окончание фактическое',
  'Оценка SP',
  'C++, ч', 'Исполнитель C++',
  'Питон, ч', 'Исполнитель питон',
  'Дотнет, ч', 'Исполнитель дотнет',
  'Фронт, ч', 'Исполнитель фронт'
];

const NOT_BEFORE_HEADER_LABEL = 'Не раньше';
const EXTRA_HEADER = ['Стек (доп.)', 'Часы (доп.)', 'Исполнитель (доп.)'];

function normalizeSkill(s) {
  return String(s || '').trim().toLowerCase();
}

function surnameOf(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

/** Разбор листа РКК: исполнители, скиллы, задачи. */
function parseRkkSheet(sheet) {
  const get = (row, col) => {
    const cell = sheet[col + row];
    return cell ? cell.v : null;
  };
  const num = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(',', '.'));
      return isFinite(n) ? n : null;
    }
    return null;
  };

  // Исполнители: строка 48, колонки AG..AY
  const executorCols = [];
  const startIdx = XLSX.utils.decode_col(RKK_CONFIG.executorColStart);
  const endIdx = XLSX.utils.decode_col(RKK_CONFIG.executorColEnd);
  for (let c = startIdx; c <= endIdx; c++) {
    const col = XLSX.utils.encode_col(c);
    const name = get(RKK_CONFIG.executorHeaderRow, col);
    if (typeof name === 'string' && name.trim() !== '') {
      executorCols.push({ col, surname: name.trim() });
    }
  }

  // Скиллы: таблица H/I, строки 4..36. В ячейке может быть несколько ролей
  // через "/" - берём те, что мапятся на 4 стека шаблона, остальное в отчёт.
  const skillsByName = new Map(); // фамилия -> [ключи стеков]
  const skillsRaw = new Map(); // фамилия -> исходная строка
  const droppedSkills = new Map(); // фамилия -> Set неподдержанных ролей
  for (let r = RKK_CONFIG.skillsRowStart; r <= RKK_CONFIG.skillsRowEnd; r++) {
    const name = get(r, RKK_CONFIG.skillsNameCol);
    const stackText = get(r, RKK_CONFIG.skillsStackCol);
    if (typeof name !== 'string' || name.trim() === '') continue;
    const parts = String(stackText || '').split('/').map((p) => normalizeSkill(p)).filter(Boolean);
    const mapped = [];
    const dropped = new Set();
    for (const p of parts) {
      const key = normalizeStackKey(p);
      if (key) {
        if (!mapped.includes(key)) mapped.push(key);
      } else {
        dropped.add(p);
      }
    }
    const surname = surnameOf(name);
    skillsByName.set(surname, mapped);
    skillsRaw.set(surname, String(stackText || '').trim());
    if (dropped.size) droppedSkills.set(surname, dropped);
  }

  // Задачи: строки 60..97
  const tasks = [];
  const report = { skipped: [], noHours: [], unknownExecutor: [], unmapped: [], multiSkill: [], droppedSkills: [], notBeforeDefault: [], planDates: { count: 0, missing: [] }, executorCols: executorCols.length };
  const multiSkillSeen = new Map(); // "исполнитель|стек" -> {count, entry}

  let lastFilledRow = 0;
  for (let r = RKK_CONFIG.taskRowStart; r <= RKK_CONFIG.taskRowEnd; r++) {
    const rawName = get(r, RKK_CONFIG.nameCol);
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name === '') {
      report.skipped.push({ row: r, reason: 'пустая строка' });
      continue;
    }
    lastFilledRow = r;
    if (!/ТТ\s*\d+/i.test(name)) {
      report.skipped.push({ row: r, name, reason: 'не задача (разделитель)' });
      continue;
    }
    const priority = num(get(r, RKK_CONFIG.priorityCol));
    // Готовность ТТ: дата из колонки E. Пусто или текст («не готово») - задача
    // уезжает минимум на неделю вправо от сегодняшнего дня.
    const planStart = excelDateValue(get(r, RKK_CONFIG.startCol));
    const planFinish = excelDateValue(get(r, RKK_CONFIG.finishCol));
    const readyRaw = get(r, RKK_CONFIG.readyCol);
    const readyDate = excelDateValue(readyRaw);
    const notBefore = readyDate || addDaysUtc(todayUtc(), RKK_CONFIG.defaultDelayDays);
    if (!readyDate) {
      report.notBeforeDefault.push({
        row: r,
        name,
        ready: readyRaw === null || readyRaw === undefined || readyRaw === '' ? 'пусто' : String(readyRaw),
        notBefore: isoDay(notBefore)
      });
    }

    const people = [];
    for (const { col, surname } of executorCols) {
      const hours = num(get(r, col));
      if (hours === null || hours <= 0) continue;
      if (!skillsByName.has(surname)) {
        report.unknownExecutor.push({ row: r, name, executor: surname });
        continue;
      }
      const skills = skillsByName.get(surname);
      if (!skills.length) {
        report.unmapped.push({ row: r, name, executor: surname, skills: skillsRaw.get(surname) || '', hours });
        continue;
      }
      people.push({ executor: surname, hours, skills });
    }

    const assignments = assignStacks(people);
    for (const a of assignments) {
      if (a.skills.length <= 1) continue;
      const key = `${a.executor}|${a.stack}`;
      const seen = multiSkillSeen.get(key);
      if (seen) seen.count++;
      else {
        const entry = {
          executor: a.executor,
          skills: skillsRaw.get(a.executor) || '',
          chosen: a.stack,
          reason: a.reason,
          count: 1
        };
        multiSkillSeen.set(key, entry);
        report.multiSkill.push(entry);
      }
    }

    if (!assignments.length) report.noHours.push({ row: r, name });
    if (planStart || planFinish) report.planDates.count++;
    else report.planDates.missing.push({ row: r, name });
    tasks.push({ row: r, name, priority, assignments, notBefore, planStart, planFinish });
  }

  // Пустые строки в хвосте диапазона (60-97) - это просто незаполненный
  // остаток листа, о них в отчёте не пишем; пустая строка в середине - сигнал.
  report.skipped = report.skipped.filter((s) => s.reason !== 'пустая строка' || s.row < lastFilledRow);

  report.droppedSkills = [...droppedSkills].map(([executor, set]) => ({
    executor,
    skills: skillsRaw.get(executor) || '',
    dropped: [...set].sort().join(', ')
  }));

  return { tasks, report };
}

/**
 * Распределение людей задачи по стекам.
 *
 * Если на задаче есть человек с одним стеком ("моно") и человек с несколькими,
 * мультистековый берёт тот стек, который моно-исполнитель делать не может -
 * иначе один и тот же стек делали бы двое, а второй стек остался бы без
 * исполнителя. Порядок предпочтений: стек, не покрытый ни одним моно; затем
 * стек, ещё никем не занятый; иначе - первый из своих.
 */
function assignStacks(people) {
  const mono = people.filter((p) => p.skills.length === 1);
  const multi = people.filter((p) => p.skills.length > 1);
  const monoStacks = new Set(mono.map((p) => p.skills[0]));
  const taken = new Set();
  const out = [];

  for (const p of mono) {
    out.push({ executor: p.executor, hours: p.hours, stack: p.skills[0], skills: p.skills, reason: 'единственный стек' });
    taken.add(p.skills[0]);
  }

  for (const p of multi) {
    // Приоритет выбора: свободный и не занятый моно-исполнителем стек, затем
    // просто не занятый моно, затем свободный, иначе - первый из своих.
    let chosen = p.skills[0];
    let bestScore = -1;
    for (const sk of p.skills) {
      const score = (monoStacks.has(sk) ? 0 : 2) + (taken.has(sk) ? 0 : 1);
      if (score > bestScore) {
        bestScore = score;
        chosen = sk;
      }
    }
    out.push({ executor: p.executor, hours: p.hours, stack: chosen, skills: p.skills, reason: stackReason(chosen, monoStacks, taken) });
    taken.add(chosen);
  }
  return out;
}

function stackReason(stack, monoStacks, taken) {
  const monoCovered = monoStacks.has(stack);
  const busy = taken.has(stack);
  if (!monoCovered && !busy) return 'стек не занят моно-исполнителем';
  if (!monoCovered && busy) return 'стек не занят моно-исполнителем (все свободные уже разобраны)';
  return 'все стеки заняты, взят первый';
}

/** Задачи РКК -> строки листа Шаблона (A..Q + доп. тройки). */
function buildTemplateRows(tasks) {
  const rows = [];
  const stackIndex = new Map(CONVERTER_STACKS.map((s, i) => [s.key, i]));
  let maxExtra = 0;

  tasks.forEach((task, n) => {
    const row = new Array(18).fill(null);
    row[0] = n + 1;
    row[1] = task.priority; // может быть null - Гант поставит низший приоритет
    row[2] = task.name;
    row[4] = task.planStart || null;
    row[5] = task.planFinish || null;
    row[17] = task.notBefore || null; // «Не раньше»: готовность ТТ
    // даты плана: базовое начало/окончание из РКК (F/G)

    // один стек -> один блок; повтор стека -> доп. тройка
    const byStack = new Map(); // key -> [{executor, hours}]
    for (const a of task.assignments) {
      const list = byStack.get(a.stack) || [];
      list.push(a);
      byStack.set(a.stack, list);
    }
    const extras = [];
    for (const stack of CONVERTER_STACKS) {
      const list = byStack.get(stack.key);
      if (!list || !list.length) continue;
      const [main, ...rest] = list;
      const base = 9 + stackIndex.get(stack.key) * 2; // J/K, L/M, N/O, P/Q
      row[base] = main.hours;
      row[base + 1] = main.executor;
      for (const r of rest) extras.push({ stack: stack.label, hours: r.hours, executor: r.executor });
    }
    maxExtra = Math.max(maxExtra, extras.length);
    for (const e of extras) row.push(e.stack, e.hours, e.executor);
    rows.push(row);
  });

  return { rows, maxExtra };
}

/** Полный разбор файла РКК: возвращает AOA листа Шаблона и отчёт. */
function convertRkkToTemplate(data) {
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames.includes(RKK_CONFIG.sheetName) ? RKK_CONFIG.sheetName : wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const { tasks, report } = parseRkkSheet(sheet);
  if (!report.executorCols && !tasks.length) {
    throw new Error(
      'Не похоже на лист РКК: в строке 48 (колонки AG–AY) нет исполнителей и в строках 60–97 нет задач с «ТТ»'
    );
  }
  const { rows, maxExtra } = buildTemplateRows(tasks);

  const header = TEMPLATE_HEADER.slice();
  header.push(NOT_BEFORE_HEADER_LABEL);
  for (let i = 0; i < maxExtra; i++) header.push(...EXTRA_HEADER);
  const aoa = [header, ...rows];

  return { aoa, tasks, report, sheetName, maxExtra };
}

/** AOA -> книга xlsx (готовый ArrayBuffer). */
function aoaToWorkbookBuffer(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Задачи');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

if (typeof window !== 'undefined') {
  window.__converter = {
    RKK_CONFIG,
    STACK_ALIASES,
    normalizeStackKey,
    CONVERTER_STACKS,
    TEMPLATE_HEADER,
    NOT_BEFORE_HEADER_LABEL,
    excelDateValue,
    parseRkkSheet,
    assignStacks,
    stackReason,
    buildTemplateRows,
    convertRkkToTemplate,
    aoaToWorkbookBuffer
  };
}
