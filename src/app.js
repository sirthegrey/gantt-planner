'use strict';

/* Application shell: file loading, controls, inspector, holiday editor. */

const HOLIDAY_STORAGE_KEY = 'gantt.rf-holidays.v1';
const ABSENCE_STORAGE_KEY = 'gantt.absences.v1';

const state = {
  raw: null,        // {tasks, skipped, warnings}
  sched: null,      // schedule result
  cal: Calendar,
  holidays: [...DEFAULT_HOLIDAYS],
  absences: [], // [{executor, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD'}]
  zoom: 'week',
  showBaseline: true,
  respectBaseline: true, // true = задача не начинается раньше дат плана из файла
  selectedIndex: null,
  filter: { executor: '', query: '' },
  warnings: []
};

/** Совпадает ли задача с фильтром «исполнитель + часть названия». */
function matchesFilter(task, filter) {
  if (!filter) return true;
  if (filter.executor) {
    const has = task.phases.some((ph) => ph.executor === filter.executor);
    if (!has) return false;
  }
  const query = (filter.query || '').trim().toLowerCase();
  if (query && !String(task.name).toLowerCase().includes(query)) return false;
  return true;
}

/** Задачи, прошедшие фильтр (с их идентификаторами строк). */
function visibleTasks(state) {
  const ids = uniqueIds(state.sched.tasks);
  const out = [];
  state.sched.tasks.forEach((task, index) => {
    if (matchesFilter(task, state.filter)) out.push({ task, index, id: ids[index] });
  });
  return out;
}

// ---------------------------------------------------------------- persistence

function loadStoredHolidays() {
  try {
    const raw = localStorage.getItem(HOLIDAY_STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) : null;
  } catch (e) {
    return null;
  }
}

function storeHolidays() {
  try {
    localStorage.setItem(HOLIDAY_STORAGE_KEY, JSON.stringify(state.holidays));
  } catch (e) { /* storage may be unavailable under file:// in some browsers */ }
}

function loadStoredAbsences() {
  try {
    const raw = localStorage.getItem(ABSENCE_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((a) => a && typeof a.executor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.from) && /^\d{4}-\d{2}-\d{2}$/.test(a.to));
  } catch (e) {
    return [];
  }
}

function storeAbsences() {
  try {
    localStorage.setItem(ABSENCE_STORAGE_KEY, JSON.stringify(state.absences));
  } catch (e) { /* ignore */ }
}

/** Executor names found in the loaded file, used by the absence editor. */
function executorsInProject() {
  if (!state.raw) return [];
  const names = new Set();
  for (const t of state.raw.tasks) {
    for (const p of t.phases) names.add(p.executor);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'ru'));
}

// ------------------------------------------------------------------ pipeline

function loadArrayBuffer(buffer, fileName) {
  const parsed = parseWorkbook(buffer);
  state.raw = parsed;
  state.fileName = fileName;
  rebuild();
  return parsed;
}

function rebuild() {
  if (!state.raw) return;
  state.cal.init(state.holidays);

  const dates = [];
  for (const t of state.raw.tasks) {
    for (const d of [t.baselineStart, t.baselineFinish, t.actualStart, t.actualFinish]) {
      if (d) dates.push(d.getTime());
    }
  }
  const min = dates.length ? new Date(Math.min(...dates)) : new Date();
  const max = dates.length ? new Date(Math.max(...dates)) : new Date();
  // Запас влево: если у задачи есть только базовое окончание, её начало
  // отсчитывается назад на длительность всех фаз и может уйти раньше самой
  // ранней даты файла.
  let maxTotalDays = 0;
  for (const t of state.raw.tasks) {
    const days = t.phases.reduce((sum, p) => sum + p.hours / HOURS_PER_DAY, 0);
    maxTotalDays = Math.max(maxTotalDays, days);
  }
  const padDays = Math.ceil(maxTotalDays * 1.5) + 14;
  state.cal.build(new Date(min.getTime() - padDays * 86400000), max);

  state.sched = scheduleProject(state.raw.tasks, state.cal, {
    respectBaseline: state.respectBaseline,
    absences: state.absences
  });
  state.sched.projectStartDate = state.cal.dateOf(state.sched.projectStartPos);
  state.warnings = [...state.raw.warnings, ...buildWarnings(state.sched, state.cal)];
  renderAll();
}

function renderAll() {
  renderGantt(document.getElementById('gantt'), state);
  renderTable(document.getElementById('table-view'), state);
  renderAlerts();
  renderInspector();
  renderHolidayList();
  renderAbsenceList();
  renderExecutorOptions();
  renderFilterOptions();
  renderFilterCount();
  renderStats();
}

// --------------------------------------------------------------------- stats

function renderStats() {
  const box = document.getElementById('stats');
  if (!state.sched) {
    box.textContent = 'Файл не загружен';
    return;
  }
  const s = state.sched;
  const starts = s.tasks.filter((t) => t.computedStart).map((t) => t.computedStart.getTime());
  const finishes = s.tasks.filter((t) => t.computedFinish).map((t) => t.computedFinish.getTime());
  const from = starts.length ? new Date(Math.min(...starts)) : null;
  const to = finishes.length ? new Date(Math.max(...finishes)) : null;
  const file = state.fileName ? state.fileName + ' · ' : '';
  box.textContent = `${file}Задач: ${s.tasks.length} · исполнителей: ${s.executors.size} · расчёт: ${fmtDate(from)} — ${fmtDate(to)}`;
}

/* Уровни и подписи предупреждений: цвет не должен быть единственным
   признаком (он же используется для стеков), поэтому у каждой группы есть
   иконка и текстовая подпись. */
const ALERT_LEVELS = [
  { key: 'critical', title: 'Ошибки', icon: '⛔' },
  { key: 'warning', title: 'Предупреждения', icon: '⚠' },
  { key: 'info', title: 'Замечания', icon: 'ⓘ' }
];

const ALERT_META = {
  'wrong-format': { level: 'critical', label: 'Формат файла' },
  overload: { level: 'critical', label: 'Перегруз' },
  'over-plan': { level: 'warning', label: 'Перерасход плана' },
  priority: { level: 'warning', label: 'Нарушение приоритета' },
  'over-baseline': { level: 'info', label: 'Выход за базовый план' },
  'missing-executor': { level: 'info', label: 'Нет исполнителя' },
  'no-phases': { level: 'info', label: 'Нет фаз' }
};

const ALERTS_SHOWN_PER_GROUP = 3;
const expandedGroups = new Set();

function alertLevel(kind) {
  return (ALERT_META[kind] || { level: 'info' }).level;
}

function renderAlerts() {
  const box = document.getElementById('alerts');
  box.innerHTML = '';
  const summary = document.getElementById('alerts-summary');
  if (!state.warnings.length) {
    if (summary) summary.textContent = 'Проверка пройдена';
    box.appendChild(el('div', 'alert ok', 'Предупреждений нет'));
    return;
  }

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const w of state.warnings) counts[alertLevel(w.kind)]++;
  if (summary) {
    summary.textContent = `${counts.critical} ошибок · ${counts.warning} предупреждений · ${counts.info} замечаний`;
  }

  for (const level of ALERT_LEVELS) {
    const items = state.warnings.filter((w) => alertLevel(w.kind) === level.key);
    if (!items.length) continue;
    const group = el('div', 'alert-group ' + level.key);
    group.setAttribute('data-testid', 'alert-group-' + level.key);

    const head = el('div', 'alert-group-head');
    head.appendChild(el('span', 'alert-icon', level.icon));
    head.appendChild(el('span', 'alert-title', level.title));
    head.appendChild(el('span', 'badge', String(items.length)));
    group.appendChild(head);

    const body = el('div', 'alert-group-body');
    const expanded = expandedGroups.has(level.key) || items.length <= ALERTS_SHOWN_PER_GROUP;
    const visible = expanded ? items : items.slice(0, ALERTS_SHOWN_PER_GROUP);
    for (const w of visible) body.appendChild(alertItem(w));

    if (!expanded) {
      const more = el('button', 'btn small', `Показать все (${items.length})`);
      more.setAttribute('data-testid', 'alert-expand-' + level.key);
      more.addEventListener('click', () => {
        expandedGroups.add(level.key);
        renderAlerts();
      });
      body.appendChild(more);
    }
    group.appendChild(body);
    box.appendChild(group);
  }
}

function alertItem(w) {
  const meta = ALERT_META[w.kind] || {};
  const div = el('div', 'alert ' + alertLevel(w.kind));
  div.setAttribute('data-testid', 'alert-' + w.kind);
  // подпись уровня дублировала бы текст, если сообщение начинается с неё же
  const label = meta.label && !w.message.toLowerCase().startsWith(meta.label.toLowerCase());
  if (label) div.appendChild(el('span', 'alert-kind', meta.label + ': '));
  div.appendChild(el('span', 'alert-text', w.message));
  if (w.taskNum != null) {
    div.classList.add('clickable');
    div.setAttribute('data-task-num', String(w.taskNum));
    div.title = 'Показать задачу на диаграмме';
    div.addEventListener('click', () => selectTaskByNum(w.taskNum));
  }
  return div;
}

/** Выбор задачи по номеру: подсветка строки, инспектор и прокрутка к ней. */
function selectTaskByNum(num) {
  const index = state.sched ? state.sched.tasks.findIndex((t) => t.num === num) : -1;
  if (index < 0) return;
  // Задача может быть скрыта фильтром - тогда показываем её, сняв фильтр,
  // иначе подсветка ушла бы в никуда.
  if (!matchesFilter(state.sched.tasks[index], state.filter)) {
    state.filter = { executor: '', query: '' };
    resetFilterInputs();
    rebuild();
  }
  state.selectedIndex = index;
  renderAll();
  const row = document.querySelector(`.row[data-index="${index}"]`);
  if (row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ----------------------------------------------------------------- inspector

function renderInspector() {
  const box = document.getElementById('inspector');
  box.innerHTML = '';
  if (!state.sched) return;
  const task = state.sched.tasks[state.selectedIndex];
  if (!task) {
    box.setAttribute('data-testid', 'inspector-empty');
    box.appendChild(el('div', 'muted', 'Выберите задачу на диаграмме'));
    return;
  }
  box.setAttribute('data-testid', 'inspector');
  const header = el('div', 'inspector-head');
  header.appendChild(el('h3', null, `${task.num}. ${task.name}`));
  const close = el('button', 'mini', '×');
  close.title = 'Закрыть (Esc)';
  close.setAttribute('aria-label', 'Закрыть карточку задачи');
  close.setAttribute('data-testid', 'inspector-close');
  close.addEventListener('click', () => {
    state.selectedIndex = null;
    renderAll();
  });
  header.appendChild(close);
  box.appendChild(header);

  const info = el('div', 'row-meta');
  const prioHint = task.priority === 1 ? ' (высший)' : '';
  info.textContent = `Приоритет ${task.priority}${prioHint} · план ${task.durationDays ?? '—'} дн · расчёт ${task.computedSpanDays != null ? task.computedSpanDays.toFixed(2) + ' раб. дн' : '—'}`;
  box.appendChild(info);

  box.appendChild(el('h4', null, 'Порядок фаз'));
  const list = el('div', 'phase-list');
  const occurrences = new Map();
  task.phases.forEach((ph, i) => {
    const total = task.phases.filter((p) => p.stack === ph.stack).length;
    const k = (occurrences.get(ph.stack) || 0) + 1;
    occurrences.set(ph.stack, k);
    const suffix = total > 1 ? `-${k}` : '';
    const item = el('div', 'phase-item');
    item.setAttribute('data-testid', `phase-${task.num}-${ph.stack}${suffix}`);
    const dot = el('span', 'dot');
    dot.style.background = stackColorVar(ph.series);
    item.appendChild(dot);
    item.appendChild(el('span', 'phase-name', `${i + 1}. ${ph.label} — ${ph.executor}, ${ph.hours} ч`));
    const up = el('button', 'mini', '↑');
    up.setAttribute('data-testid', `phase-up-${task.num}-${ph.stack}${suffix}`);
    up.disabled = i === 0;
    up.addEventListener('click', () => movePhase(state.selectedIndex, i, -1));
    const down = el('button', 'mini', '↓');
    down.setAttribute('data-testid', `phase-down-${task.num}-${ph.stack}${suffix}`);
    down.disabled = i === task.phases.length - 1;
    down.addEventListener('click', () => movePhase(state.selectedIndex, i, 1));
    item.appendChild(up);
    item.appendChild(down);
    list.appendChild(item);
  });
  box.appendChild(list);

  const note = el('div', 'muted', 'Фазы идут последовательно: следующая начинается после окончания предыдущей.');
  box.appendChild(note);

  const dates = el('div', 'row-meta');
  dates.textContent = [
    task.baselineStart ? `Базовый план: ${fmtDate(task.baselineStart)} — ${fmtDate(task.baselineFinish)}` : null,
    task.actualStart ? `Фактическое начало: ${fmtDate(task.actualStart)}` : null,
    task.computedStart ? `Расчёт: ${fmtDate(task.computedStart)} — ${fmtDate(task.computedFinish)}` : null
  ].filter(Boolean).join(' · ');
  box.appendChild(dates);
}

function movePhase(taskIndex, phaseIndex, delta) {
  const task = state.sched.tasks[taskIndex];
  if (!task) return;
  // task.phases уже идут в порядке выполнения, а phaseOrder хранит индексы
  // исходного массива - меняем местами позиции в порядке.
  const order = task.phaseOrder.slice();
  const j = phaseIndex + delta;
  if (j < 0 || j >= order.length) return;
  [order[phaseIndex], order[j]] = [order[j], order[phaseIndex]];
  const source = state.raw.tasks[task.srcIndex];
  if (source) source.phaseOrder = order;
  rebuild();
}

// ------------------------------------------------------------- holiday editor

function renderHolidayList() {
  const box = document.getElementById('holiday-list');
  if (!box) return;
  box.innerHTML = '';
  const sorted = [...state.holidays].sort();
  box.setAttribute('data-testid', 'holiday-list');
  for (const key of sorted) {
    const chip = el('span', 'chip holiday-chip');
    chip.setAttribute('data-testid', 'holiday-' + key);
    const label = el('span', null, key);
    const del = el('button', 'mini', '×');
    del.setAttribute('data-testid', 'holiday-del-' + key);
    del.title = 'Удалить';
    del.addEventListener('click', () => removeHoliday(key));
    chip.appendChild(label);
    chip.appendChild(del);
    box.appendChild(chip);
  }
  if (!sorted.length) box.appendChild(el('div', 'muted', 'Список пуст'));
}

/** Показать или убрать сообщение под формой. */
function setFormError(id, message) {
  let box = document.getElementById(id);
  if (!box) {
    box = el('div', 'form-error');
    box.id = id;
    box.setAttribute('data-testid', id);
    box.setAttribute('role', 'alert');
    const anchor = document.getElementById(id === 'absence-error' ? 'absence-form' : 'holiday-form');
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(box, anchor.nextSibling);
  }
  box.textContent = message || '';
  box.hidden = !message;
}

function addHoliday(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  if (state.holidays.includes(key)) return false;
  state.holidays.push(key);
  storeHolidays();
  rebuild();
  return true;
}

function removeHoliday(key) {
  state.holidays = state.holidays.filter((h) => h !== key);
  storeHolidays();
  rebuild();
}

// ------------------------------------------------------------ absence editor

function renderFilterOptions() {
  const select = document.getElementById('filter-executor');
  if (!select) return;
  const names = executorsInProject();
  const current = state.filter.executor;
  select.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'все';
  select.appendChild(all);
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = names.includes(current) ? current : '';
  state.filter.executor = select.value;
}

/** Очистить поля фильтра в DOM (состояние чистится отдельно). */
function resetFilterInputs() {
  const exec = document.getElementById('filter-executor');
  const query = document.getElementById('filter-query');
  if (exec) exec.value = '';
  if (query) query.value = '';
}

function renderFilterCount() {
  const box = document.getElementById('filter-count');
  if (!box || !state.sched) return;
  const shown = visibleTasks(state).length;
  const total = state.sched.tasks.length;
  const active = state.filter.executor || state.filter.query.trim();
  box.textContent = active ? `Показано ${shown} из ${total}` : '';
  const reset = document.getElementById('filter-reset');
  if (reset) reset.disabled = !active;
}

function renderExecutorOptions() {
  const select = document.getElementById('absence-executor');
  if (!select) return;
  const names = executorsInProject();
  const current = select.value;
  select.innerHTML = '';
  if (!names.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— загрузите файл —';
    select.appendChild(opt);
    return;
  }
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  if (names.includes(current)) select.value = current;
}

function renderAbsenceList() {
  const box = document.getElementById('absence-list');
  if (!box) return;
  box.innerHTML = '';
  box.setAttribute('data-testid', 'absence-list');
  if (!state.absences.length) {
    box.appendChild(el('div', 'muted', 'Отсутствий нет'));
    return;
  }
  state.absences.forEach((a, i) => {
    const chip = el('span', 'chip absence-chip');
    chip.setAttribute('data-testid', `absence-${i}`);
    chip.appendChild(el('span', null, `${a.executor}: ${a.from} — ${a.to}`));
    const del = el('button', 'mini', '×');
    del.title = 'Удалить';
    del.setAttribute('data-testid', `absence-del-${i}`);
    del.addEventListener('click', () => removeAbsence(i));
    chip.appendChild(del);
    box.appendChild(chip);
  });
}

function addAbsence(executor, from, to) {
  if (!executor || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return false;
  if (to < from) return false;
  state.absences.push({ executor, from, to });
  storeAbsences();
  rebuild();
  return true;
}

function removeAbsence(index) {
  state.absences.splice(index, 1);
  storeAbsences();
  rebuild();
}

function resetAbsences() {
  state.absences = [];
  storeAbsences();
  rebuild();
}

function resetHolidays() {
  state.holidays = [...DEFAULT_HOLIDAYS];
  storeHolidays();
  rebuild();
}

// ---------------------------------------------------------------- interaction

function bindControls() {
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    loadArrayBuffer(buf, file.name);
  });

  document.querySelectorAll('[data-zoom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.zoom = btn.dataset.zoom;
      document.querySelectorAll('[data-zoom]').forEach((b) => b.classList.toggle('active', b === btn));
      renderGantt(document.getElementById('gantt'), state);
    });
  });

  const rb = document.getElementById('toggle-respect-baseline');
  rb.addEventListener('change', () => {
    state.respectBaseline = rb.checked;
    rebuild();
  });

  const bl = document.getElementById('toggle-baseline');
  bl.addEventListener('change', () => {
    state.showBaseline = bl.checked;
    renderGantt(document.getElementById('gantt'), state);
  });

  const tt = document.getElementById('toggle-table');
  tt.addEventListener('change', () => {
    document.getElementById('table-view').hidden = !tt.checked;
    if (tt.checked) renderTable(document.getElementById('table-view'), state);
  });

  document.getElementById('btn-today').addEventListener('click', scrollToToday);
  document.getElementById('btn-reset-holidays').addEventListener('click', resetHolidays);

  const form = document.getElementById('holiday-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('holiday-date');
    const value = input.value.trim();
    const error = !/^\d{4}-\d{2}-\d{2}$/.test(value) ? 'Формат даты: ГГГГ-ММ-ДД'
      : (state.holidays.includes(value) ? 'Такой праздник уже есть' : null);
    setFormError('holiday-error', error);
    if (!error && addHoliday(value)) input.value = '';
  });

  const absenceForm = document.getElementById('absence-form');
  absenceForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const executor = document.getElementById('absence-executor').value;
    const from = document.getElementById('absence-from').value;
    const to = document.getElementById('absence-to').value || from;
    const error = !executor ? 'Выберите исполнителя'
      : !from ? 'Укажите начало отсутствия'
      : to < from ? 'Окончание раньше начала'
      : null;
    setFormError('absence-error', error);
    if (!error && addAbsence(executor, from, to)) {
      document.getElementById('absence-from').value = '';
      document.getElementById('absence-to').value = '';
    }
  });

  document.getElementById('btn-reset-absences').addEventListener('click', resetAbsences);

  document.getElementById('holiday-pick').addEventListener('change', (e) => {
    if (e.target.value) {
      addHoliday(e.target.value);
      e.target.value = '';
    }
  });

  document.getElementById('filter-executor').addEventListener('change', (e) => {
    state.filter.executor = e.target.value;
    renderGantt(document.getElementById('gantt'), state);
    renderTable(document.getElementById('table-view'), state);
    renderFilterCount();
  });

  const queryInput = document.getElementById('filter-query');
  queryInput.addEventListener('input', (e) => {
    state.filter.query = e.target.value;
    renderGantt(document.getElementById('gantt'), state);
    renderTable(document.getElementById('table-view'), state);
    renderFilterCount();
  });

  document.getElementById('filter-reset').addEventListener('click', () => {
    state.filter = { executor: '', query: '' };
    resetFilterInputs();
    renderGantt(document.getElementById('gantt'), state);
    renderTable(document.getElementById('table-view'), state);
    renderFilterCount();
  });

  document.getElementById('help-open').addEventListener('click', toggleHelp);
  document.getElementById('help-close').addEventListener('click', () => { document.getElementById('help-dialog').hidden = true; });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    state.theme = next;
  });

  document.getElementById('gantt').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const index = Number(row.dataset.index);
    state.selectedIndex = state.selectedIndex === index ? null : index;
    document.querySelectorAll('.row').forEach((r) => r.classList.toggle('selected', Number(r.dataset.index) === state.selectedIndex));
    renderInspector();
  });

  bindTooltip();
  bindHotkeys();

  // drag & drop xlsx anywhere on the page
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    loadArrayBuffer(buf, file.name);
  });
}

/* Горячие клавиши: Esc - снять выбор, +/- масштаб, T - сегодня, ? - справка.
   Не срабатывают, когда фокус в поле ввода. */
function bindHotkeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('filter-query').focus();
      return;
    }
    if (e.key === 'Escape') {
      const help = document.getElementById('help-dialog');
      if (help && !help.hidden) {
        help.hidden = true;
        return;
      }
      if (state.selectedIndex != null) {
        state.selectedIndex = null;
        renderAll();
      }
      return;
    }
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      toggleHelp();
      return;
    }
    const zooms = ['day', 'week', 'month'];
    if (e.key === '+' || e.key === '=') applyZoom(zooms[Math.max(0, zooms.indexOf(state.zoom) - 1)]);
    if (e.key === '-' || e.key === '_') applyZoom(zooms[Math.min(zooms.length - 1, zooms.indexOf(state.zoom) + 1)]);
    if (e.key === 't' || e.key === 'T' || e.key === 'е' || e.key === 'Е') scrollToToday();
  });
}

function applyZoom(zoom) {
  if (!ZOOMS[zoom]) return;
  state.zoom = zoom;
  document.querySelectorAll('[data-zoom]').forEach((b) => b.classList.toggle('active', b.dataset.zoom === zoom));
  if (state.sched) renderGantt(document.getElementById('gantt'), state);
}

function toggleHelp() {
  const dialog = document.getElementById('help-dialog');
  if (!dialog) return;
  dialog.hidden = !dialog.hidden;
}

function scrollToToday() {
  const line = document.querySelector('.today-line');
  const root = document.getElementById('gantt');
  if (line) root.scrollLeft = Math.max(0, parseFloat(line.style.left) - root.clientWidth / 3);
}

function bindTooltip() {
  const tip = document.getElementById('tooltip');
  const gantt = document.getElementById('gantt');
  gantt.addEventListener('mousemove', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    tip.textContent = target.dataset.tip;
    const pad = 14;
    const x = Math.min(e.clientX + pad, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(e.clientY + pad, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
  gantt.addEventListener('mouseleave', () => { tip.hidden = true; });
}

// ---------------------------------------------------------------------- boot

function boot() {
  const stored = loadStoredHolidays();
  if (stored) state.holidays = stored;
  state.absences = loadStoredAbsences();
  const media = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (media && media.matches) document.documentElement.setAttribute('data-theme', 'dark');
  document.querySelectorAll('[data-zoom]').forEach((b) => b.classList.toggle('active', b.dataset.zoom === state.zoom));
  document.querySelectorAll('details.panel').forEach((d) => {
    const key = 'gantt.panel.' + d.dataset.panel;
    d.open = localStorage.getItem(key) !== '0';
    d.addEventListener('toggle', () => {
      try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (err) { /* ignore */ }
    });
  });
  bindControls();
  renderHolidayList();
  renderAbsenceList();
  renderExecutorOptions();
  renderAlerts();
  renderStats();
  const s = new URLSearchParams(location.search);
  if (s.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  if (s.get('theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
  if (s.get('zoom') && ZOOMS[s.get('zoom')]) {
    state.zoom = s.get('zoom');
    document.querySelectorAll('[data-zoom]').forEach((b) => b.classList.toggle('active', b.dataset.zoom === state.zoom));
  }
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

// Test surface: the E2E suite drives the app through this object as well as
// through the DOM.
if (typeof window !== 'undefined') {
  window.__gantt = {
    state,
    parseWorkbook,
    scheduleProject,
    buildWarnings,
    executorLoad,
    orderedPhases,
    findSlot,
    Calendar,
    loadArrayBuffer,
    addHoliday,
    removeHoliday,
    resetHolidays,
    addAbsence,
    removeAbsence,
    resetAbsences,
    buildBlockedMap,
    priorityInversions,
    sizeRatioOk,
    placePhase,
    CONCURRENT_SIZE_RATIO,
    rebuild,
    renderAll,
    movePhase,
    DEFAULT_HOLIDAYS,
    STACKS,
    MAX_CONCURRENT_TASKS_PER_EXECUTOR,
    fmtDate
  };
}
