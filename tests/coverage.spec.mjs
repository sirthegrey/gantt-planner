import { test, expect } from '@playwright/test';
import { appUrl, fixture } from './helpers.mjs';

// The app sources are inlined into dist/Gantt.html with a `//# sourceURL=gantt-app.js`
// marker, so Chromium's V8 coverage reports them as a separate script that can be
// measured independently of the bundled SheetJS vendor code.
test('покрытие кода приложения при сквозном сценарии', async ({ page }) => {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto(appUrl);
  await page.waitForFunction(() => !!window.__gantt);
  await page.setInputFiles('[data-testid=file-input]', fixture('sample.xlsx'));
  await page.waitForSelector('.row');

  // exercise every branch of the UI
  for (const z of ['day', 'week', 'month']) await page.click(`[data-testid=zoom-${z}]`);
  await page.click('[data-testid=row-1]');
  await page.click('[data-testid=phase-down-1-py]');
  await page.click('[data-testid=phase-up-1-py]');
  await page.click('[data-testid=theme-toggle]');
  await page.click('[data-testid=toggle-table]');
  await page.uncheck('[data-testid=toggle-baseline]');
  await page.check('[data-testid=toggle-baseline]');
  await page.fill('[data-testid=holiday-date]', '2026-12-31');
  await page.click('[data-testid=holiday-add]');
  await page.click('[data-testid="holiday-del-2026-12-31"]');
  await page.click('[data-testid=btn-reset-holidays]');
  await page.click('[data-testid=btn-today]');
  await page.hover('[data-testid=seg-1-py]');
  await page.setInputFiles('[data-testid=file-input]', fixture('empty.xlsx'));
  await page.setInputFiles('[data-testid=file-input]', fixture('edge.xlsx'));
  await page.setInputFiles('[data-testid=file-input]', fixture('stress.xlsx'));

  // absences panel and the remaining fixtures
  await page.setInputFiles('[data-testid=file-input]', fixture('absences.xlsx'));
  await page.selectOption('[data-testid=absence-executor]', 'Иванов');
  await page.fill('[data-testid=absence-from]', '2026-11-10');
  await page.fill('[data-testid=absence-to]', '2026-11-12');
  await page.click('[data-testid=absence-add]');
  await page.click('[data-testid=absence-del-0]');
  await page.click('[data-testid=absence-add]');
  await page.click('[data-testid=btn-reset-absences]');
  await page.setInputFiles('[data-testid=file-input]', fixture('ratio.xlsx'));
  await page.setInputFiles('[data-testid=file-input]', fixture('priority.xlsx'));
  await page.setInputFiles('[data-testid=file-input]', fixture('holidays.xlsx'));
  await page.click('[data-testid=toggle-respect-baseline]');
  await page.setInputFiles('[data-testid=file-input]', fixture('template-wide.xlsx'));
  await page.locator('.row').first().click(); // номера в живом файле могут повторяться
  await page.click('[data-testid=toggle-table]');

  const coverage = await page.coverage.stopJSCoverage();
  const entry = coverage.find((c) => c.url.includes('gantt-app'));
  expect(entry, 'покрытие скрипта приложения найдено').toBeTruthy();

  const merge = (intervals) => {
    const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of sorted) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const size = (intervals) => intervals.reduce((s, [a, b]) => s + (b - a), 0);

  // Precise byte coverage: a byte is covered when its innermost range has
  // count > 0. Ranges with count == 0 nested inside an executed range (an
  // untaken branch, a catch body) must therefore be subtracted back out.
  const all = [];
  const hit = [];
  const missed = [];
  for (const fn of entry.functions) {
    if (!fn.ranges.length) continue;
    all.push([fn.ranges[0].startOffset, fn.ranges[0].endOffset]);
    for (const r of fn.ranges) {
      if (r.count > 0) hit.push([r.startOffset, r.endOffset]);
      else if (r.startOffset !== fn.ranges[0].startOffset) missed.push([r.startOffset, r.endOffset]);
    }
  }
  const subtract = (base, remove) => {
    let out = base;
    for (const [ra, rb] of merge(remove)) {
      const next = [];
      for (const [a, b] of out) {
        if (rb <= a || ra >= b) { next.push([a, b]); continue; }
        if (ra > a) next.push([a, ra]);
        if (rb < b) next.push([rb, b]);
      }
      out = next;
    }
    return out;
  };
  const total = size(merge(all));
  const used = size(subtract(merge(hit), missed));
  const pct = (used / total) * 100;
  console.log(`покрытие gantt-app.js: ${pct.toFixed(1)}% (${used}/${total} байт)`);
  expect(pct).toBeGreaterThan(85);
});
