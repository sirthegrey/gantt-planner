import { test, expect } from '@playwright/test';
import { appUrl, loadFixture, schedule, setRespectBaseline, convertRkk, writeAoaToTempFile, hasLocal } from './helpers.mjs';

test.describe('правило 3x: одновременная работа у одного исполнителя', () => {
  test('фазы, различающиеся в 3 раза, идут параллельно', async ({ page }) => {
    await loadFixture(page, 'ratio.xlsx');
    const s = await schedule(page);
    const [a, b] = s.tasks;
    expect(a.start).toBe('2026-11-02');
    expect(b.start).toBe('2026-11-02'); // 24ч против 8ч = 3x -> можно
    expect(a.phases[0].endPos).toBeCloseTo(b.phases[0].startPos + 1, 6); // A ровно 1 день
  });

  test('третья малая фаза встаёт после первой малой, а не внахлёст', async ({ page }) => {
    await loadFixture(page, 'ratio.xlsx');
    const s = await schedule(page);
    const c = s.tasks.find((t) => t.num === 3);
    // в первый день заняты A (8ч) и B (24ч) -> две задачи, третья ждёт
    expect(c.start).toBe('2026-11-03');
  });

  test('фазы с разницей меньше 3x не пересекаются', async ({ page }) => {
    await loadFixture(page, 'ratio.xlsx');
    const s = await schedule(page);
    const d = s.tasks.find((t) => t.num === 4); // 20ч
    const e = s.tasks.find((t) => t.num === 5); // 8ч -> 2.5x
    expect(e.phases[0].startPos).toBeGreaterThanOrEqual(d.phases[0].endPos - 1e-9);
    for (const l of s.load) expect(l.peak).toBeLessThanOrEqual(2);
  });

  test('параллельные фазы никогда не нарушают правило (стресс)', async ({ page }) => {
    await loadFixture(page, 'stress.xlsx');
    const violations = await page.evaluate(() => {
      const st = window.__gantt.state;
      const bad = [];
      for (const [executor, intervals] of st.sched.executors) {
        for (let i = 0; i < intervals.length; i++) {
          for (let j = i + 1; j < intervals.length; j++) {
            const a = intervals[i];
            const b = intervals[j];
            if (a.taskNum === b.taskNum) continue;
            const overlap = a.start < b.end - 1e-9 && b.start < a.end - 1e-9;
            if (overlap && !window.__gantt.sizeRatioOk(a.hours, b.hours)) {
              bad.push(`${executor}: ${a.stack}@${a.start} (${a.hours}ч) и ${b.stack}@${b.start} (${b.hours}ч)`);
            }
          }
        }
      }
      return bad;
    });
    expect(violations).toEqual([]);
  });

  test('граница правила: ровно 3x разрешено, 2.9x — нет', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const res = await page.evaluate(() => ({
      exactly3: window.__gantt.sizeRatioOk(24, 8),
      below: window.__gantt.sizeRatioOk(23, 8),
      above: window.__gantt.sizeRatioOk(90, 30),
      zero: window.__gantt.sizeRatioOk(0, 8),
      ratio: window.__gantt.CONCURRENT_SIZE_RATIO
    }));
    expect(res.exactly3).toBe(true);
    expect(res.above).toBe(true);
    expect(res.below).toBe(false);
    expect(res.zero).toBe(false);
    expect(res.ratio).toBe(3);
  });
});

test.describe('отсутствия исполнителей', () => {
  test('без отпуска длинная фаза кончается раньше', async ({ page }) => {
    await loadFixture(page, 'absences.xlsx');
    const s = await schedule(page);
    expect(s.tasks[0].finish).toBe('2026-11-16'); // 10 рабочих дней с 02.11
    expect(s.tasks[1].start).toBe('2026-11-10');
  });

  test('отпуск ставит фазу на паузу и сдвигает окончание', async ({ page }) => {
    await loadFixture(page, 'absences.xlsx');
    await page.selectOption('[data-testid=absence-executor]', 'Иванов');
    await page.fill('[data-testid=absence-from]', '2026-11-10');
    await page.fill('[data-testid=absence-to]', '2026-11-12');
    await page.click('[data-testid=absence-add]');
    await expect(page.locator('[data-testid=absence-0]')).toContainText('Иванов');

    const s = await schedule(page);
    // 10 рабочих дней, из них 3 пропущены -> окончание на 3 дня позже
    expect(s.tasks[0].finish).toBe('2026-11-19');
    expect(s.tasks[0].phases[0].endPos - s.tasks[0].phases[0].startPos).toBeCloseTo(13, 6);
  });

  test('фаза, начатая внутри отпуска, переносится на день выхода', async ({ page }) => {
    await loadFixture(page, 'absences.xlsx');
    await page.selectOption('[data-testid=absence-executor]', 'Петров');
    await page.fill('[data-testid=absence-from]', '2026-11-10');
    await page.fill('[data-testid=absence-to]', '2026-11-12');
    await page.click('[data-testid=absence-add]');

    const s = await schedule(page);
    expect(s.tasks[1].start).toBe('2026-11-13'); // 10-12 в отпуске, выход 13-го
  });

  test('рабочие часы фазы сохраняются при отпуске', async ({ page }) => {
    await loadFixture(page, 'absences.xlsx');
    await page.selectOption('[data-testid=absence-executor]', 'Иванов');
    await page.fill('[data-testid=absence-from]', '2026-11-10');
    await page.fill('[data-testid=absence-to]', '2026-11-12');
    await page.click('[data-testid=absence-add]');
    const info = await page.evaluate(() => {
      const st = window.__gantt.state;
      const cal = st.cal;
      const ph = st.sched.tasks[0].phases[0];
      const blocked = window.__gantt.buildBlockedMap(cal, st.absences).get('Иванов');
      let worked = 0;
      for (let p = Math.ceil(ph.startPos - 1e-9); p < ph.endPos - 1e-9; p++) {
        if (!blocked.has(p)) worked++;
      }
      return { worked, hours: ph.hours };
    });
    expect(info.worked * 8).toBe(info.hours); // ровно 80 отработанных часов
  });

  test('несколько отпусков у одного исполнителя', async ({ page }) => {
    await loadFixture(page, 'absences.xlsx');
    await page.selectOption('[data-testid=absence-executor]', 'Иванов');
    await page.fill('[data-testid=absence-from]', '2026-11-10');
    await page.fill('[data-testid=absence-to]', '2026-11-11');
    await page.click('[data-testid=absence-add]');
    await page.selectOption('[data-testid=absence-executor]', 'Иванов');
    await page.fill('[data-testid=absence-from]', '2026-11-16');
    await page.fill('[data-testid=absence-to]', '2026-11-17');
    await page.click('[data-testid=absence-add]');
    await expect(page.locator('.absence-chip')).toHaveCount(2);

    const s = await schedule(page);
    // 10 рабочих дней + 4 пропущенных = 14 рабочих дней от 02.11
    expect(s.tasks[0].phases[0].endPos - s.tasks[0].phases[0].startPos).toBeCloseTo(14, 6);
  });

  test('удаление отпуска возвращает исходный срок', async ({ page }) => {
    await loadFixture(page, 'absences.xlsx');
    await page.selectOption('[data-testid=absence-executor]', 'Иванов');
    await page.fill('[data-testid=absence-from]', '2026-11-10');
    await page.fill('[data-testid=absence-to]', '2026-11-12');
    await page.click('[data-testid=absence-add]');
    expect((await schedule(page)).tasks[0].finish).toBe('2026-11-19');
    await page.click('[data-testid=absence-del-0]');
    await expect(page.locator('.absence-chip')).toHaveCount(0);
    expect((await schedule(page)).tasks[0].finish).toBe('2026-11-16');
  });

  test('отпуск по выходным дням ничего не меняет', async ({ page }) => {
    await loadFixture(page, 'absences.xlsx');
    await page.selectOption('[data-testid=absence-executor]', 'Иванов');
    await page.fill('[data-testid=absence-from]', '2026-11-14'); // сб
    await page.fill('[data-testid=absence-to]', '2026-11-15'); // вс
    await page.click('[data-testid=absence-add]');
    expect((await schedule(page)).tasks[0].finish).toBe('2026-11-16');
  });

  test('кнопка очистки убирает все отпуска', async ({ page }) => {
    await loadFixture(page, 'absences.xlsx');
    await page.selectOption('[data-testid=absence-executor]', 'Иванов');
    await page.fill('[data-testid=absence-from]', '2026-11-10');
    await page.fill('[data-testid=absence-to]', '2026-11-12');
    await page.click('[data-testid=absence-add]');
    await page.click('[data-testid=btn-reset-absences]');
    await expect(page.locator('.absence-chip')).toHaveCount(0);
    expect((await schedule(page)).tasks[0].finish).toBe('2026-11-16');
  });

  test('список исполнителей берётся из загруженного файла', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const options = await page.$$eval('[data-testid=absence-executor] option', (os) => os.map((o) => o.value));
    expect(options).toEqual(['Волкова', 'Зайцев', 'Козлова', 'Лебедев', 'Морозов', 'Орлов', 'Соколов']); // русский алфавит
  });
});

test.describe('живой шаблон пользователя (локально)', () => {
  test('реальный Шаблон.xlsx грузится без ошибок и держит правила', async ({ page }) => {
    test.skip(!hasLocal('real-template.xlsx'), 'реальный Шаблон.xlsx не найден — тест только для машины с ним');
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await loadFixture(page, 'local/real-template.xlsx');
    const res = await page.evaluate(() => {
      const st = window.__gantt.state;
      const s = st.sched;
      const violations = [];
      for (const [executor, intervals] of s.executors) {
        for (let i = 0; i < intervals.length; i++) {
          for (let j = i + 1; j < intervals.length; j++) {
            const a = intervals[i];
            const b = intervals[j];
            if (a.taskNum === b.taskNum) continue;
            const overlap = a.start < b.end - 1e-9 && b.start < a.end - 1e-9;
            if (overlap && !window.__gantt.sizeRatioOk(a.hours, b.hours)) {
              violations.push(`${executor}: ${a.hours}ч и ${b.hours}ч`);
            }
          }
        }
      }
      const peaks = [...window.__gantt.executorLoad(s).values()].map((l) => l.peak);
      return {
        tasks: s.tasks.length,
        rows: document.querySelectorAll('.row').length,
        segs: document.querySelectorAll('.seg').length,
        maxPeak: Math.max(0, ...peaks),
        violations,
        uniqueRowIds: new Set([...document.querySelectorAll('.row')].map((r) => r.getAttribute('data-testid'))).size
      };
    });
    expect(res.tasks).toBeGreaterThan(0);
    expect(res.rows).toBe(res.tasks);
    expect(res.segs).toBeGreaterThan(0);
    expect(res.maxPeak).toBeLessThanOrEqual(2);
    expect(res.violations).toEqual([]);
    expect(res.uniqueRowIds).toBe(res.tasks); // повторяющиеся номера разведены
    expect(errors).toEqual([]);
  });

  test('повторяющиеся номера задач не ломают выбор строки', async ({ page }) => {
    test.skip(!hasLocal('real-template.xlsx'), 'реальный Шаблон.xlsx не найден');
    await loadFixture(page, 'local/real-template.xlsx');
    const dup = await page.evaluate(() => {
      const nums = window.__gantt.state.sched.tasks.map((t) => t.num);
      const seen = new Map();
      let dupNum = null;
      for (const n of nums) {
        seen.set(n, (seen.get(n) || 0) + 1);
        if (seen.get(n) > 1) dupNum = n;
      }
      return { dupNum, ids: [...document.querySelectorAll('.row')].map((r) => r.getAttribute('data-testid')) };
    });
    test.skip(!dup.dupNum, 'в текущем файле нет повторяющихся номеров');
    const rows = page.locator('.row');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await rows.nth(i).click();
      const selectedIndex = await page.evaluate(() => window.__gantt.state.selectedIndex);
      expect(selectedIndex).toBe(i);
    }
  });
});

test.describe('повторяющиеся номера (синтетика)', () => {
  test('дубли номеров не ломают выбор строки и идентификаторы', async ({ page }) => {
    await loadFixture(page, 'template-wide.xlsx');
    const ids = await page.$$eval('.row', (rows) => rows.map((r) => r.getAttribute('data-testid')));
    expect(new Set(ids).size).toBe(ids.length);
    const count = ids.length;
    for (let i = 0; i < count; i++) {
      await page.locator('.row').nth(i).click();
      expect(await page.evaluate(() => window.__gantt.state.selectedIndex)).toBe(i);
    }
  });
});

test.describe('приоритет в плане', () => {
  test('низкоприоритетная задача старше — есть предупреждение', async ({ page }) => {
    await loadFixture(page, 'priority.xlsx');
    const s = await schedule(page);
    expect(s.tasks[1].start).toBe('2026-11-02');
    expect(s.tasks[0].start).toBe('2026-11-16');
    const warn = s.warnings.find((w) => w.startsWith('priority'));
    expect(warn).toBeTruthy();
    expect(warn).toContain('Нарушение приоритета');
    expect(warn).toContain('задача 2');
    expect(warn).toContain('раньше задачи 1');
    await expect(page.locator('[data-testid=alert-priority]').first()).toBeVisible();
  });

  test('на sample порядок приоритетов не нарушен', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const s = await schedule(page);
    expect(s.warnings.filter((w) => w.startsWith('priority'))).toEqual([]);
  });

  test('несколько нарушений по одной задаче сводятся в одно предупреждение', async ({ page }) => {
    // сконвертированный РКК: приоритеты 1..4 и много задач
    const aoa = await convertRkk(page);
    const file = writeAoaToTempFile(aoa);
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);

    const s = await schedule(page);
    const warns = s.warnings.filter((w) => w.startsWith('priority'));
    expect(warns.length).toBeGreaterThan(0);
    const nums = warns.map((w) => w.match(/задача (\d+)/)[1]);
    expect(new Set(nums).size).toBe(nums.length); // одна строка на задачу-нарушителя
    for (const w of warns) {
      if (w.includes('задач с более высоким приоритетом')) {
        const declared = Number(w.match(/раньше (\d+) задач/)[1]);
        const listed = w.split(': ').pop().split(', ').filter((p) => /^\d+ \(/.test(p)).length;
        expect(listed).toBe(Math.min(6, declared));
      }
    }
  });

  test('равный приоритет не считается нарушением', async ({ page }) => {
    await loadFixture(page, 'conflicts.xlsx'); // все приоритета 1/1/2
    const s = await schedule(page);
    expect(s.warnings.filter((w) => w.startsWith('priority'))).toEqual([]);
  });

  test('более приоритетная задача получает ресурс первой', async ({ page }) => {
    await loadFixture(page, 'conflicts.xlsx');
    const s = await schedule(page);
    // одинаковые 8ч задачи одного исполнителя идут строго по порядку номеров/приоритета
    expect(s.tasks[0].start < s.tasks[1].start || s.tasks[0].start === s.tasks[1].start).toBe(true);
    expect(s.tasks[1].phases[0].startPos).toBeGreaterThanOrEqual(s.tasks[0].phases[0].endPos - 1e-9);
  });
});

test.describe('ограничение «Не раньше» в Ганте', () => {
  const HEAD = ['Номер', 'Приоритет', 'Название', 'Общая длительность, дн',
    'Начало базовое', 'Окончание базовое', 'Начало фактическое', 'Окончание фактическое',
    'Оценка SP', 'C++, ч', 'Исполнитель C++', 'Питон, ч', 'Исполнитель питон',
    'Дотнет, ч', 'Исполнитель дотнет', 'Фронт, ч', 'Исполнитель фронт', 'Не раньше'];

  async function loadTemplate(page, rows) {
    const file = writeAoaToTempFile([HEAD, ...rows]);
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);
    return schedule(page);
  }

  test('задача не начинается раньше даты готовности ТТ', async ({ page }) => {
    const s = await loadTemplate(page, [
      [1, 1, 'Готова позже', null, null, null, null, null, null,
        16, 'Иванов', null, null, null, null, null, null, new Date(Date.UTC(2026, 11, 1))]
    ]);
    expect(s.tasks[0].start).toBe('2026-12-01');
  });

  test('готовая ТТ не мешает старту (дата в прошлом)', async ({ page }) => {
    const s = await loadTemplate(page, [
      [1, 1, 'Готова давно', null, null, null, null, null, null,
        16, 'Иванов', null, null, null, null, null, null, new Date(Date.UTC(2026, 5, 1))]
    ]);
    expect(s.tasks[0].start < '2026-12-01').toBe(true);
  });

  test('фактическое начало старше ограничения', async ({ page }) => {
    const s = await loadTemplate(page, [
      [1, 1, 'Уже начата', null, null, null, null, null, null,
        16, 'Иванов', null, null, null, null, null, null, new Date(Date.UTC(2026, 11, 1))],
      [2, 1, 'Уже начата 2', null, null, null, new Date(Date.UTC(2026, 9, 5)), null, null,
        16, 'Петров', null, null, null, null, null, null, new Date(Date.UTC(2026, 11, 1))]
    ]);
    // задача 1 без факта - ждёт готовности, задача 2 уже начата - факт важнее
    expect(s.tasks[0].start).toBe('2026-12-01');
    expect(s.tasks[1].start).toBe('2026-10-05');
  });

  test('ограничение отрисовано отдельным маркером', async ({ page }) => {
    await loadTemplate(page, [
      [1, 1, 'Ждёт ТТ', null, null, null, null, null, null,
        16, 'Иванов', null, null, null, null, null, null, new Date(Date.UTC(2026, 11, 1))]
    ]);
    await expect(page.locator('[data-testid=notbefore-1]')).toBeVisible();
    await expect(page.locator('[data-testid=notbefore-1]')).toHaveAttribute('title', /Не раньше: 01\.12\.2026/);
  });

  test('старый формат шаблона без колонки «Не раньше» читается', async ({ page }) => {
    const oldHead = HEAD.slice(0, 17).concat(['Стек (доп.)', 'Часы (доп.)', 'Исполнитель (доп.)']);
    const file = writeAoaToTempFile([oldHead,
      [1, 1, 'Старый формат', null, null, null, null, null, null,
        16, 'Иванов', null, null, null, null, null, null, 'Фронт', 8, 'Петров']]);
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);
    const s = await schedule(page);
    expect(s.tasks[0].phases.map((p) => p.stack)).toEqual(['cpp', 'front']);
    expect(s.warnings.filter((w) => w.startsWith('wrong-format'))).toEqual([]);
  });
});

test.describe('границы начала: факт, готовность ТТ и план', () => {
  const HEAD = ['Номер', 'Приоритет', 'Название', 'Общая длительность, дн',
    'Начало базовое', 'Окончание базовое', 'Начало фактическое', 'Окончание фактическое',
    'Оценка SP', 'C++, ч', 'Исполнитель C++', 'Питон, ч', 'Исполнитель питон',
    'Дотнет, ч', 'Исполнитель дотнет', 'Фронт, ч', 'Исполнитель фронт', 'Не раньше'];

  async function load(page, rows) {
    const file = writeAoaToTempFile([HEAD, ...rows]);
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);
    return schedule(page);
  }

  test('план старта позже готовности — задача ждёт план', async ({ page }) => {
    // ровно случай из РКК: готовность ТТ 10.06, план начала 30.11
    const s = await load(page, [
      [1, 1, 'План позже готовности', null, new Date(Date.UTC(2026, 10, 30)), null, null, null, null,
        80, 'Иванов', null, null, null, null, null, null, new Date(Date.UTC(2026, 5, 10))]
    ]);
    expect(s.tasks[0].start).toBe('2026-11-30');
  });

  test('готовность позже плана — задача ждёт готовность', async ({ page }) => {
    const s = await load(page, [
      [1, 1, 'Готовность позже', null, new Date(Date.UTC(2026, 9, 5)), null, null, null, null,
        80, 'Иванов', null, null, null, null, null, null, new Date(Date.UTC(2026, 11, 1))]
    ]);
    expect(s.tasks[0].start).toBe('2026-12-01');
  });

  test('фактическое начало важнее обеих границ', async ({ page }) => {
    const s = await load(page, [
      [1, 1, 'Уже в работе', null, new Date(Date.UTC(2026, 11, 1)), null, new Date(Date.UTC(2026, 8, 1)), null, null,
        80, 'Иванов', null, null, null, null, null, null, new Date(Date.UTC(2026, 11, 15))]
    ]);
    expect(s.tasks[0].start).toBe('2026-09-01'); // факт, задача уже идёт
  });

  test('снятая галочка «не раньше плана» игнорирует план, но не готовность', async ({ page }) => {
    const file = writeAoaToTempFile([HEAD,
      [1, 1, 'Без плана', null, new Date(Date.UTC(2026, 11, 1)), null, null, null, null,
        80, 'Иванов', null, null, null, null, null, null, new Date(Date.UTC(2026, 10, 10))]
    ]);
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);
    await setRespectBaseline(page, false);
    const s = await schedule(page);
    expect(s.tasks[0].start).toBe('2026-11-10'); // готовность ТТ остаётся границей
  });
});
