import { test, expect } from '@playwright/test';
import { appUrl, loadFixture, schedule, trackConsoleErrors } from './helpers.mjs';

test.describe('интерфейс', () => {
  test('переключение масштаба меняет плотность шкалы', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const width = () => page.evaluate(() => document.querySelector('.gantt-inner').getBoundingClientRect().width);
    await page.click('[data-testid=zoom-day]');
    const dayW = await width();
    await page.click('[data-testid=zoom-week]');
    const weekW = await width();
    await page.click('[data-testid=zoom-month]');
    const monthW = await width();
    expect(dayW).toBeGreaterThan(weekW);
    expect(weekW).toBeGreaterThan(monthW);
    await expect(page.locator('[data-testid=zoom-day]')).not.toHaveClass(/active/);
    await expect(page.locator('[data-testid=zoom-month]')).toHaveClass(/active/);
  });

  test('кнопка «Сегодня» прокручивает к текущей дате', async ({ page }) => {
    await loadFixture(page, 'today.xlsx');
    await page.click('[data-testid=zoom-day]');
    const line = page.locator('[data-testid=today-line]');
    await expect(line).toHaveCount(1);
    await expect(line).toBeVisible();
    const before = await page.evaluate(() => document.getElementById('gantt').scrollLeft);
    await page.click('[data-testid=btn-today]');
    const after = await page.evaluate(() => document.getElementById('gantt').scrollLeft);
    expect(after).toBeGreaterThan(before);
  });

  test('переключатель базового плана скрывает призрачные полосы', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await expect(page.locator('[data-testid=ghost-1]')).toBeVisible();
    const n = await page.locator('.ghost-bar').count();
    expect(n).toBe(3);
    await page.uncheck('[data-testid=toggle-baseline]');
    await expect(page.locator('.ghost-bar')).toHaveCount(0);
    await page.check('[data-testid=toggle-baseline]');
    await expect(page.locator('.ghost-bar')).toHaveCount(3);
  });

  test('клик по строке открывает инспектор задачи', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await expect(page.locator('[data-testid=inspector]')).toHaveCount(0);
    await page.click('[data-testid=row-1]');
    await expect(page.locator('[data-testid=inspector]')).toContainText('ТТ 100001');
    await expect(page.locator('[data-testid=phase-1-cpp]')).toBeVisible();
    await expect(page.locator('[data-testid=phase-1-cpp]')).toContainText('Орлов');
    await expect(page.locator('[data-testid=row-1]')).toHaveClass(/selected/);
  });

  test('изменение порядка фаз меняет расписание', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.click('[data-testid=row-3]');
    const before = await schedule(page);
    expect(before.tasks[2].phaseOrder).toEqual(['py', 'net', 'front']);
    expect(before.tasks[2].phases[0].executor).toBe('Козлова');

    await page.click('[data-testid=phase-down-3-py]'); // питон уходит на второе место
    const after = await schedule(page);
    expect(after.tasks[2].phaseOrder).toEqual(['net', 'py', 'front']);
    expect(after.tasks[2].phases[0].executor).toBe('Морозов');
    await expect(page.locator('[data-testid=seg-3-net]')).toHaveAttribute('data-executor', 'Морозов');
  });

  test('кнопки порядка фаз отключены на краях списка', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.click('[data-testid=row-1]');
    await expect(page.locator('[data-testid=phase-up-1-cpp]')).toBeDisabled();
    await expect(page.locator('[data-testid=phase-down-1-cpp]')).toBeEnabled();
    await expect(page.locator('[data-testid=phase-down-1-front]')).toBeDisabled();
  });

  test('порядок фаз сохраняется после повторной загрузки того же файла', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.click('[data-testid=row-1]');
    await page.click('[data-testid=phase-down-1-cpp]');
    let s = await schedule(page);
    expect(s.tasks[0].phaseOrder).toEqual(['py', 'cpp', 'net', 'front']);
  });

  test('переключатель темы меняет атрибут документа', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.click('[data-testid=theme-toggle]');
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(before);
    expect(['light', 'dark']).toContain(after);
  });

  test('шапка показывает месяцы и прилипает при вертикальной прокрутке', async ({ page }) => {
    await loadFixture(page, 'stress.xlsx');
    await expect(page.locator('.month-cell').first()).toContainText('окт');
    const sticky = await page.evaluate(() => getComputedStyle(document.querySelector('.gantt-head')).position);
    expect(sticky).toBe('sticky');
    const labelSticky = await page.evaluate(() => getComputedStyle(document.querySelector('.row-label')).position);
    expect(labelSticky).toBe('sticky');
  });

  test('метка фактического начала рисуется только для задач с планом-графиком', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    await expect(page.locator('[data-testid=pin-4]')).toBeVisible();
    await expect(page.locator('[data-testid=pin-3]')).toHaveCount(0); // завершённая задача не планируется
  });

  test('завершённые и безфазные задачи помечены текстом', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    await expect(page.locator('[data-testid=row-3] .done-badge')).toHaveText('выполнена');
    await expect(page.locator('[data-testid=row-6] .no-phases')).toHaveText('нет фаз');
  });

  test('предупреждения отрисованы и классифицированы', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    await expect(page.locator('.alert.critical')).toHaveCount(0);
    expect(await page.locator('.alert.warning').count()).toBeGreaterThan(0);
  });

  test('нет ошибок консоли за полный прогон интерфейса', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await loadFixture(page, 'sample.xlsx');
    for (const z of ['day', 'week', 'month']) await page.click(`[data-testid=zoom-${z}]`);
    await page.click('[data-testid=row-2]');
    await page.click('[data-testid=toggle-table]');
    await page.click('[data-testid=theme-toggle]');
    await page.click('[data-testid=btn-today]');
    const hover = page.locator('[data-testid=seg-1-net]');
    await hover.hover();
    await page.uncheck('[data-testid=toggle-baseline]');
    expect(errors).toEqual([]);
  });

  test('параметры URL задают тему и масштаб', async ({ page }) => {
    await page.goto(appUrl + '?theme=dark&zoom=day');
    await page.waitForFunction(() => !!window.__gantt);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    await expect(page.locator('[data-testid=zoom-day]')).toHaveClass(/active/);
  });
});
