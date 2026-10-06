import { test, expect } from '@playwright/test';
import { appUrl, loadFixture, schedule, setRespectBaseline, writeAoaToTempFile } from './helpers.mjs';

test.describe('планировщик', () => {
  test('исполнитель ведёт не более 2 задач одновременно (sample)', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const s = await schedule(page);
    for (const l of s.load) {
      expect(l.peak, `перегруз у ${l.name}`).toBeLessThanOrEqual(2);
    }
  });

  test('задачи одинакового размера у одного исполнителя идут строго по очереди (conflicts)', async ({ page }) => {
    await loadFixture(page, 'conflicts.xlsx');
    const s = await schedule(page);
    const [a, b, c] = s.tasks;
    // три задачи по 8ч: разница меньше 3x -> одновременно нельзя, идут подряд
    expect(a.start).toBe('2026-11-02');
    expect(b.start).toBe('2026-11-03');
    expect(c.start).toBe('2026-11-05'); // 04.11 — праздник, очередь идёт через него
    for (const l of s.load) expect(l.peak).toBeLessThanOrEqual(2);
  });

  test('задачи планируются по приоритету, затем по номеру', async ({ page }) => {
    await loadFixture(page, 'conflicts.xlsx');
    const s = await schedule(page);
    // A и B имеют приоритет 1, C - 2 => C последняя
    expect(s.tasks[2].start).toBe('2026-11-05');
    const ordered = await page.evaluate(() => {
      const t = window.__gantt.state.sched.tasks;
      return t.filter((x) => x.scheduled).map((x) => x.num);
    });
    expect(ordered).toEqual([1, 2, 3]);
  });

  test('фазы одной задачи последовательны, кроме пары C++/Питон у разных исполнителей', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const s = await schedule(page);
    let parallelPairs = 0;
    for (const t of s.tasks) {
      for (let i = 1; i < t.phases.length; i++) {
        const prev = t.phases[i - 1];
        const cur = t.phases[i];
        const pair = (cur.stack === 'py' && prev.stack === 'cpp') || (cur.stack === 'cpp' && prev.stack === 'py');
        if (pair && cur.executor !== prev.executor) {
          parallelPairs++;
          expect(cur.startPos).toBeCloseTo(prev.startPos, 6); // стартуют одновременно
          continue;
        }
        expect(cur.startPos).toBeGreaterThanOrEqual(prev.endPos - 1e-9);
      }
    }
    expect(parallelPairs).toBeGreaterThan(0);
  });

  test('C++ и Питон у одного исполнителя идут последовательно', async ({ page }) => {
    const aoa = [
      ['Номер', 'Приоритет', 'Название', 'Общая длительность, дн',
        'Начало базовое', 'Окончание базовое', 'Начало фактическое', 'Окончание фактическое',
        'Оценка SP', 'C++, ч', 'Исполнитель C++', 'Питон, ч', 'Исполнитель питон',
        'Дотнет, ч', 'Исполнитель дотнет', 'Фронт, ч', 'Исполнитель фронт'],
      [1, 1, 'Один человек на C++ и Питон', null, null, null, null, null, null,
        16, 'Иванов', 16, 'Иванов', null, null, null, null]
    ];
    const file = writeAoaToTempFile(aoa);
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);
    const s = await schedule(page);
    const [cpp, py] = s.tasks[0].phases;
    expect(cpp.executor).toBe(py.executor);
    expect(py.startPos).toBeCloseTo(cpp.endPos, 6); // строго друг за другом
  });

  test('C++ и Питон у разных исполнителей идут параллельно, Дотнет ждёт обоих', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const s = await schedule(page);
    const t1 = s.tasks[0];
    const cpp = t1.phases.find((p) => p.stack === 'cpp');
    const py = t1.phases.find((p) => p.stack === 'py');
    const net = t1.phases.find((p) => p.stack === 'net');
    expect(cpp.executor).not.toBe(py.executor);
    expect(py.startPos).toBeCloseTo(cpp.startPos, 6);
    expect(net.startPos).toBeGreaterThanOrEqual(Math.max(cpp.endPos, py.endPos) - 1e-9);
    expect(cpp.start).toBe(t1.start);
    expect(py.start).toBe(t1.start);
  });

  test('длительность фазы = часы / 8 рабочих дней', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const s = await schedule(page);
    const cpp = s.tasks[0].phases[0];
    expect(cpp.hours).toBe(24);
    expect(cpp.endPos - cpp.startPos).toBeCloseTo(3, 6);
    const front = s.tasks[0].phases[3];
    expect(front.endPos - front.startPos).toBeCloseTo(36 / 8, 6);
  });

  test('фактическое начало фиксирует старт задачи (edge)', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const s = await schedule(page);
    const pinned = s.tasks.find((t) => t.num === 4);
    expect(pinned.pinned).toBe(true);
    expect(pinned.start).toBe('2026-11-25'); // ровно фактическое начало, не раньше базового плана
  });

  test('завершённая задача не планируется', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const s = await schedule(page);
    const done = s.tasks.find((t) => t.num === 3);
    expect(done.done).toBe(true);
    expect(done.scheduled).toBe(false);
    expect(done.start).toBeNull();
  });

  test('фаза без исполнителя пропускается с предупреждением', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const s = await schedule(page);
    const t2 = s.tasks.find((t) => t.num === 2);
    expect(t2.scheduled).toBe(false); // единственная фаза отброшена -> планировать нечего
    expect(t2.phases).toEqual([]);
    expect(s.warnings.some((w) => w.includes('missing-executor'))).toBe(true);
    await expect(page.locator('[data-testid=row-2] .no-phases')).toBeVisible();
  });

  test('нулевые часы не создают фазу', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const s = await schedule(page);
    const t1 = s.tasks.find((t) => t.num === 1);
    expect(t1.phaseOrder).toEqual(['py']);
  });

  test('дробные часы дают дробную длительность', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const s = await schedule(page);
    const t5 = s.tasks.find((t) => t.num === 5);
    expect(t5.phases[0].endPos - t5.phases[0].startPos).toBeCloseTo(0.5, 6);
  });

  test('предупреждение о перерасходе плана (колонка D)', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const s = await schedule(page);
    expect(s.warnings.some((w) => w.startsWith('over-plan') && w.includes('Задача 7'))).toBe(true);
    await expect(page.locator('[data-testid=alert-over-plan]').first()).toBeVisible();
  });

  test('предупреждение о выходе за базовый план', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    const s = await schedule(page);
    expect(s.warnings.some((w) => w.startsWith('over-baseline') && w.includes('Задача 8'))).toBe(true);
  });

  test('нагрузка: стресс-файл держит лимит 2 и размещает все фазы', async ({ page }) => {
    await loadFixture(page, 'stress.xlsx');
    const s = await schedule(page);
    for (const l of s.load) {
      expect(l.peak, `перегруз у ${l.name}`).toBeLessThanOrEqual(2);
    }
    for (const t of s.tasks) {
      for (const p of t.phases) {
        expect(p.startPos).not.toBeNull();
        expect(p.endPos).toBeGreaterThan(p.startPos);
      }
    }
    expect(s.warnings.filter((w) => w.startsWith('overload'))).toEqual([]);
  });

  test('проект начинается с самого раннего якоря задач', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const s = await schedule(page);
    // начало проекта - самая ранняя граница задач; у задачи 1 это фактическое начало
    expect(s.projectStart).toBe('2026-10-20');
  });

  test('по умолчанию задача не начинается раньше дат плана из файла', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    const s = await schedule(page);
    // базовые начала: задача 1 - 08.05, задача 2 - 06.03
    expect(s.tasks[0].start).toBe('2026-05-08');
    expect(s.tasks[1].start).toBe('2026-03-06');
  });

  test('снятая галочка «не раньше плана» возвращает режим «как можно раньше»', async ({ page }) => {
    await loadFixture(page, 'holidays.xlsx');
    await setRespectBaseline(page, false);
    const s = await schedule(page);
    expect(s.tasks[0].start).toBe('2026-03-06'); // старт от начала проекта
    expect(s.tasks[1].start).toBe('2026-03-06');
  });

  test('если есть только базовое окончание, начало считается назад от него', async ({ page }) => {
    const head = ['Номер', 'Приоритет', 'Название', 'Общая длительность, дн',
      'Начало базовое', 'Окончание базовое', 'Начало фактическое', 'Окончание фактическое',
      'Оценка SP', 'C++, ч', 'Исполнитель C++', 'Питон, ч', 'Исполнитель питон',
      'Дотнет, ч', 'Исполнитель дотнет', 'Фронт, ч', 'Исполнитель фронт', 'Не раньше'];
    const file = writeAoaToTempFile([head,
      [1, 1, 'Только окончание', null, null, new Date(Date.UTC(2026, 11, 18)), null, null, null,
        80, 'Иванов', null, null, null, null, null, null, null]]);
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);
    const s = await schedule(page);
    // 80 ч = 10 рабочих дней: старт не позже чем за 10 рабочих дней до 18.12
    expect(s.tasks[0].finish <= '2026-12-18').toBe(true);
  });

  test('фактическое начало перебивает базовое и при «не раньше плана»', async ({ page }) => {
    await loadFixture(page, 'edge.xlsx');
    await setRespectBaseline(page, true);
    const s = await schedule(page);
    const pinned = s.tasks.find((t) => t.num === 4);
    // базовое 16.11, фактическое 25.11 -> задача начинается по факту
    expect(pinned.start).toBe('2026-11-25');
  });

  test('фактическое начало фиксирует старт задачи', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const s = await schedule(page);
    // задача 1 уже начата -> фактическое начало (2026-10-20) важнее базового
    expect(s.tasks[0].start).toBe('2026-10-20');
    // фактические начала задач 2 и 3 приходятся на воскресенья -> сдвиг на понедельник
    expect(s.tasks[1].start).toBe('2026-10-26');
    expect(s.tasks[2].start).toBe('2026-11-02');
  });
});
