import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import xlsx from 'xlsx';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..');
export const appUrl = pathToFileURL(join(root, 'dist/Gantt.html')).href;
export const fixture = (name) => join(root, 'tests/fixtures', name);

/** Navigate to the app and load a fixture through the file input. */
export async function loadFixture(page, name) {
  await page.goto(appUrl);
  await page.waitForFunction(() => !!window.__gantt);
  await page.setInputFiles('[data-testid=file-input]', fixture(name));
  await page.waitForFunction(() => !!window.__gantt.state.sched);
  await page.waitForSelector('.row');
}

/** Turn baseline-as-floor scheduling on or off (default off = as soon as possible). */
export async function setRespectBaseline(page, on) {
  const box = page.locator('[data-testid=toggle-respect-baseline]');
  if (on) await box.check();
  else await box.uncheck();
  await page.waitForFunction((v) => window.__gantt.state.respectBaseline === v, on);
  await page.waitForSelector('.row');
}

/** Serialized schedule for assertions. */
export function schedule(page) {
  return page.evaluate(() => {
    const s = window.__gantt.state.sched;
    return {
      projectStart: s.projectStartDate ? s.projectStartDate.toISOString().slice(0, 10) : null,
      tasks: s.tasks.map((t) => ({
        num: t.num,
        priority: t.priority,
        name: t.name,
        scheduled: t.scheduled,
        done: !!t.done,
        pinned: !!t.pinned,
        durationDays: t.durationDays,
        span: t.computedSpanDays,
        start: t.computedStart ? t.computedStart.toISOString().slice(0, 10) : null,
        finish: t.computedFinish ? t.computedFinish.toISOString().slice(0, 10) : null,
        startPos: t.computedStartPos,
        finishPos: t.computedFinishPos,
        phaseOrder: t.phases.map((p) => p.stack),
        phases: t.phases.map((p) => ({
          stack: p.stack,
          executor: p.executor,
          hours: p.hours,
          startPos: p.startPos,
          endPos: p.endPos,
          start: p.startPos != null ? window.__gantt.state.cal.dateOf(p.startPos).toISOString().slice(0, 10) : null,
          finish: p.endPos != null ? window.__gantt.state.cal.finishDateOf(p.endPos).toISOString().slice(0, 10) : null
        }))
      })),
      warnings: window.__gantt.state.warnings.map((w) => w.kind + ': ' + w.message),
      load: Array.from(window.__gantt.executorLoad(s), ([name, info]) => ({ name, peak: info.peak, tasks: info.tasks, hours: info.hours }))
    };
  });
}

/** Console errors collected on a page. */
export function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

export function fileBase64(name) {
  return readFileSync(fixture(name)).toString('base64');
}

/** Есть ли локальный (не публикуемый) файл пользователя в tests/fixtures/local. */
export function hasLocal(name) {
  return existsSync(join(root, 'tests/fixtures/local', name));
}


/* ------------------------------------------------------------------ данные
 * Конструкторы тестовых данных: собирают AOA нужного формата из компактного
 * описания, чтобы каждый класс эквивалентности описывался одной строкой.
 */

/** Заголовок листа Шаблона (17 колонок). */
export const TEMPLATE_HEADER = ['Номер', 'Приоритет', 'Название', 'Общая длительность, дн',
  'Начало базовое', 'Окончание базовое', 'Начало фактическое', 'Окончание фактическое',
  'Оценка SP', 'C++, ч', 'Исполнитель C++', 'Питон, ч', 'Исполнитель питон',
  'Дотнет, ч', 'Исполнитель дотнет', 'Фронт, ч', 'Исполнитель фронт'];

/** Заголовок шаблона: с колонкой «Не раньше» и/или тройками доп. фаз. */
export function templateHeaderWith({ notBefore = true, extras = 0 } = {}) {
  const head = [...TEMPLATE_HEADER];
  if (notBefore) head.push('Не раньше');
  for (let i = 0; i < extras; i++) head.push('Стек (доп.)', 'Часы (доп.)', 'Исполнитель (доп.)');
  return head;
}

/** Строка шаблона: заполняем только то, что относится к проверяемому классу. */
export function templateRow(opts = {}) {
  const {
    num = null, priority = null, name = 'ТТ 1: задача', duration = null,
    baseStart = null, baseFinish = null, actualStart = null, actualFinish = null,
    sp = null, phases = {}, extras = [], notBefore = null
  } = opts;
  const row = new Array(18).fill(null);
  row[0] = num; row[1] = priority; row[2] = name; row[3] = duration;
  row[4] = baseStart; row[5] = baseFinish; row[6] = actualStart; row[7] = actualFinish; row[8] = sp;
  const cols = { cpp: [9, 10], py: [11, 12], net: [13, 14], front: [15, 16] };
  for (const [key, [hCol, eCol]] of Object.entries(cols)) {
    const value = phases[key];
    if (value) {
      row[hCol] = value.hours;
      row[eCol] = value.executor;
    }
  }
  row[17] = notBefore;
  for (const e of extras) row.push(e.stack, e.hours, e.executor);
  return row;
}

/**
 * AOA листа РКК. Скиллы: [[строка, ФИО, стек]], исполнители: [[колонка, фамилия]],
 * задачи: [{row, priority, name, ready, from, to, hours: {фамилия: часы}}].
 * Колонки: A приоритет, E готовность ТТ, F дата начала, G дата окончания, H ТТ.
 */
export function rkkAoa({ skills = [], executors = [], tasks = [] } = {}) {
  const rows = [];
  const set = (r, c, v) => {
    while (rows.length < r) rows.push([]);
    const row = rows[r - 1];
    while (row.length < c) row.push(null);
    row[c - 1] = v;
  };
  set(48, 8, 'ТТ');
  for (const [r, name, stack] of skills) {
    if (name !== null && name !== undefined) set(r, 8, name);
    set(r, 9, stack);
  }
  for (const [col, surname] of executors) set(48, col, surname);
  for (const t of tasks) {
    set(t.row, 1, t.priority === undefined ? 1 : t.priority);
    set(t.row, 5, t.ready === undefined ? null : t.ready);
    set(t.row, 6, t.from === undefined ? null : t.from);
    set(t.row, 7, t.to === undefined ? null : t.to);
    set(t.row, 8, t.name);
    for (const [surname, hours] of Object.entries(t.hours || {})) {
      const exec = executors.find(([, s]) => s === surname);
      if (exec) set(t.row, exec[0], hours);
    }
  }
  return rows;
}

/** Загрузить AOA в Гант и вернуть сериализованное расписание. */
export async function loadTemplateAoa(page, aoa, { sheetName = 'Задачи', respectBaseline } = {}) {
  const file = writeAoaToTempFile(aoa, sheetName);
  await page.goto(appUrl);
  await page.waitForFunction(() => !!window.__gantt);
  await page.setInputFiles('[data-testid=file-input]', file);
  await page.waitForFunction(() => !!window.__gantt.state.sched);
  if (respectBaseline !== undefined) await setRespectBaseline(page, respectBaseline);
  return schedule(page);
}

/** Загрузить AOA в конвертер и вернуть строки листа Шаблона плюс отчёт. */
export async function convertAoa(page, aoa, { sheetName = '26 4к' } = {}) {
  const file = writeAoaToTempFile(aoa, sheetName);
  const convUrl = pathToFileURL(join(root, 'dist/Конвертер.html')).href;
  await page.goto(convUrl);
  await page.waitForFunction(() => !!window.__converter);
  await page.setInputFiles('[data-testid=conv-file]', file);
  await page.waitForFunction(() => !!window.__convState.result);
  return page.evaluate(() => {
    const r = window.__convState.result;
    const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    const header = r.aoa[0];
    return {
      header,
      rows: r.aoa.slice(1).map((row) => Object.fromEntries(header.map((h, i) => [h, iso(row[i])]))),
      report: r.report,
      maxExtra: r.maxExtra
    };
  });
}

/** Загрузить файл в конвертер, не ожидая успешного разбора (для класса ошибок). */
export async function loadConverterRaw(page, aoa, { sheetName = '26 4к' } = {}) {
  const file = writeAoaToTempFile(aoa, sheetName);
  const convUrl = pathToFileURL(join(root, 'dist/Конвертер.html')).href;
  await page.goto(convUrl);
  await page.waitForFunction(() => !!window.__converter);
  await page.setInputFiles('[data-testid=conv-file]', file);
  await page.waitForTimeout(300);
}

/** Прогнать конвертер на фикстуре РКК и вернуть AOA листа Шаблона. */
export async function convertRkk(page, fixtureName = 'rkk-sample.xlsx') {
  const convUrl = pathToFileURL(join(root, 'dist/Конвертер.html')).href;
  await page.goto(convUrl);
  await page.waitForFunction(() => !!window.__converter);
  await page.setInputFiles('[data-testid=conv-file]', fixture(fixtureName));
  await page.waitForFunction(() => !!window.__convState.result);
  return page.evaluate(() => window.__convState.result.aoa);
}

/** AOA -> временный xlsx-файл на диске. */
export function writeAoaToTempFile(aoa, sheetName = 'Задачи') {
  const ws = xlsx.utils.aoa_to_sheet(aoa, { cellDates: true });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, sheetName);
  const dir = mkdtempSync(join(tmpdir(), 'gantt-aoa-'));
  const file = join(dir, 'Шаблон.xlsx');
  // cellDates: true - так же, как в make-fixtures, чтобы фикстуры и
  // генерируемые на лету файлы писались одинаково.
  xlsx.writeFile(wb, file, { cellDates: true });
  return file;
}
