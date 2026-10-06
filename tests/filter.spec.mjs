import { test, expect } from '@playwright/test';
import { loadFixture, schedule } from './helpers.mjs';

test.describe('фильтр по исполнителю и названию', () => {
  test('по умолчанию показаны все задачи', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await expect(page.locator('.row')).toHaveCount(3);
    await expect(page.locator('[data-testid=filter-count]')).toHaveText('');
    await expect(page.locator('[data-testid=filter-reset]')).toBeDisabled();
  });

  test('фильтр по исполнителю оставляет только его задачи', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.selectOption('[data-testid=filter-executor]', 'Соколов'); // только Питон задачи 1
    await expect(page.locator('.row')).toHaveCount(1);
    await expect(page.locator('[data-testid=row-1]')).toBeVisible();
    await expect(page.locator('[data-testid=filter-count]')).toHaveText('Показано 1 из 3');

    // Морозов делает Дотнет в задачах 1 и 3
    await page.selectOption('[data-testid=filter-executor]', 'Морозов');
    await expect(page.locator('.row')).toHaveCount(2);
    await expect(page.locator('[data-testid=filter-count]')).toHaveText('Показано 2 из 3');
  });

  test('расписание не пересчитывается при фильтрации', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const before = await schedule(page);
    await page.selectOption('[data-testid=filter-executor]', 'Соколов');
    await expect(page.locator('.row')).toHaveCount(1);
    const after = await schedule(page);
    expect(after.tasks.map((t) => [t.num, t.start, t.finish])).toEqual(before.tasks.map((t) => [t.num, t.start, t.finish]));
  });

  test('поиск по части названия, регистр не важен', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.fill('[data-testid=filter-query]', 'РАСЧЁТ');
    await expect(page.locator('.row')).toHaveCount(1);
    await expect(page.locator('[data-testid=row-1]')).toBeVisible();

    await page.fill('[data-testid=filter-query]', 'тт 100002');
    await expect(page.locator('.row')).toHaveCount(1); // только ТТ 100002
  });

  test('фильтры складываются: исполнитель и название', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.selectOption('[data-testid=filter-executor]', 'Морозов');
    await expect(page.locator('.row')).toHaveCount(2);
    await page.fill('[data-testid=filter-query]', '100003');
    await expect(page.locator('.row')).toHaveCount(1);
    await expect(page.locator('[data-testid=row-3]')).toBeVisible();
  });

  test('пустой результат объясняется, а не молчит', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.fill('[data-testid=filter-query]', 'ничего-такого-нет');
    await expect(page.locator('[data-testid=filter-empty]')).toBeVisible();
    await expect(page.locator('.row')).toHaveCount(0);
    await expect(page.locator('[data-testid=filter-count]')).toHaveText('Показано 0 из 3');
  });

  test('сброс возвращает все задачи и очищает поля', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.fill('[data-testid=filter-query]', 'ТТ');
    await page.selectOption('[data-testid=filter-executor]', 'Соколов');
    await expect(page.locator('.row')).toHaveCount(1);
    await page.click('[data-testid=filter-reset]');
    await expect(page.locator('.row')).toHaveCount(3);
    await expect(page.locator('[data-testid=filter-query]')).toHaveValue('');
    await expect(page.locator('[data-testid=filter-executor]')).toHaveValue('');
    await expect(page.locator('[data-testid=filter-count]')).toHaveText('');
  });

  test('фильтр сохраняется при смене масштаба', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.selectOption('[data-testid=filter-executor]', 'Соколов');
    await page.click('[data-testid=zoom-day]');
    await expect(page.locator('.row')).toHaveCount(1);
    await page.click('[data-testid=zoom-month]');
    await expect(page.locator('.row')).toHaveCount(1);
  });

  test('таблица уважает фильтр', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.check('[data-testid=toggle-table]');
    await expect(page.locator('[data-testid=table-view] tbody tr')).toHaveCount(3);
    await page.selectOption('[data-testid=filter-executor]', 'Волкова');
    await expect(page.locator('[data-testid=table-view] tbody tr')).toHaveCount(3);
    await page.fill('[data-testid=filter-query]', '100002');
    await expect(page.locator('[data-testid=table-view] tbody tr')).toHaveCount(1);
  });

  test('клик по предупреждению снимает фильтр и показывает задачу', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    await page.fill('[data-testid=filter-query]', 'Нулевая фаза'); // оставляем только задачу 1
    await expect(page.locator('.row')).toHaveCount(1);
    // предупреждение относится к задаче 7, она скрыта фильтром
    await page.locator('[data-testid=alert-over-plan]').first().click();
    await expect(page.locator('[data-testid=filter-query]')).toHaveValue('');
    await expect(page.locator('[data-testid=row-7]')).toHaveClass(/selected/);
  });

  test('список исполнителей берётся из файла', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const options = await page.$$eval('[data-testid=filter-executor] option', (os) => os.map((o) => o.value));
    expect(options[0]).toBe(''); // «все»
    expect(options).toContain('Орлов');
    expect(options).toContain('Волкова');
    expect(new Set(options).size).toBe(options.length);
  });

  test('слэш переводит фокус в поиск', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.keyboard.press('/');
    const focused = await page.evaluate(() => document.activeElement.id);
    expect(focused).toBe('filter-query');
  });
});
