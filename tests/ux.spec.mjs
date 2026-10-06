import { test, expect } from '@playwright/test';
import { appUrl, loadFixture, schedule } from './helpers.mjs';

// Проверки по эвристикам Нильсена: состояние системы, узнавание, диагностика,
// предотвращение ошибок, свобода действий, гибкость, помощь.

test.describe('видимость состояния', () => {
  test('в строке состояния видно имя загруженного файла', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await expect(page.locator('[data-testid=stats]')).toContainText('sample.xlsx');
    await expect(page.locator('[data-testid=stats]')).toContainText('Задач: 3');
  });

  test('у проверки есть счётчик по уровням', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const summary = page.locator('#alerts-summary');
    await expect(summary).toContainText('ошибок');
    await expect(summary).toContainText('предупреждений');
    await expect(page.locator('[data-testid=alert-group-warning] .badge')).toHaveText(/\d+/);
  });

  test('когда замечаний нет — так и написано', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await expect(page.locator('#alerts-summary')).toContainText('0 ошибок');
  });
});

test.describe('узнавание вместо припоминания и диагностика', () => {
  test('предупреждения сгруппированы по уровню с подписью', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    await expect(page.locator('[data-testid=alert-group-warning]')).toContainText('Предупреждения');
    await expect(page.locator('[data-testid=alert-group-info]')).toContainText('Замечания');
    await expect(page.locator('[data-testid=alert-over-plan]')).toContainText('Перерасход плана');
  });

  test('длинная группа сворачивается в три строки', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const group = page.locator('[data-testid=alert-group-info]');
    const before = await group.locator('.alert').count();
    const expand = page.locator('[data-testid=alert-expand-info]');
    await expect(expand).toBeVisible();
    const badge = Number(await group.locator('.badge').textContent());
    expect(badge).toBeGreaterThan(before);
    await expand.click();
    await expect(group.locator('.alert')).toHaveCount(badge);
    await expect(expand).toHaveCount(0);
  });

  test('клик по предупреждению подсвечивает задачу', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    await page.locator('[data-testid=alert-over-plan]').first().click();
    const sel = await page.evaluate(() => window.__gantt.state.selectedIndex);
    const num = await page.evaluate((i) => window.__gantt.state.sched.tasks[i].num, sel);
    expect(num).toBe(7);
    await expect(page.locator('[data-testid="row-7"]')).toHaveClass(/selected/);
    await expect(page.locator('[data-testid=inspector]')).toContainText('Перерасход плана');
  });
});

test.describe('свобода действий и гибкость', () => {
  test('Esc снимает выбор, повторный Esc ничего не ломает', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.locator('[data-testid=row-1]').click();
    await expect(page.locator('[data-testid=inspector]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid=inspector]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.row')).toHaveCount(3);
  });

  test('карточку задачи можно закрыть кнопкой', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.locator('[data-testid=row-2]').click();
    await page.click('[data-testid=inspector-close]');
    await expect(page.locator('[data-testid=inspector]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__gantt.state.selectedIndex)).toBeNull();
  });

  test('горячие клавиши меняют масштаб', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.keyboard.press('+');
    await expect(page.locator('[data-testid=zoom-day]')).toHaveClass(/active/);
    await page.keyboard.press('-');
    await expect(page.locator('[data-testid=zoom-week]')).toHaveClass(/active/);
    await page.keyboard.press('-');
    await expect(page.locator('[data-testid=zoom-month]')).toHaveClass(/active/);
  });

  test('клавиша T прокручивает к сегодняшнему дню', async ({ page }) => {
    await loadFixture(page, 'today.xlsx');
    const before = await page.evaluate(() => document.getElementById('gantt').scrollLeft);
    await page.keyboard.press('t');
    const after = await page.evaluate(() => document.getElementById('gantt').scrollLeft);
    expect(after).toBeGreaterThan(before);
  });
});

test.describe('помощь', () => {
  test('справка открывается по ? и закрывается Esc и крестиком', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.keyboard.press('?');
    await expect(page.locator('[data-testid=help-dialog]')).toBeVisible();
    await expect(page.locator('[data-testid=help-dialog]')).toContainText('C++ и Питон идут параллельно');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid=help-dialog]')).toBeHidden();
    await page.click('[data-testid=help-open]');
    await expect(page.locator('[data-testid=help-dialog]')).toBeVisible();
    await page.click('[data-testid=help-close]');
    await expect(page.locator('[data-testid=help-dialog]')).toBeHidden();
  });
});

test.describe('предотвращение ошибок', () => {
  test('праздник: формат и повтор проверяются с сообщением', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.fill('[data-testid=holiday-date]', '31.12.2026');
    await page.click('[data-testid=holiday-add]');
    await expect(page.locator('[data-testid=holiday-error]')).toBeVisible();
    await expect(page.locator('[data-testid=holiday-error]')).toContainText('ГГГГ-ММ-ДД');

    await page.fill('[data-testid=holiday-date]', '2026-01-01');
    await page.click('[data-testid=holiday-add]');
    await expect(page.locator('[data-testid=holiday-error]')).toContainText('уже есть');

    await page.fill('[data-testid=holiday-date]', '2026-12-31');
    await page.click('[data-testid=holiday-add]');
    await expect(page.locator('[data-testid=holiday-error]')).toBeHidden();
    await expect(page.locator('[data-testid=holiday-2026-12-31]')).toBeVisible();
  });

  test('отпуск: пустое начало и обратный диапазон отклоняются', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.click('[data-testid=absence-add]');
    await expect(page.locator('[data-testid=absence-error]')).toContainText('начало');

    await page.selectOption('[data-testid=absence-executor]', 'Соколов');
    await page.fill('[data-testid=absence-from]', '2026-11-20');
    await page.fill('[data-testid=absence-to]', '2026-11-01');
    await page.click('[data-testid=absence-add]');
    await expect(page.locator('[data-testid=absence-error]')).toContainText('раньше начала');
    await expect(page.locator('.absence-chip')).toHaveCount(0);
  });

  test('карточка задачи подсказывает, что приоритет 1 — высший', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    await page.locator('[data-testid=row-1]').click();
    await expect(page.locator('[data-testid=inspector]')).toContainText('(высший)');
  });
});

test.describe('минимализм', () => {
  test('панели сворачиваются и помнят состояние', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const panel = page.locator('details[data-panel=calendar]');
    await expect(panel).toHaveAttribute('open', '');
    await panel.locator('summary').click();
    await expect(panel).not.toHaveAttribute('open', '');
    await page.reload();
    await page.waitForFunction(() => !!window.__gantt);
    await expect(page.locator('details[data-panel=calendar]')).not.toHaveAttribute('open', '');
  });
});
