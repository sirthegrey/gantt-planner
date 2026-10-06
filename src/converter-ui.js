'use strict';

/* UI конвертера: загрузка РКК, отчёт, предпросмотр, выгрузка шаблона. */

const convState = {
  fileName: null,
  result: null
};

// Тестовый доступ к состоянию конвертера.
if (typeof window !== 'undefined') window.__convState = convState;

function convBoot() {
  const input = document.getElementById('conv-file');
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await convLoad(await file.arrayBuffer(), file.name);
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    await convLoad(await file.arrayBuffer(), file.name);
  });

  document.getElementById('conv-download').addEventListener('click', convDownload);
  document.getElementById('conv-preview-toggle').addEventListener('change', (e) => {
    document.getElementById('conv-preview').hidden = !e.target.checked;
    if (e.target.checked) convRenderPreview();
  });
  convRenderEmpty();
}

async function convLoad(buffer, fileName) {
  convState.fileName = fileName;
  try {
    convState.result = convertRkkToTemplate(buffer);
  } catch (err) {
    convState.result = null;
    document.getElementById('conv-report').innerHTML =
      `<div class="alert critical">Не удалось разобрать файл: ${String(err.message || err)}</div>`;
    return;
  }
  convRenderReport();
  convRenderPreview();
}

function convRenderEmpty() {
  document.getElementById('conv-report').innerHTML =
    '<div class="alert info">Загрузите РКК.xlsx — конвертер соберёт файл в формате Шаблон.xlsx</div>';
  document.getElementById('conv-download').disabled = true;
}

function convTaskSummary(tasks) {
  let phases = 0;
  let noPhase = 0;
  for (const t of tasks) {
    phases += t.assignments.length;
    if (!t.assignments.length) noPhase++;
  }
  return { tasks: tasks.length, phases, noPhase };
}

function convRenderReport() {
  const r = convState.result;
  if (!r) return;
  const el = document.getElementById('conv-report');
  el.innerHTML = '';
  const { tasks, phases, noPhase } = convTaskSummary(r.tasks);

  const add = (cls, text) => {
    const d = document.createElement('div');
    d.className = 'alert ' + cls;
    d.textContent = text;
    el.appendChild(d);
  };

  add('ok', `Лист «${r.sheetName}»: задач ${tasks}, фаз ${phases}, дополнительных троек колонок ${r.maxExtra}`);
  if (noPhase) add('warning', `Задач без часов: ${noPhase} — попадут в Гант с пометкой «нет фаз»`);

  const listBlock = (title, items, fmt) => {
    if (!items.length) return;
    const box = document.createElement('div');
    box.className = 'panel';
    const h = document.createElement('h4');
    h.textContent = `${title} (${items.length})`;
    box.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'conv-list';
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = fmt(it);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    el.appendChild(box);
  };

  const plan = r.report.planDates;
  if (plan.missing.length) {
    add('warning', `Без дат плана (F/G): ${plan.missing.length} задач — на диаграмме они пойдут как можно раньше, ограничение только готовность ТТ`);
  } else {
    add('ok', `Даты плана перенесены в базовые колонки у ${plan.count} задач`);
  }
  const defaulted = r.report.notBeforeDefault;
  if (defaulted.length) {
    add('info', `Готовность ТТ не заполнена у ${defaulted.length} задач — начало сдвинуто на неделю от сегодня (${defaulted[0].notBefore})`);
  }
  listBlock('Без даты готовности ТТ (сдвиг на неделю)', defaulted,
    (s) => `стр. ${s.row}: ${s.name.slice(0, 60)} — в колонке E ${s.ready}, начало не раньше ${s.notBefore}`);
  listBlock('Пропущенные строки', r.report.skipped, (s) => `стр. ${s.row}: ${s.name || '—'} — ${s.reason}`);
  listBlock('Часы вне 4 стеков', r.report.unmapped, (s) => `стр. ${s.row}: ${s.executor} (${s.skills}) ${s.hours} ч — ${s.name}`);
  listBlock('Исполнители не найдены в таблице H/I', r.report.unknownExecutor, (s) => `стр. ${s.row}: ${s.executor} — ${s.name}`);
  listBlock('Роли вне 4 стеков (отброшены)', r.report.droppedSkills,
    (s) => `${s.executor}: «${s.skills}» → отброшено: ${s.dropped}`);
  listBlock('Несколько стеков у исполнителя (стек выбран автоматически)',
    r.report.multiSkill, (s) => `${s.executor}: «${s.skills}» → ${s.chosen} — ${s.reason} (задач: ${s.count})`);

  document.getElementById('conv-download').disabled = false;
}

function convRenderPreview() {
  const box = document.getElementById('conv-preview');
  if (!convState.result) {
    box.textContent = 'Файл не загружен';
    return;
  }
  const { aoa } = convState.result;
  box.innerHTML = '';
  const table = document.createElement('table');
  const header = document.createElement('tr');
  for (const h of aoa[0]) {
    const th = document.createElement('th');
    th.textContent = h;
    header.appendChild(th);
  }
  table.appendChild(header);
  for (const row of aoa.slice(1, 26)) {
    const tr = document.createElement('tr');
    for (let i = 0; i < aoa[0].length; i++) {
      const td = document.createElement('td');
      td.textContent = row[i] === null || row[i] === undefined ? '' : row[i];
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  box.appendChild(table);
  const note = document.createElement('div');
  note.className = 'muted';
  note.textContent = `Показаны первые ${Math.min(25, aoa.length - 1)} из ${aoa.length - 1} строк`;
  box.appendChild(note);
}

function convDownload() {
  if (!convState.result) return;
  const buffer = aoaToWorkbookBuffer(convState.result.aoa);
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Шаблон из РКК.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

if (typeof document !== 'undefined' && document.getElementById('converter')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', convBoot);
  } else {
    convBoot();
  }
}
