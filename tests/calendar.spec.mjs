import { test, expect } from '@playwright/test';
import { loadFixture, schedule, setRespectBaseline } from './helpers.mjs';

test.describe('производственный календарь', () => {
  test('фазы перескакивают майские праздники', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    await setRespectBaseline(page, true);
    const s = await schedule(page);
    const t1 = s.tasks.find((t) => t.num === 1);
    expect(t1.phases[0].start).toBe('2026-05-08');
    // 2026-05-09 сб, 05-10 вс, 05-11 выходной по календарю
    expect(t1.phases[0].finish).toBe('2026-05-15');
    expect(t1.span).toBe(5);
  });

  test('фазы перескакивают 8 марта', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    await setRespectBaseline(page, true);
    const s = await schedule(page);
    const t2 = s.tasks.find((t) => t.num === 2);
    expect(t2.phases[0].start).toBe('2026-03-06');
    expect(t2.phases[0].finish).toBe('2026-03-10'); // 07-08 выходные, 09 праздник
    expect(t2.span).toBe(2);
  });

  test('ни одна фаза не начинается и не кончается в выходной', async ({ page }) => {
    await loadFixture(page, 'stress.xlsx');
    const check = await page.evaluate(() => {
      const cal = window.__gantt.state.cal;
      const bad = [];
      for (const t of window.__gantt.state.sched.tasks) {
        for (const p of t.phases) {
          if (p.startPos == null) continue;
          const sd = cal.dateOf(p.startPos);
          const fd = cal.finishDateOf(p.endPos);
          if (!cal.isWorkday(sd)) bad.push(`старт ${sd.toISOString()}`);
          if (!cal.isWorkday(fd)) bad.push(`финиш ${fd.toISOString()}`);
        }
      }
      return bad;
    });
    expect(check).toEqual([]);
  });

  test('выходные и праздники заштрихованы на диаграмме', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    const weekends = await page.locator('[data-testid=weekend-shade]').count();
    const holidays = await page.locator('[data-testid=holiday-shade]').count();
    expect(weekends).toBeGreaterThan(0);
    expect(holidays).toBeGreaterThan(0); // 2026-05-11 и 2026-03-09 попадают в диапазон
  });

  test('добавление праздника сдвигает график', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    await setRespectBaseline(page, true);
    const before = await schedule(page);
    expect(before.tasks[0].finish).toBe('2026-05-15');

    await page.fill('[data-testid=holiday-date]', '2026-05-13');
    await page.click('[data-testid=holiday-add]');
    await expect(page.locator('[data-testid=holiday-2026-05-13]')).toBeVisible();

    const after = await schedule(page);
    expect(after.tasks[0].finish).toBe('2026-05-18'); // 13-е исключено, всё сдвинулось
    expect(after.tasks[0].span).toBe(5); // 5 рабочих дней, но на календаре растянулось
    expect(after.tasks[0].phases[0].finish).toBe('2026-05-18');
  });

  test('удаление праздника возвращает график', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    await setRespectBaseline(page, true);
    await page.fill('[data-testid=holiday-date]', '2026-05-13');
    await page.click('[data-testid=holiday-add]');
    expect((await schedule(page)).tasks[0].finish).toBe('2026-05-18');

    await page.click('[data-testid="holiday-del-2026-05-13"]');
    await expect(page.locator('[data-testid=holiday-2026-05-13]')).toHaveCount(0);
    expect((await schedule(page)).tasks[0].finish).toBe('2026-05-15');
  });

  test('сброс к списку РФ восстанавливает стандартные праздники', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    await page.fill('[data-testid=holiday-date]', '2026-05-13');
    await page.click('[data-testid=holiday-add]');
    await page.click('[data-testid=btn-reset-holidays]');
    await expect(page.locator('[data-testid=holiday-2026-05-13]')).toHaveCount(0);
    const defaults = await page.evaluate(() => window.__gantt.DEFAULT_HOLIDAYS.length);
    await expect(page.locator('.holiday-chip')).toHaveCount(defaults);
  });

  test('пикер даты добавляет праздник', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    await page.fill('[data-testid=holiday-pick]', '2026-06-15');
    await expect(page.locator('[data-testid=holiday-2026-06-15]')).toBeVisible();
  });

  test('компонент Calendar: дни недели и праздники', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    const res = await page.evaluate(() => {
      const cal = window.__gantt.Calendar;
      const d = (s) => new Date(s + 'T00:00:00Z');
      return {
        sat: cal.isWorkday(d('2026-11-07')),
        sun: cal.isWorkday(d('2026-11-08')),
        mon: cal.isWorkday(d('2026-11-09')),
        holiday: cal.isWorkday(d('2026-05-11')),
        nonHoliday: cal.isWorkday(d('2026-05-12'))
      };
    });
    expect(res).toEqual({ sat: false, sun: false, mon: true, holiday: false, nonHoliday: true });
  });
});
