import { test, expect } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import XLSX from 'xlsx';
import { root, fixture, appUrl, schedule, writeAoaToTempFile, hasLocal } from './helpers.mjs';

const convUrl = pathToFileURL(join(root, 'dist/Конвертер.html')).href;

async function loadRkk(page, name) {
  await page.goto(convUrl);
  await page.waitForFunction(() => !!window.__converter);
  await page.setInputFiles('[data-testid=conv-file]', fixture(name));
  await page.waitForFunction(() => !!window.__convState.result);
}

function countPhases(row) {
  let n = 0;
  for (const key of ['C++, ч', 'Питон, ч', 'Дотнет, ч', 'Фронт, ч']) {
    if (row[key]) n++;
  }
  if (row['Стек (доп.)']) n++;
  return n;
}

const result = (page) => page.evaluate(() => {
  const r = window.__convState.result;
  return {
    header: r.aoa[0],
    rowCount: r.aoa.length - 1,
    report: r.report,
    maxExtra: r.maxExtra,
    sheetName: r.sheetName,
    rows: r.aoa.slice(1).map((row) => Object.fromEntries(r.aoa[0].map((h, i) => [h, row[i]])))
  };
});

test.describe('конвертер РКК → Шаблон', () => {
  test('страница конвертера открывается и связана с Гантом', async ({ page }) => {
    await page.goto(convUrl);
    await expect(page.locator('.brand')).toContainText('Конвертер');
    await expect(page.locator('[data-testid=link-gantt]')).toHaveAttribute('href', 'Gantt.html');
    await page.goto(appUrl);
    await expect(page.locator('[data-testid=link-converter]')).toHaveAttribute('href', 'Конвертер.html');
  });

  test('отчёт по замороженному РКК: задачи, фазы, пропуски', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const r = await result(page);
    expect(r.sheetName).toBe('26 4к');
    expect(r.rowCount).toBe(37); // строки 60-97 минус разделитель
    expect(r.maxExtra).toBe(1); // у одной задачи два человека на одном стеке
    expect(r.report.skipped).toEqual([{ row: 86, name: 'Фронт автокорректировки', reason: 'не задача (разделитель)' }]);
    // Фёдоров - роль «Тест», Вакансия вообще нет в таблице скиллов
    expect(r.report.unmapped.map((u) => u.executor)).toEqual(['Фёдоров']);
    expect(r.report.unknownExecutor.map((u) => u.executor)).toEqual(['Вакансия']);
    expect(r.report.noHours.length).toBe(7);
    const totalPhases = r.rows.reduce((sum, row) => sum + countPhases(row), 0);
    expect(totalPhases).toBeGreaterThan(0);
    await expect(page.locator('[data-testid=conv-report]')).toContainText('Лист «26 4к»');
  });

  test('стандартные блоки заполнены, лишние люди уходят в доп. тройку', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const r = await result(page);
    const byName = (tt) => r.rows.find((row) => String(row['Название']).includes(tt));

    // ТТ 100005: Волков 30 ч и Тихонов 30 ч — оба C# (Дотнет)
    const t = byName('ТТ 100005');
    expect(t['Дотнет, ч']).toBe(30);
    expect(t['Исполнитель дотнет']).toBe('Волков');
    expect(t['Стек (доп.)']).toBe('Дотнет');
    expect(t['Часы (доп.)']).toBe(30);
    expect(t['Исполнитель (доп.)']).toBe('Тихонов');

    // ТТ 100002: Соколов (C# / Python), Морозов (C#), Волкова (Front)
    const t2 = byName('ТТ 100002');
    expect(t2['Питон, ч']).toBe(90);
    expect(t2['Исполнитель питон']).toBe('Соколов');
    expect(t2['Дотнет, ч']).toBe(60);
    expect(t2['Исполнитель дотнет']).toBe('Морозов');
    expect(t2['Фронт, ч']).toBe(36);
    expect(t2['Исполнитель фронт']).toBe('Волкова');
  });

  test('стек исполнителя берётся из таблицы H/I', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const r = await result(page);
    // Орлов в H/I помечен C++, Лебедев — «Python / meth» (в Питон)
    const rowOrlov = r.rows.find((row) => row['Название'] && row['Название'].includes('ТТ 100003'));
    expect(rowOrlov).toBeTruthy();
    expect(rowOrlov['C++, ч']).toBe(30);
    expect(rowOrlov['Исполнитель C++']).toBe('Орлов');
    expect(rowOrlov['Питон, ч']).toBe(60);
    expect(rowOrlov['Исполнитель питон']).toBe('Лебедев');
  });

  test('роли вне 4 стеков попадают в отчёт отдельным списком', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const r = await result(page);
    // «Python / meth» -> в Питон, meth отброшен; «Тест» отброшен целиком
    const dropped = r.report.droppedSkills;
    expect(dropped.find((d) => d.executor === 'Лебедев').dropped).toBe('meth');
    expect(dropped.find((d) => d.executor === 'Смирнов').dropped).toBe('meth');
    expect(dropped.find((d) => d.executor === 'Фёдоров').dropped).toBe('тест');
    expect(dropped.every((d) => d.dropped.length > 0)).toBe(true);
    await expect(page.locator('[data-testid=conv-report]')).toContainText('Роли вне 4 стеков');
  });

  test('кнопка выгрузки отдаёт файл «Шаблон из РКК.xlsx»', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-testid=conv-download]')
    ]);
    expect(download.suggestedFilename()).toBe('Шаблон из РКК.xlsx');
  });

  test('живой РКК пользователя (локально) конвертируется без ошибок', async ({ page }) => {
    test.skip(!hasLocal('rkk-live.xlsx'), 'локальный РКК.xlsx не найден — тест только для машины с реальным файлом');
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await loadRkk(page, 'local/rkk-live.xlsx');
    const r = await result(page);
    expect(r.rowCount).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

test('покрытие кода конвертера', async ({ page }) => {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto(convUrl);
  await page.waitForFunction(() => !!window.__converter);
  await page.setInputFiles('[data-testid=conv-file]', fixture('rkk-sample.xlsx'));
  await page.waitForFunction(() => !!window.__convState.result);
  await page.click('[data-testid=conv-preview-toggle]');
  await page.click('[data-testid=conv-download]').catch(() => {});
  // ветка ошибки: файл, который не является xlsx
  await page.setInputFiles('[data-testid=conv-file]', fixture('broken.xlsx'));
  await page.waitForSelector('[data-testid=conv-report] .alert.critical');
  await page.setInputFiles('[data-testid=conv-file]', fixture('rkk-sample.xlsx'));

  const coverage = await page.coverage.stopJSCoverage();
  const entry = coverage.find((c) => c.url.includes('gantt-converter'));
  expect(entry, 'покрытие скрипта конвертера найдено').toBeTruthy();

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
  const size = (iv) => iv.reduce((s, [a, b]) => s + (b - a), 0);
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
  const pct = (size(subtract(merge(hit), missed)) / size(merge(all))) * 100;
  console.log(`покрытие gantt-converter.js: ${pct.toFixed(1)}%`);
  expect(pct).toBeGreaterThan(85);
});

test.describe('выход конвертера работает в Ганте', () => {
  test('сконвертированный файл грузится, фазы одного стека идут подряд', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const aoa = await page.evaluate(() => window.__convState.result.aoa);

    // строим xlsx из того же AOA, что отдаёт кнопка выгрузки
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Задачи');
    const dir = mkdtempSync(join(tmpdir(), 'gantt-conv-'));
    const file = join(dir, 'Шаблон из РКК.xlsx');
    XLSX.writeFile(wb, file);

    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);

    const s = await schedule(page);
    expect(s.tasks.length).toBe(37);

    // задача с двумя исполнителями на одном стеке: фазы одного стека идут подряд
    const double = s.tasks.find((t) => t.phases.filter((p) => p.stack === 'net').length === 2);
    expect(double).toBeTruthy();
    const netIdx = double.phases.map((p, i) => (p.stack === 'net' ? i : -1)).filter((i) => i >= 0);
    expect(netIdx[1]).toBe(netIdx[0] + 1); // соседние позиции в цепочке фаз
    expect(double.phases[netIdx[0]].executor).not.toBe(double.phases[netIdx[1]].executor);

    // обе фазы стека являются соседними по времени
    expect(double.phases[netIdx[1]].startPos).toBeCloseTo(double.phases[netIdx[0]].endPos, 6);

    // рендер обеих фаз одного стека: идентификаторы разведены
    await expect(page.locator(`[data-testid=seg-${double.num}-net-1]`)).toBeVisible();
    await expect(page.locator(`[data-testid=seg-${double.num}-net-2]`)).toBeVisible();

    // исполнитель не ведёт больше двух задач
    for (const l of s.load) expect(l.peak).toBeLessThanOrEqual(2);
  });
});

test.describe('синонимы стеков', () => {
  test('TS / Front / front — один стек, C# / .Net — один стек', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const res = await page.evaluate(() => {
      const f = (v) => window.__converter.normalizeStackKey(v);
      return {
        ts: f('TS'), front: f('Front'), frontLower: f('front'), frontRu: f('Фронт'),
        csharp: f('C#'), dotnet: f('.Net'), net: f('net'), dotnetRu: f('Дотнет'), dotnetWord: f('dotnet'),
        cpp: f('C++'), py: f('Python'), pyRu: f('Питон'),
        unknown: f('meth'), empty: f('')
      };
    });
    expect(res.ts).toBe('front');
    expect(res.front).toBe('front');
    expect(res.frontLower).toBe('front');
    expect(res.frontRu).toBe('front');
    expect(res.csharp).toBe('net');
    expect(res.dotnet).toBe('net');
    expect(res.net).toBe('net');
    expect(res.dotnetRu).toBe('net');
    expect(res.dotnetWord).toBe('net');
    expect(res.cpp).toBe('cpp');
    expect(res.py).toBe('py');
    expect(res.pyRu).toBe('py');
    expect(res.unknown).toBeNull();
    expect(res.empty).toBeNull();
  });

  test('человек с «C# / .Net» не считается multi-skill', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx'); // страница с SheetJS должна быть открыта
    // файл с таблицей скиллов, где один и тот же стек написан по-разному
    const aoa = [
      ['ФИО', 'Стек / роль'],
      ['Иванов Иван', 'C# / .Net'],
      ['Петров Пётр', 'TS / Front']
    ];
    const res = await page.evaluate((rows) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Скиллы');
      const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      // соберём минимальный РКК: скиллы в строках 4-36, имена исполнителей в 48, часы в 60
      const rows2 = [];
      const set = (r, c, v) => {
        while (rows2.length < r) rows2.push([]);
        const row = rows2[r - 1];
        while (row.length < c) row.push(null);
        row[c - 1] = v;
      };
      set(4, 8, 'Иванов Иван'); set(4, 9, 'C# / .Net');
      set(5, 8, 'Петров Пётр'); set(5, 9, 'TS / Front');
      set(48, 33, 'Иванов'); set(48, 34, 'Петров'); // AG, AH
      set(60, 8, 'ТТ 1: задача'); set(60, 1, 1);
      set(60, 33, 16); set(60, 34, 8);
      const ws2 = XLSX.utils.aoa_to_sheet(rows2);
      const wb2 = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb2, ws2, '26 4к');
      const data2 = XLSX.write(wb2, { type: 'array', bookType: 'xlsx' });
      const out = window.__converter.convertRkkToTemplate(data2);
      return { header: out.aoa[0], row: out.aoa[1], multiSkill: out.report.multiSkill, dropped: out.report.droppedSkills };
    }, aoa);
    // «C# / .Net» -> один стек Дотнет, «TS / Front» -> один стек Фронт
    expect(res.multiSkill).toEqual([]);
    expect(res.dropped).toEqual([]);
    const h = res.header;
    const val = (name) => res.row[h.indexOf(name)];
    expect(val('Дотнет, ч')).toBe(16);
    expect(val('Исполнитель дотнет')).toBe('Иванов');
    expect(val('Фронт, ч')).toBe(8);
    expect(val('Исполнитель фронт')).toBe('Петров');
  });

  test('Гант понимает синонимы в дополнительных тройках', async ({ page }) => {
    const aoa = [
      ['Номер', 'Приоритет', 'Название', 'Общая длительность, дн',
        'Начало базовое', 'Окончание базовое', 'Начало фактическое', 'Окончание фактическое',
        'Оценка SP', 'C++, ч', 'Исполнитель C++', 'Питон, ч', 'Исполнитель питон',
        'Дотнет, ч', 'Исполнитель дотнет', 'Фронт, ч', 'Исполнитель фронт',
        'Стек (доп.)', 'Часы (доп.)', 'Исполнитель (доп.)'],
      [1, 1, 'Задача с синонимами', null, null, null, null, null, null,
        null, null, null, null, 40, 'Иванов', null, null,
        'TS', 8, 'Петров']
    ];
    const file = writeAoaToTempFile(aoa);
    await page.goto(appUrl);
    await page.waitForFunction(() => !!window.__gantt);
    await page.setInputFiles('[data-testid=file-input]', file);
    await page.waitForFunction(() => !!window.__gantt.state.sched);
    const s = await schedule(page);
    expect(s.tasks[0].phases.map((p) => p.stack)).toEqual(['net', 'front']);
    expect(s.tasks[0].phases[1].executor).toBe('Петров');
    await expect(page.locator('[data-testid=seg-1-front]')).toBeVisible();
  });
});

test.describe('мультистек уступает стек моно-исполнителю', () => {
  test('assignStacks: мультистек берёт стек, который моно не может', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const res = await page.evaluate(() => {
      const out = window.__converter.assignStacks([
        { executor: 'Мульти', hours: 10, skills: ['net', 'py'] },
        { executor: 'Моно', hours: 20, skills: ['net'] }
      ]);
      return out.map((a) => ({ executor: a.executor, stack: a.stack, reason: a.reason }));
    });
    const multi = res.find((a) => a.executor === 'Мульти');
    const mono = res.find((a) => a.executor === 'Моно');
    expect(mono.stack).toBe('net');
    expect(multi.stack).toBe('py');
    expect(multi.reason).toBe('стек не занят моно-исполнителем');
  });

  test('assignStacks: если все стеки мультистекового заняты — берётся первый', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const res = await page.evaluate(() => window.__converter.assignStacks([
      { executor: 'Моно1', hours: 8, skills: ['net'] },
      { executor: 'Моно2', hours: 8, skills: ['py'] },
      { executor: 'Мульти', hours: 8, skills: ['net', 'py'] }
    ]));
    const multi = res.find((a) => a.executor === 'Мульти');
    expect(multi.stack).toBe('net');
    expect(multi.reason).toBe('все стеки заняты, взят первый');
  });

  test('assignStacks: свободный стек, не занятый моно, но занятый другим мульти', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const res = await page.evaluate(() => window.__converter.assignStacks([
      { executor: 'Моно', hours: 8, skills: ['net'] },
      { executor: 'Мульти1', hours: 8, skills: ['net', 'front'] },
      { executor: 'Мульти2', hours: 8, skills: ['front', 'cpp'] }
    ]));
    const m1 = res.find((a) => a.executor === 'Мульти1');
    const m2 = res.find((a) => a.executor === 'Мульти2');
    expect(m1.stack).toBe('front'); // net занят моно
    expect(m2.stack).toBe('cpp'); // front уже занят Мульти1, а cpp свободен
    expect(m2.reason).toBe('стек не занят моно-исполнителем');
  });

  test('в файле: мультистек уходит со стека моно-исполнителя', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const out = await page.evaluate(() => {
      // скиллы: Иванов умеет C# и Python, Петров - только C#
      const rows = [];
      const set = (r, c, v) => {
        while (rows.length < r) rows.push([]);
        const row = rows[r - 1];
        while (row.length < c) row.push(null);
        row[c - 1] = v;
      };
      set(4, 8, 'Иванов Иван'); set(4, 9, 'C# / Python');
      set(5, 8, 'Петров Пётр'); set(5, 9, 'C#');
      set(48, 33, 'Иванов'); set(48, 34, 'Петров'); // AG, AH
      set(60, 8, 'ТТ 1: задача'); set(60, 1, 1);
      set(60, 33, 40); set(60, 34, 10); // Иванов 40 ч, Петров 10 ч
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '26 4к');
      const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      return window.__converter.convertRkkToTemplate(data);
    });
    const val = (name) => out.aoa[1][out.aoa[0].indexOf(name)];
    // Петров (только C#) делает Дотнет, Иванов (C# + Python) уходит в Питон
    expect(val('Дотнет, ч')).toBe(10);
    expect(val('Исполнитель дотнет')).toBe('Петров');
    expect(val('Питон, ч')).toBe(40);
    expect(val('Исполнитель питон')).toBe('Иванов');
    expect(out.report.multiSkill[0]).toMatchObject({ executor: 'Иванов', chosen: 'py' });
  });

  test('без моно-исполнителя мультистек берёт первый свой стек', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const out = await page.evaluate(() => {
      const rows = [];
      const set = (r, c, v) => {
        while (rows.length < r) rows.push([]);
        const row = rows[r - 1];
        while (row.length < c) row.push(null);
        row[c - 1] = v;
      };
      set(4, 8, 'Иванов Иван'); set(4, 9, 'C# / Python');
      set(48, 33, 'Иванов');
      set(60, 8, 'ТТ 1: задача'); set(60, 1, 1);
      set(60, 33, 40);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '26 4к');
      const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      return window.__converter.convertRkkToTemplate(data);
    });
    const val = (name) => out.aoa[1][out.aoa[0].indexOf(name)];
    expect(val('Дотнет, ч')).toBe(40); // C# идёт первым в списке скиллов
    expect(val('Питон, ч')).toBeNull();
  });
});

test('краевые случаи отчёта: пустая строка, неизвестный исполнитель, чужие роли', async ({ page }) => {
  await loadRkk(page, 'rkk-sample.xlsx');
  const out = await page.evaluate(() => {
    const rows = [];
    const set = (r, c, v) => {
      while (rows.length < r) rows.push([]);
      const row = rows[r - 1];
      while (row.length < c) row.push(null);
      row[c - 1] = v;
    };
    set(4, 8, 'Иванов Иван'); set(4, 9, 'C# / Python');   // мультистек
    set(5, 8, 'Тестов Тест'); set(5, 9, 'Тест');          // роль вне 4 стеков
    set(48, 33, 'Иванов'); set(48, 34, 'Тестов'); set(48, 35, 'Никто'); // AG, AH, AI
    set(60, 8, 'ТТ 1: первая'); set(60, 1, 1); set(60, 33, 8); set(60, 34, 4); set(60, 35, 5);
    set(61, 8, 'ТТ 2: вторая'); set(61, 1, 2); set(61, 33, 8); // тот же мультистек -> дедуп отчёта
    set(62, 8, ''); // пустая строка внутри диапазона
    set(63, 8, 'Фронт автокорректировки'); // разделитель
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '26 4к');
    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const res = window.__converter.convertRkkToTemplate(data);
    return { report: res.report, rows: res.aoa.slice(1).map((r) => [r[0], r[2], r[13], r[14], r[16], r[17]]) };
  });
  // пустая строка в середине и разделитель попали в отчёт, хвост диапазона - нет
  expect(out.report.skipped).toEqual([
    { row: 62, reason: 'пустая строка' },
    { row: 63, name: 'Фронт автокорректировки', reason: 'не задача (разделитель)' }
  ]);
  // исполнитель без записи в таблице H/I
  expect(out.report.unknownExecutor).toEqual([{ row: 60, name: 'ТТ 1: первая', executor: 'Никто' }]);
  // роль «Тест» не мапится на 4 стека
  expect(out.report.unmapped).toEqual([
    { row: 60, name: 'ТТ 1: первая', executor: 'Тестов', skills: 'Тест', hours: 4 }
  ]);
  // одна и та же мультистековая запись по двум задачам схлопывается в одну строку с count=2
  expect(out.report.multiSkill.length).toBe(1);
  expect(out.report.multiSkill[0].count).toBe(2);
  // задачи без часов нет: строки с непустым названием переносятся
  expect(out.report.noHours).toEqual([]);
});

test.describe('инвариант: мультистек не встаёт на стек моно-исполнителя', () => {
  for (const file of ['rkk-sample.xlsx']) {
    test(`проверка на ${file}`, async ({ page }) => {
      await loadRkk(page, file);
      const bad = await page.evaluate(() => {
        const out = [];
        for (const t of window.__convState.result.tasks) {
          const mono = t.assignments.filter((a) => a.skills.length === 1);
          const multi = t.assignments.filter((a) => a.skills.length > 1);
          const monoStacks = new Set(mono.map((a) => a.stack));
          for (const m of multi) {
            const clashes = mono.filter((s) => s.stack === m.stack);
            if (!clashes.length) continue;
            // допустимо, только если все стеки мультистекового и так заняты моно
            const forced = m.skills.every((sk) => monoStacks.has(sk));
            if (!forced) {
              out.push(`${t.name}: ${m.executor} (${m.skills.join('/')}) на стеке ${m.stack}, `
                + `хотя его делает ${clashes.map((c) => c.executor).join(', ')}`);
            }
          }
        }
        return out;
      });
      expect(bad).toEqual([]);
    });
  }

  test('мультистек Соколов уходит с питона, когда питон делает моно-исполнитель', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const res = await page.evaluate(() => {
      const r = window.__convState.result;
      const idx = (n) => r.aoa[0].indexOf(n);
      return r.aoa.slice(1).filter((row) => row.some((v) => v === 'Соколов')).map((row) => ({
        n: row[0],
        name: String(row[2]).slice(0, 30),
        onCpp: row[idx('Исполнитель C++')] === 'Соколов',
        onPy: row[idx('Исполнитель питон')] === 'Соколов',
        onNet: row[idx('Исполнитель дотнет')] === 'Соколов'
      })).filter((x) => x.onCpp || x.onPy || x.onNet);
    });
    expect(res.length).toBeGreaterThan(0);
    // на задачах, где рядом есть чистый питонщик, Соколов не занимает питон вместе с ним
    const withMonoPy = await page.evaluate(() => {
      const r = window.__convState.result;
      const idx = (n) => r.aoa[0].indexOf(n);
      return r.aoa.slice(1).filter((row) => row[idx('Исполнитель питон')] === 'Соколов'
        && row.some((v, i) => i !== idx('Исполнитель питон') && v === 'Лебедев')).length;
    });
    expect(withMonoPy).toBe(0);
  });
});

test.describe('«Не раньше»: готовность ТТ', () => {
  const RKK_HEAD = ['Номер', 'Приоритет', 'Название', 'Общая длительность, дн',
    'Начало базовое', 'Окончание базовое', 'Начало фактическое', 'Окончание фактическое',
    'Оценка SP', 'C++, ч', 'Исполнитель C++', 'Питон, ч', 'Исполнитель питон',
    'Дотнет, ч', 'Исполнитель дотнет', 'Фронт, ч', 'Исполнитель фронт'];

  async function convertSynthetic(page, opts) {
    return page.evaluate(({ rowsSpec }) => {
      const rows = [];
      const set = (r, c, v) => {
        while (rows.length < r) rows.push([]);
        const row = rows[r - 1];
        while (row.length < c) row.push(null);
        row[c - 1] = v;
      };
      set(4, 8, 'Иванов Иван'); set(4, 9, 'C++');
      set(48, 33, 'Иванов');
      rowsSpec.forEach((spec) => {
        set(spec.row, 8, spec.name);
        set(spec.row, 1, spec.priority ?? 1);
        set(spec.row, 5, spec.ready ?? null); // колонка E - Готовность ТТ
        set(spec.row, 33, spec.hours ?? 8);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '26 4к');
      const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const out = window.__converter.convertRkkToTemplate(data);
      const idx = out.aoa[0].indexOf('Не раньше');
      return {
        header: out.aoa[0],
        notBefore: out.aoa.slice(1).map((r) => (r[idx] instanceof Date ? r[idx].toISOString().slice(0, 10) : r[idx])),
        defaulted: out.report.notBeforeDefault,
        today: window.__converter.excelDateValue(new Date()).toISOString().slice(0, 10),
        weekFromToday: new Date(window.__converter.excelDateValue(new Date()).getTime() + 7 * 86400000).toISOString().slice(0, 10)
      };
    }, opts);
  }

  test('дата из колонки E становится ограничением начала', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const out = await convertSynthetic(page, { rowsSpec: [
      { row: 60, name: 'ТТ 1', ready: new Date(Date.UTC(2026, 11, 1)) }
    ] });
    expect(out.header).toContain('Не раньше');
    expect(out.notBefore).toEqual(['2026-12-01']);
    expect(out.defaulted).toEqual([]);
  });

  test('пустая E и «не готово» сдвигают начало на неделю от сегодня', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const out = await convertSynthetic(page, { rowsSpec: [
      { row: 60, name: 'ТТ 1 пусто', ready: null },
      { row: 61, name: 'ТТ 2 не готово', ready: 'не готово' }
    ] });
    expect(out.notBefore).toEqual([out.weekFromToday, out.weekFromToday]);
    expect(out.defaulted.length).toBe(2);
    expect(out.defaulted.map((d) => d.ready)).toEqual(['пусто', 'не готово']);
  });

  test('колонка заполнена у всех задач', async ({ page }) => {
    await loadRkk(page, 'rkk-sample.xlsx');
    const res = await page.evaluate(() => {
      const r = window.__convState.result;
      const idx = r.aoa[0].indexOf('Не раньше');
      const empty = r.aoa.slice(1).filter((row) => !(row[idx] instanceof Date));
      return {
        headerIdx: idx,
        emptyRows: empty.map((row) => row[0]),
        defaulted: r.report.notBeforeDefault.length,
        sample: r.aoa.slice(1, 4).map((row) => row[idx].toISOString().slice(0, 10))
      };
    });
    expect(res.headerIdx).toBe(17); // сразу после 17 стандартных колонок
    expect(res.emptyRows).toEqual([]); // у каждой задачи есть дата
    expect(res.defaulted).toBeGreaterThan(0); // часть уехала на неделю от сегодня
    expect(res.sample.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });
});

test('даты плана из колонок F/G уходят в базовые колонки шаблона', async ({ page }) => {
  await loadRkk(page, 'rkk-sample.xlsx');
  const out = await page.evaluate(() => {
    const rows = [];
    const set = (r, c, v) => {
      while (rows.length < r) rows.push([]);
      const row = rows[r - 1];
      while (row.length < c) row.push(null);
      row[c - 1] = v;
    };
    set(4, 8, 'Иванов Иван'); set(4, 9, 'C++');
    set(48, 33, 'Иванов');
    set(60, 8, 'ТТ 1: с планом'); set(60, 1, 1); set(60, 33, 8);
    set(60, 5, new Date(Date.UTC(2026, 10, 30)));  // E готовность
    set(60, 6, new Date(Date.UTC(2026, 11, 14)));  // F дата начала
    set(60, 7, new Date(Date.UTC(2026, 11, 28)));  // G дата окончания
    set(61, 8, 'ТТ 2: без плана'); set(61, 1, 2); set(61, 33, 8);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '26 4к');
    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const res = window.__converter.convertRkkToTemplate(data);
    const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    return {
      row1: [iso(res.aoa[1][4]), iso(res.aoa[1][5]), iso(res.aoa[1][17])],
      row2: [iso(res.aoa[2][4]), iso(res.aoa[2][5])],
      report: res.report.planDates
    };
  });
  // базовое начало/окончание = F/G из РКК, «Не раньше» = E
  expect(out.row1).toEqual(['2026-12-14', '2026-12-28', '2026-11-30']);
  expect(out.row2).toEqual([null, null]);
  expect(out.report.count).toBe(1);
  expect(out.report.missing).toEqual([{ row: 61, name: 'ТТ 2: без плана' }]);
});
