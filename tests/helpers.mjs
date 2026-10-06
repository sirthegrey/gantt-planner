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
export function writeAoaToTempFile(aoa) {
  const ws = xlsx.utils.aoa_to_sheet(aoa, { cellDates: true });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Задачи');
  const dir = mkdtempSync(join(tmpdir(), 'gantt-aoa-'));
  const file = join(dir, 'Шаблон.xlsx');
  // cellDates: true - так же, как в make-fixtures, чтобы фикстуры и
  // генерируемые на лету файлы писались одинаково.
  xlsx.writeFile(wb, file, { cellDates: true });
  return file;
}
