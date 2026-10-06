import { test, expect } from '@playwright/test';
import {
  loadTemplateAoa, schedule, templateHeaderWith, templateRow
} from './helpers.mjs';

/* Классы эквивалентности входа Ганта (Шаблон.xlsx).
 * Каждый тест - один класс: значение на границе или в середине диапазона,
 * которое должно обрабатываться одинаково. */

const H = templateHeaderWith();
const row = (opts) => [H, templateRow(opts)];
const dd = (s) => new Date(s + 'T00:00:00Z');

test.describe('часы фазы', () => {
  const cases = [
    ['нулевые часы', 0, 0],
    ['часы не заполнены', null, 0],
    ['отрицательные часы', -5, 0],
    ['дробные часы', 4, 1],
    ['часы строкой', '8', 1],
    ['нечисловой текст в часах', 'abc', 0],
    ['очень большие часы', 10000, 1]
  ];
  for (const [label, hours, expectedPhases] of cases) {
    test(`${label} -> фаз ${expectedPhases}`, async ({ page }) => {
      const s = await loadTemplateAoa(page, row({
        num: 1, phases: { cpp: { hours, executor: 'Орлов' } }
      }));
      expect(s.tasks[0].phases.length).toBe(expectedPhases);
      expect(s.tasks.some((t) => t.scheduled)).toBe(expectedPhases > 0);
    });
  }

  test('дробные часы дают половину рабочего дня', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, phases: { cpp: { hours: 4, executor: 'Орлов' } }
    }));
    const [cpp] = s.tasks[0].phases;
    expect(cpp.endPos - cpp.startPos).toBeCloseTo(0.5, 6);
  });
});

test.describe('исполнитель', () => {
  test('часы без исполнителя: фаза пропущена с предупреждением', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({ num: 1, phases: { cpp: { hours: 8, executor: '' } } }));
    expect(s.tasks[0].phases.length).toBe(0);
    expect(s.warnings.some((w) => w.startsWith('missing-executor'))).toBe(true);
  });

  test('имя из пробелов считается отсутствующим', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({ num: 1, phases: { cpp: { hours: 8, executor: '   ' } } }));
    expect(s.tasks[0].phases.length).toBe(0);
  });

  test('хвостовые пробелы в имени не создают второго исполнителя', async ({ page }) => {
    const s = await loadTemplateAoa(page, [H,
      templateRow({ num: 1, phases: { cpp: { hours: 8, executor: 'Орлов ' } } }),
      templateRow({ num: 2, phases: { net: { hours: 8, executor: 'Орлов' } } })
    ]);
    const load = await page.evaluate(() => [...window.__gantt.executorLoad(window.__gantt.state.sched).keys()]);
    expect(load).toEqual(['Орлов']);
  });
});

test.describe('номер и приоритет', () => {
  test('номер отсутствует - подставляется порядковый', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: null, name: 'ТТ 900001: без номера', phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].num).toBe(1);
    expect(s.tasks[0].name).toBe('ТТ 900001: без номера');
  });

  test('пустое имя - подставляется «Задача N»', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 7, name: '', phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].name).toBe('Задача 7');
  });

  test('дробный номер принимается', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({ num: 1.5, phases: { cpp: { hours: 8, executor: 'Орлов' } } }));
    expect(s.tasks[0].num).toBe(1.5);
  });

  test('приоритет не заполнен - считается низшим (99)', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, priority: null, phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].priority).toBe(99);
  });

  test('нечисловой приоритет - тоже низший', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, priority: 'высокий', phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].priority).toBe(99);
  });

  test('отрицательный приоритет уходит вперёд приоритета 1', async ({ page }) => {
    const s = await loadTemplateAoa(page, [H,
      templateRow({ num: 1, priority: 1, phases: { cpp: { hours: 40, executor: 'Орлов' } } }),
      templateRow({ num: 2, priority: -1, phases: { cpp: { hours: 8, executor: 'Орлов' } } })
    ]);
    const negative = s.tasks.find((t) => t.num === 2);
    const normal = s.tasks.find((t) => t.num === 1);
    expect(negative.phases[0].startPos).toBeLessThan(normal.phases[0].startPos + 1e-9);
  });
});

test.describe('даты плана', () => {
  test('только базовое начало задаёт границу', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, baseStart: dd('2026-11-05'), phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].start).toBe('2026-11-05');
  });

  test('базовое начало в выходной сдвигает на понедельник', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, baseStart: dd('2026-11-07'), // суббота
      phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].start).toBe('2026-11-09');
  });

  test('базовое начало в праздник сдвигает на следующий рабочий день', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, baseStart: dd('2026-11-04'), // День народного единства
      phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].start).toBe('2026-11-05');
  });

  test('перевёрнутый план (начало позже окончания) не ломает расчёт', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, baseStart: dd('2026-12-01'), baseFinish: dd('2026-11-01'),
      phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].start).toBe('2026-12-01');
  });

  test('нулевая плановая длительность даёт перерасход', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, duration: 0, phases: { cpp: { hours: 40, executor: 'Орлов' } }
    }));
    expect(s.warnings.some((w) => w.startsWith('over-plan'))).toBe(true);
  });
});

test.describe('фактические даты', () => {
  test('фактическое окончание без начала: задача завершена', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, actualFinish: dd('2026-10-10'), phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].done).toBe(true);
    expect(s.tasks[0].scheduled).toBe(false);
  });

  test('окончание раньше начала: всё равно завершена, без падения', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1, actualStart: dd('2026-10-20'), actualFinish: dd('2026-10-01'),
      phases: { cpp: { hours: 8, executor: 'Орлов' } }
    }));
    expect(s.tasks[0].done).toBe(true);
  });
});

test.describe('ограничение «Не раньше»', () => {
  const Hn = templateHeaderWith();
  test('дата в выходной сдвигает старт на понедельник', async ({ page }) => {
    const s = await loadTemplateAoa(page, [Hn, templateRow({
      num: 1, notBefore: dd('2026-11-08'), phases: { cpp: { hours: 8, executor: 'Орлов' } }
    })]);
    expect(s.tasks[0].start).toBe('2026-11-09');
  });

  test('дата в прошлом не влияет на старт', async ({ page }) => {
    const s = await loadTemplateAoa(page, [Hn, templateRow({
      num: 1, notBefore: dd('2020-01-01'), baseStart: dd('2026-11-10'),
      phases: { cpp: { hours: 8, executor: 'Орлов' } }
    })]);
    expect(s.tasks[0].start).toBe('2026-11-10');
  });
});

test.describe('дополнительные тройки колонок', () => {
  const He = templateHeaderWith({ extras: 3 });
  test('нулевые часы в тройке пропускаются, следующие читаются', async ({ page }) => {
    const s = await loadTemplateAoa(page, [He, templateRow({
      num: 1,
      phases: { net: { hours: 8, executor: 'Морозов' } },
      extras: [
        { stack: 'Дотнет', hours: 0, executor: 'Волков' },
        { stack: 'Фронт', hours: 8, executor: 'Волкова' }
      ]
    })]);
    expect(s.tasks[0].phases.map((p) => p.stack)).toEqual(['net', 'front']);
    expect(s.warnings.some((w) => w.startsWith('missing-executor'))).toBe(true);
  });

  test('тройка без исполнителя пропускается', async ({ page }) => {
    const s = await loadTemplateAoa(page, [He, templateRow({
      num: 1,
      phases: { cpp: { hours: 8, executor: 'Орлов' } },
      extras: [{ stack: 'Фронт', hours: 8, executor: '' }]
    })]);
    expect(s.tasks[0].phases.map((p) => p.stack)).toEqual(['cpp']);
  });

  test('неизвестный стек останавливает чтение троек', async ({ page }) => {
    const s = await loadTemplateAoa(page, [He, templateRow({
      num: 1,
      phases: { cpp: { hours: 8, executor: 'Орлов' } },
      extras: [
        { stack: 'Java', hours: 8, executor: 'Волков' },
        { stack: 'Фронт', hours: 8, executor: 'Волкова' }
      ]
    })]);
    expect(s.tasks[0].phases.map((p) => p.stack)).toEqual(['cpp']);
  });

  test('три доп. фазы одного стека создают цепочку', async ({ page }) => {
    const s = await loadTemplateAoa(page, [He, templateRow({
      num: 1,
      extras: [
        { stack: 'Дотнет', hours: 8, executor: 'Волков' },
        { stack: 'Дотнет', hours: 8, executor: 'Морозов' },
        { stack: 'Дотнет', hours: 8, executor: 'Тихонов' }
      ]
    })]);
    expect(s.tasks[0].phases.map((p) => p.executor)).toEqual(['Волков', 'Морозов', 'Тихонов']);
    for (let i = 1; i < 3; i++) {
      expect(s.tasks[0].phases[i].startPos).toBeCloseTo(s.tasks[0].phases[i - 1].endPos, 6);
    }
  });
});

test.describe('строки файла', () => {
  test('пустая строка между задачами не создаёт фантомной задачи', async ({ page }) => {
    const s = await loadTemplateAoa(page, [H,
      templateRow({ num: 1, phases: { cpp: { hours: 8, executor: 'Орлов' } } }),
      new Array(18).fill(null),
      templateRow({ num: 2, phases: { net: { hours: 8, executor: 'Морозов' } } })
    ]);
    expect(s.tasks.map((t) => t.num)).toEqual([1, 2]);
  });

  test('очень длинное название не ломает рендер', async ({ page }) => {
    const longName = 'ТТ 900002: ' + 'очень длинное название задачи '.repeat(10);
    await loadTemplateAoa(page, row({ num: 1, name: longName, phases: { cpp: { hours: 8, executor: 'Орлов' } } }));
    await expect(page.locator('[data-testid=row-1]')).toBeVisible();
  });

  test('один исполнитель на все четыре стека: фазы строго последовательны', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1,
      phases: {
        cpp: { hours: 8, executor: 'Орлов' },
        py: { hours: 8, executor: 'Орлов' },
        net: { hours: 8, executor: 'Орлов' },
        front: { hours: 8, executor: 'Орлов' }
      }
    }));
    const ph = s.tasks[0].phases;
    for (let i = 1; i < ph.length; i++) {
      expect(ph[i].startPos).toBeCloseTo(ph[i - 1].endPos, 6);
    }
  });

  test('все четыре стека у разных исполнителей: C++ и Питон параллельно', async ({ page }) => {
    const s = await loadTemplateAoa(page, row({
      num: 1,
      phases: {
        cpp: { hours: 8, executor: 'Орлов' },
        py: { hours: 8, executor: 'Козлова' },
        net: { hours: 8, executor: 'Морозов' },
        front: { hours: 8, executor: 'Волкова' }
      }
    }));
    const [cpp, py, net] = s.tasks[0].phases;
    expect(py.startPos).toBeCloseTo(cpp.startPos, 6);
    expect(net.startPos).toBeGreaterThanOrEqual(Math.max(cpp.endPos, py.endPos) - 1e-9);
  });
});
