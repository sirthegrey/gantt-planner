import { test, expect } from '@playwright/test';
import { convertAoa, loadConverterRaw, rkkAoa } from './helpers.mjs';

/* Классы эквивалентности входа конвертера (РКК.xlsx -> Шаблон.xlsx).
 * Каждый тест описывает один класс: как он должен выглядеть на выходе. */

const dd = (s) => new Date(s + 'T00:00:00Z');
const EXEC = [[33, 'Орлов'], [34, 'Соколов'], [35, 'Морозов'], [36, 'Волков'], [42, 'Волкова']];
const SKILLS = [
  [4, 'Орлов Артём', 'C++'],
  [5, 'Соколов Игорь', 'C#'],
  [6, 'Морозов Пётр', 'Python'],
  [7, 'Волков Денис', 'C#'],
  [13, 'Волкова Ольга', 'Front']
];
const task = (over = {}) => ({
  row: 60, priority: 1, name: 'ТТ 300001: задача', ready: null, from: null, to: null,
  hours: { Орлов: 8 }, ...over
});
const today = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
const weekAhead = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);

test.describe('лист и раскладка', () => {
  test('лист с другим именем: берётся первый', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({ skills: SKILLS, executors: EXEC, tasks: [task()] }), { sheetName: 'Данные' });
    expect(out.rows.length).toBe(1);
    expect(out.rows[0]['Название']).toBe('ТТ 300001: задача');
  });

  test('колонки без имени в строке 48 игнорируются', async ({ page }) => {
    const executors = [...EXEC, [37, null], [38, '']]; // AK и AL без фамилий
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors,
      tasks: [task({ hours: { Орлов: 8, null: 100 } })]
    }));
    expect(out.rows.length).toBe(1);
    expect(out.rows[0]['C++, ч']).toBe(8);
    expect(out.rows[0]['Питон, ч']).toBeNull();
  });

  test('файл без задач и исполнителей даёт понятную ошибку', async ({ page }) => {
    await loadConverterRaw(page, rkkAoa({ skills: [], executors: [], tasks: [] }));
    await expect(page.locator('[data-testid=conv-report] .alert.critical')).toContainText('Не похоже на лист РКК');
    expect(await page.evaluate(() => window.__convState.result)).toBeNull();
  });
});

test.describe('скиллы исполнителя', () => {
  const cases = [
    ['C# как C#', 'C#', 'Дотнет'],
    ['.Net как Дотнет', '.Net', 'Дотнет'],
    ['Дотнет по-русски', 'Дотнет', 'Дотнет'],
    ['TS как Фронт', 'TS', 'Фронт'],
    ['Front как Фронт', 'Front', 'Фронт'],
    ['питон строчными', 'python', 'Питон'],
    ['Питон по-русски', 'Питон', 'Питон'],
    ['C++ как C++', 'C++', 'C++']
  ];
  for (const [label, skill, column] of cases) {
    test(`${label} -> ${column}`, async ({ page }) => {
      const out = await convertAoa(page, rkkAoa({
        skills: [[4, 'Орлов Артём', skill]],
        executors: [[33, 'Орлов']],
        tasks: [task({ hours: { Орлов: 8 } })]
      }));
      expect(out.rows[0][`${column}, ч`]).toBe(8);
      expect(out.rows[0][`Исполнитель ${column === 'Питон' ? 'питон' : column === 'Дотнет' ? 'дотнет' : column === 'Фронт' ? 'фронт' : 'C++'}`]).toBe('Орлов');
    });
  }

  test('несколько стеков через слэш: берётся свободный от моно-исполнителя', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: [[4, 'Орлов Артём', 'C# / Python'], [5, 'Морозов Пётр', 'C#']],
      executors: [[33, 'Орлов'], [35, 'Морозов']],
      tasks: [task({ hours: { Орлов: 8, Морозов: 8 } })]
    }));
    expect(out.rows[0]['Дотнет, ч']).toBe(8);
    expect(out.rows[0]['Исполнитель дотнет']).toBe('Морозов');
    expect(out.rows[0]['Питон, ч']).toBe(8);
    expect(out.rows[0]['Исполнитель питон']).toBe('Орлов');
  });

  test('роль без маппинга: часы теряются, строка в отчёте', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: [[4, 'Орлов Артём', 'Тест']],
      executors: [[33, 'Орлов']],
      tasks: [task({ hours: { Орлов: 8 } })]
    }));
    expect(out.report.unmapped.length).toBe(1);
    expect(out.report.unmapped[0]).toMatchObject({ executor: 'Орлов', hours: 8 });
    expect(out.rows[0]['C++, ч']).toBeNull();
  });

  test('смешанный скилл: стек мапится, лишняя роль в отчёт', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: [[4, 'Орлов Артём', 'Python / meth']],
      executors: [[33, 'Орлов']],
      tasks: [task({ hours: { Орлов: 8 } })]
    }));
    expect(out.rows[0]['Питон, ч']).toBe(8);
    expect(out.report.droppedSkills).toEqual([{ executor: 'Орлов', skills: 'Python / meth', dropped: 'meth' }]);
  });

  test('исполнитель не из таблицы H/I: часы теряются, строка в отчёте', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS,
      executors: [...EXEC, [37, 'Неизвестный']],
      tasks: [task({ hours: { Неизвестный: 8 } })]
    }));
    expect(out.report.unknownExecutor.length).toBe(1);
    expect(out.rows[0]['C++, ч']).toBeNull();
  });

  test('пустая строка в таблице скиллов не ломает разбор', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: [[4, null, 'Python'], [5, 'Орлов Артём', 'C++']],
      executors: [[33, 'Орлов']],
      tasks: [task({ hours: { Орлов: 8 } })]
    }));
    expect(out.rows[0]['C++, ч']).toBe(8);
  });
});

test.describe('строки задач', () => {
  test('разделитель без «ТТ» пропускается', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC,
      tasks: [task(), { row: 61, name: 'Фронт автокорректировки', hours: {} }]
    }));
    expect(out.rows.length).toBe(1);
    expect(out.report.skipped).toEqual([{ row: 61, name: 'Фронт автокорректировки', reason: 'не задача (разделитель)' }]);
  });

  test('пустая строка внутри диапазона попадает в отчёт, хвост - нет', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC,
      tasks: [task(), { row: 61, name: '', hours: {} }, task({ row: 62, name: 'ТТ 300003: после пропуска' })]
    }));
    expect(out.report.skipped).toEqual([{ row: 61, reason: 'пустая строка' }]);
    expect(out.rows.length).toBe(2);
  });

  test('задача без часов переносится и попадает в отчёт', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC,
      tasks: [task({ hours: {} })]
    }));
    expect(out.rows.length).toBe(1);
    expect(out.report.noHours.map((t) => t.row)).toEqual([60]);
  });

  test('приоритет не заполнен остаётся пустым', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC,
      tasks: [task({ priority: null })]
    }));
    expect(out.rows[0]['Приоритет']).toBeNull();
  });
});

test.describe('даты', () => {
  test('готовность ТТ: дата пишется как есть', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC,
      tasks: [task({ ready: dd('2026-12-01') })]
    }));
    expect(out.rows[0]['Не раньше']).toBe('2026-12-01');
    expect(out.report.notBeforeDefault).toEqual([]);
  });

  test('готовность ТТ пустая: неделя от сегодня и запись в отчёте', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC, tasks: [task({ ready: null })]
    }));
    expect(out.rows[0]['Не раньше']).toBe(weekAhead);
    expect(out.report.notBeforeDefault[0]).toMatchObject({ row: 60, ready: 'пусто' });
  });

  test('готовность ТТ текстом: как пустая, текст виден в отчёте', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC, tasks: [task({ ready: 'не готово' })]
    }));
    expect(out.rows[0]['Не раньше']).toBe(weekAhead);
    expect(out.report.notBeforeDefault[0]).toMatchObject({ row: 60, ready: 'не готово' });
  });

  test('даты плана: только F, только G, обе, перевёрнутые', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC,
      tasks: [
        task({ row: 60, from: dd('2026-11-01') }),
        task({ row: 61, to: dd('2026-11-20') }),
        task({ row: 62, from: dd('2026-11-05'), to: dd('2026-11-25') }),
        task({ row: 63, from: dd('2026-11-30'), to: dd('2026-11-01') }) // перевёрнутый план
      ]
    }));
    expect([out.rows[0]['Начало базовое'], out.rows[0]['Окончание базовое']]).toEqual(['2026-11-01', null]);
    expect([out.rows[1]['Начало базовое'], out.rows[1]['Окончание базовое']]).toEqual([null, '2026-11-20']);
    expect([out.rows[2]['Начало базовое'], out.rows[2]['Окончание базовое']]).toEqual(['2026-11-05', '2026-11-25']);
    expect([out.rows[3]['Начало базовое'], out.rows[3]['Окончание базовое']]).toEqual(['2026-11-30', '2026-11-01']);
    expect(out.report.planDates.count).toBe(4);
    expect(out.report.planDates.missing).toEqual([]);
  });

  test('задача без дат плана попадает в отчёт', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC, tasks: [task()]
    }));
    expect(out.report.planDates.missing.map((t) => t.row)).toEqual([60]);
  });
});

test.describe('часы и фазы', () => {
  test('дробные часы переносятся как есть', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC, tasks: [task({ hours: { Орлов: 0.5 } })]
    }));
    expect(out.rows[0]['C++, ч']).toBe(0.5);
  });

  test('нечисловой текст в часах игнорируется', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC, tasks: [task({ hours: { Орлов: 'abc' } })]
    }));
    expect(out.rows[0]['C++, ч']).toBeNull();
    expect(out.report.noHours.map((t) => t.row)).toEqual([60]);
  });

  test('нулевые часы не создают фазу', async ({ page }) => {
    const out = await convertAoa(page, rkkAoa({
      skills: SKILLS, executors: EXEC, tasks: [task({ hours: { Орлов: 0 } })]
    }));
    expect(out.rows[0]['C++, ч']).toBeNull();
  });

  test('трое на одном стеке: три тройки, maxExtra 3', async ({ page }) => {
    const executors = [...EXEC, [37, 'Волков2'], [38, 'Волков3']];
    const skills = [...SKILLS, [7, 'Волков2 Дубль', 'C#'], [8, 'Волков3 Дубль', 'C#']];
    const out = await convertAoa(page, rkkAoa({
      skills, executors,
      tasks: [task({ hours: { Соколов: 8, Волков: 8, Волков2: 8, Волков3: 8 } })]
    }));
    expect(out.maxExtra).toBe(2); // один в стандартном блоке, двое в тройках
    expect(out.header.filter((h) => h === 'Стек (доп.)').length).toBe(2);
    expect(out.rows[0]['Исполнитель дотнет']).toBe('Соколов');
    expect(out.rows[0]['Стек (доп.)']).toBe('Дотнет');
  });
});

test.describe('несколько листов', () => {
  test('лист «26 4к» побеждает первый лист с мусором', async ({ page }) => {
    await loadConverterRaw(page, rkkAoa({ skills: SKILLS, executors: EXEC, tasks: [] }));
    const out = await page.evaluate(() => {
      // первый лист - мусор, второй - данные РКК
      const junk = XLSX.utils.aoa_to_sheet([['совсем', 'другая', 'таблица'], [1, 2, 3]]);
      const rows = [];
      const set = (r, c, v) => {
        while (rows.length < r) rows.push([]);
        const row = rows[r - 1];
        while (row.length < c) row.push(null);
        row[c - 1] = v;
      };
      set(4, 8, 'Орлов Артём'); set(4, 9, 'C++');
      set(48, 33, 'Орлов');
      set(60, 1, 1); set(60, 8, 'ТТ 400001: с другого листа'); set(60, 33, 8);
      const data = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, junk, 'Мусор');
      XLSX.utils.book_append_sheet(wb, data, '26 4к');
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      return window.__converter.convertRkkToTemplate(buf);
    });
    const idx = out.aoa[0].indexOf('Название');
    expect(out.aoa[1][idx]).toBe('ТТ 400001: с другого листа');
    expect(out.sheetName).toBe('26 4к');
  });
});
