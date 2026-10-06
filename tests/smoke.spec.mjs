import { test, expect } from '@playwright/test';
import { appUrl, fixture, loadFixture, schedule, fileBase64, trackConsoleErrors } from './helpers.mjs';

test.describe('страница и загрузка файла', () => {
  test('приложение загружается без ошибок консоли', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto(appUrl);
    await expect(page.locator('.brand')).toHaveText('Гант');
    await expect(page.locator('[data-testid=legend]')).toBeVisible();
    await expect(page.locator('[data-testid=alerts]')).toBeVisible();
    await expect(page.locator('[data-testid=stats]')).toContainText('Файл не загружен');
    expect(errors).toEqual([]);
  });

  test('загрузка sample.xlsx рисует строки, полосы и метрики', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await loadFixture(page, 'sample.xlsx');
    await expect(page.locator('.row')).toHaveCount(3);
    await expect(page.locator('[data-testid=bar-1]')).toBeVisible();
    await expect(page.locator('[data-testid=bar-2]')).toBeVisible();
    await expect(page.locator('[data-testid=bar-3]')).toBeVisible();
    await expect(page.locator('[data-testid=stats]')).toContainText('Задач: 3');
    expect(errors).toEqual([]);
  });

  test('каждая фаза даёт отдельный сегмент полосы с исполнителем', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await expect(page.locator('[data-testid=seg-1-cpp]')).toHaveAttribute('data-executor', 'Орлов');
    await expect(page.locator('[data-testid=seg-1-py]')).toHaveAttribute('data-executor', 'Соколов');
    await expect(page.locator('[data-testid=seg-1-net]')).toHaveAttribute('data-executor', 'Морозов');
    await expect(page.locator('[data-testid=seg-1-front]')).toHaveAttribute('data-executor', 'Волкова');
    // задача 3 не имеет фазы C++ (0 часов) - сегмента быть не должно
    await expect(page.locator('[data-testid=seg-3-cpp]')).toHaveCount(0);
    await expect(page.locator('[data-testid=seg-3-py]')).toBeVisible();
  });

  test('сегменты полосы идут в порядке фаз и без наложения внутри дорожки', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const lanes = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('[data-testid=row-1] .bar')];
      return bars.map((bar) => [...bar.querySelectorAll('.seg')]
        .sort((a, b) => a.offsetLeft - b.offsetLeft)
        .map((s) => ({ left: s.offsetLeft, width: s.offsetWidth, stack: s.dataset.stack })));
    });
    // Дорожки меняют порядок в DOM (параллельный Питон уезжает во вторую),
    // поэтому сверяем состав; порядок выполнения проверяется по расписанию.
    const all = lanes.flat().map((b) => b.stack).sort();
    expect(all).toEqual(['cpp', 'front', 'net', 'py']);
    for (const lane of lanes) {
      for (let i = 1; i < lane.length; i++) {
        expect(lane[i].left).toBeGreaterThanOrEqual(lane[i - 1].left + lane[i - 1].width);
      }
    }
  });

  test('тултип появляется при наведении на сегмент', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.locator('[data-testid=seg-1-py]').hover();
    const tip = page.locator('[data-testid=tooltip]');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Питон');
    await expect(tip).toContainText('Соколов');
    await expect(tip).toContainText('90 ч');
  });

  test('табличный вид показывает расчётные даты (текстовая альтернатива)', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.locator('[data-testid=toggle-table]').check();
    await expect(page.locator('[data-testid=table-view]')).toBeVisible();
    await expect(page.locator('[data-testid=table-row-1]')).toBeVisible();
    const row = page.locator('[data-testid=table-row-1]');
    await expect(row).toContainText('Орлов');
    await expect(row).toContainText('ТТ 100001');
  });

  test('drag & drop файла загружает проект', async ({ page }) => {
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    const b64 = fileBase64('sample.xlsx');
    await page.evaluate(async (data) => {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'dropped.xlsx');
      const dt = new DataTransfer();
      dt.items.add(file);
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await page.waitForSelector('.row');
    await expect(page.locator('.row')).toHaveCount(3);
  });

  test('пустой файл не ломает приложение', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto(appUrl);
    await page.setInputFiles('[data-testid=file-input]', fixture('empty.xlsx'));
    await expect(page.locator('[data-testid=stats]')).toContainText('Задач: 0');
    await expect(page.locator('.row')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('повторная загрузка заменяет проект', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await expect(page.locator('.row')).toHaveCount(3);
    await page.setInputFiles('[data-testid=file-input]', fixture('conflicts.xlsx'));
    await expect(page.locator('.row')).toHaveCount(3);
    const s = await schedule(page);
    expect(s.tasks.map((t) => t.name)).toEqual(['Задача A', 'Задача B', 'Задача C']);
  });
});
