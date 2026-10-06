'use strict';

/* Gantt rendering.
 *
 * The scheduler works in working-day units; the chart is drawn in *calendar*
 * days so that weekends and holidays are visible as shaded columns (the
 * "pause" a sequential phase chain takes over a weekend is part of the plan).
 * Bar geometry therefore goes through: work position -> date -> pixel.
 */

const ZOOMS = {
  day: { pxPerDay: 34, label: 'День' },
  week: { pxPerDay: 14, label: 'Неделя' },
  month: { pxPerDay: 5, label: 'Месяц' }
};

const LABEL_WIDTH = 300;
const ROW_HEIGHT = 46;
const HEADER_HEIGHT = 52;
const LANE_TOP = 14;      // верх первой дорожки внутри строки
const LANE_HEIGHT = 21;   // 18px полоса + 3px зазор между дорожками
const ROW_PAD = 10;       // нижний отступ строки

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function fmtDate(d) {
  if (!d) return '—';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

function fmtDateShort(d) {
  if (!d) return '';
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Calendar-day index of a date on the timeline. */
function dayIndex(date, timelineStart) {
  return daysBetween(timelineStart, date);
}

/** Compute the visible timeline range covering plan, actuals and computed bars. */
function timelineRange(schedule, tasks) {
  const dates = [];
  for (const t of (tasks || schedule.tasks)) {
    for (const d of [t.baselineStart, t.baselineFinish, t.actualStart, t.actualFinish, t.computedStart, t.computedFinish]) {
      if (d) dates.push(d.getTime());
    }
  }
  // При активном фильтре шкала подстраивается под отфильтрованные задачи,
  // иначе бары уезжают за пределы видимой области.
  if (!tasks && schedule.projectStartDate) dates.push(schedule.projectStartDate.getTime());
  if (!dates.length) dates.push(Date.now());
  const start = new Date(Math.min(...dates));
  const end = new Date(Math.max(...dates));
  return { start: addDays(start, -3), end: addDays(end, 21) };
}

/**
 * Раскладка фаз по дорожкам: фазы, идущие параллельно (C++ и Питон у разных
 * исполнителей), рисуются одна под другой, а не накладываются.
 */
function assignLanes(phases) {
  const sorted = [...phases].sort((a, b) => a.startPos - b.startPos || a.endPos - b.endPos);
  const lanes = [];
  for (const ph of sorted) {
    const lane = lanes.find((l) => ph.startPos >= l[l.length - 1].endPos - 1e-9);
    if (lane) lane.push(ph);
    else lanes.push([ph]);
  }
  return lanes;
}

function rowHeight(task) {
  const lanes = task.scheduled && task.phases.length ? assignLanes(task.phases).length : 1;
  return LANE_TOP + Math.max(1, lanes) * LANE_HEIGHT + ROW_PAD;
}

function stackColorVar(series) {
  return `var(--series-${series})`;
}

/**
 * Work axis position -> continuous calendar-day pixel coordinate.
 *
 * A position is "N working days"; the fraction belongs to the working day it
 * falls in, so a phase ending two hours into a day stops a quarter of the way
 * into that day's column instead of covering it whole. Consecutive phases then
 * meet exactly (only the 2px gap shows) and a phase that ends on a Friday
 * still paints across the weekend to the next working day.
 */
function posToX(pos, cal, range, pxPerDay) {
  const i = Math.max(0, Math.floor(pos + 1e-9));
  const frac = pos - i;
  const date = cal.dateOf(i);
  return (dayIndex(date, range.start) + frac) * pxPerDay;
}

/**
 * Render the whole chart into `root`.
 * @param {HTMLElement} root
 * @param {Object} state {schedule, cal, zoom, showBaseline, view}
 */
function renderGantt(root, state) {
  const schedule = state.sched;
  const { cal, zoom } = state;
  const pxPerDay = ZOOMS[zoom].pxPerDay;
  const rows = visibleTasks(state);
  const filterActive = !!(state.filter.executor || state.filter.query.trim());
  const range = timelineRange(schedule, filterActive ? rows.map((r) => r.task) : null);
  const totalDays = Math.max(1, daysBetween(range.start, range.end));
  const trackWidth = totalDays * pxPerDay;

  root.innerHTML = '';
  root.style.setProperty('--px-per-day', pxPerDay + 'px');
  root.style.setProperty('--label-width', LABEL_WIDTH + 'px');
  root.classList.toggle('zoom-day', zoom === 'day');
  root.classList.toggle('zoom-week', zoom === 'week');
  root.classList.toggle('zoom-month', zoom === 'month');
  root.setAttribute('data-testid', 'gantt');

  const inner = el('div', 'gantt-inner');
  inner.style.width = LABEL_WIDTH + trackWidth + 'px';
  root.appendChild(inner);

  // ---------- header ----------
  const head = el('div', 'gantt-head');
  head.appendChild(el('div', 'corner', 'Задача'));
  const headTrack = el('div', 'head-track');
  headTrack.style.width = trackWidth + 'px';

  const monthRow = el('div', 'head-row months');
  let cur = null;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(range.start, i);
    const key = d.getUTCFullYear() + '-' + d.getUTCMonth();
    if (key !== cur) {
      cur = key;
      const width = monthLengthFrom(d, totalDays - i) * pxPerDay;
      const cell = el('div', 'month-cell');
      cell.style.width = width + 'px';
      cell.textContent = `${MONTHS_RU[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      monthRow.appendChild(cell);
    }
  }
  headTrack.appendChild(monthRow);

  const dayRow = el('div', 'head-row days');
  const showDayNumbers = pxPerDay >= 16;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(range.start, i);
    const cell = el('div', 'day-cell');
    cell.style.width = pxPerDay + 'px';
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) cell.classList.add('weekend');
    if (cal.isHoliday(d)) cell.classList.add('holiday');
    if (showDayNumbers) cell.textContent = String(d.getUTCDate());
    else if (dow === 1) cell.textContent = fmtDateShort(d);
    dayRow.appendChild(cell);
  }
  headTrack.appendChild(dayRow);
  head.appendChild(headTrack);
  inner.appendChild(head);

  // ---------- body ----------
  const body = el('div', 'gantt-body');
  const bg = el('div', 'bg-layer');
  bg.style.left = LABEL_WIDTH + 'px';
  bg.style.width = trackWidth + 'px';
  bg.style.height = visibleTasks(state).reduce((sum, r) => sum + rowHeight(r.task), 0) + 'px';

  for (let i = 0; i < totalDays; i++) {
    const d = addDays(range.start, i);
    const dow = d.getUTCDay();
    const isHol = cal.isHoliday(d);
    if (dow === 0 || dow === 6 || isHol) {
      const shade = el('div', 'shade' + (isHol ? ' holiday' : ''));
      shade.style.left = i * pxPerDay + 'px';
      shade.style.width = pxPerDay + 'px';
      shade.setAttribute('data-testid', isHol ? 'holiday-shade' : 'weekend-shade');
      shade.setAttribute('title', (isHol ? 'Праздник: ' : 'Выходной: ') + fmtDate(d));
      bg.appendChild(shade);
    }
    if (d.getUTCDate() === 1 || i === 0) {
      const line = el('div', 'month-line');
      line.style.left = i * pxPerDay + 'px';
      bg.appendChild(line);
    }
  }

  const today = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  const todayIdx = dayIndex(today, range.start);
  if (todayIdx >= 0 && todayIdx <= totalDays) {
    const tl = el('div', 'today-line');
    tl.style.left = todayIdx * pxPerDay + 'px';
    tl.setAttribute('data-testid', 'today-line');
    tl.setAttribute('title', 'Сегодня: ' + fmtDate(today));
    bg.appendChild(tl);
  }
  body.appendChild(bg);

  if (!rows.length) {
    const empty = el('div', 'empty-state', 'Под фильтр не подходит ни одна задача');
    empty.setAttribute('data-testid', 'filter-empty');
    body.appendChild(empty);
  }
  for (const { task, index, id } of rows) {
    body.appendChild(renderRow(task, state, range, pxPerDay, id, index));
  }
  inner.appendChild(body);
}

/**
 * Суффикс идентификатора фазы: если стек в задаче повторяется (несколько
 * исполнителей), к нему добавляется номер вхождения.
 */
function stackSuffix(task, stack, occurrences) {
  const total = task.phases.filter((p) => p.stack === stack).length;
  const k = (occurrences.get(stack) || 0) + 1;
  occurrences.set(stack, k);
  return total > 1 ? `-${k}` : '';
}

/**
 * Номер задачи может повторяться в файле (в шаблоне встречаются повторы),
 * поэтому DOM-идентификаторы разводятся индексом: уникальный номер -> "7",
 * повтор -> "7-0", "7-1".
 */
function uniqueIds(tasks) {
  const counts = new Map();
  for (const t of tasks) counts.set(t.num, (counts.get(t.num) || 0) + 1);
  const seen = new Map();
  return tasks.map((t) => {
    if (counts.get(t.num) === 1) return String(t.num);
    const k = seen.get(t.num) || 0;
    seen.set(t.num, k + 1);
    return `${t.num}-${k}`;
  });
}

function monthLengthFrom(d, remaining) {
  let n = 1;
  while (n < remaining && addDays(d, n).getUTCMonth() === d.getUTCMonth()) n++;
  return n;
}

function renderRow(task, state, range, pxPerDay, id, index) {
  const { cal } = state;
  const row = el('div', 'row');
  row.setAttribute('data-testid', 'row-' + id);
  row.setAttribute('data-task', String(task.num));
  row.setAttribute('data-index', String(index));
  row.classList.toggle('selected', state.selectedIndex === index);
  row.style.height = rowHeight(task) + 'px';

  const label = el('div', 'row-label');
  const title = el('div', 'row-title', `${task.num}. ${task.name}`);
  title.setAttribute('title', task.name);
  label.appendChild(title);
  const meta = el('div', 'row-meta');
  const bits = [];
  bits.push(`приоритет ${task.priority}`);
  if (task.sp != null) bits.push(`SP ${task.sp}`);
  if (task.durationDays != null) bits.push(`план ${task.durationDays} дн`);
  if (task.done) bits.push('завершена');
  meta.textContent = bits.join(' · ');
  label.appendChild(meta);
  row.appendChild(label);

  const track = el('div', 'row-track');
  track.style.width = '100%';
  track.setAttribute('data-testid', 'track-' + id);
  row.appendChild(track);

  // baseline ghost bar
  if (state.showBaseline && task.baselineStart && task.baselineFinish) {
    const ghost = el('div', 'ghost-bar');
    const x0 = dayIndex(task.baselineStart, range.start) * pxPerDay;
    const x1 = (dayIndex(task.baselineFinish, range.start) + 1) * pxPerDay;
    ghost.style.left = x0 + 'px';
    ghost.style.width = Math.max(2, x1 - x0) + 'px';
    ghost.setAttribute('data-testid', 'ghost-' + id);
    ghost.title = `Базовый план: ${fmtDate(task.baselineStart)} — ${fmtDate(task.baselineFinish)}`;
    track.appendChild(ghost);
  }

  if (task.scheduled && task.phases.length) {
    const occurrences = new Map(); // стек -> сколько раз уже встретился
    const repeats = new Map(); // стек -> сколько фаз этого стека в задаче
    for (const ph of task.phases) repeats.set(ph.stack, (repeats.get(ph.stack) || 0) + 1);

    const lanes = assignLanes(task.phases);
    lanes.forEach((lane, laneIndex) => {
      const bar = el('div', 'bar');
      const barX = posToX(lane[0].startPos, cal, range, pxPerDay);
      const barEnd = posToX(lane[lane.length - 1].endPos, cal, range, pxPerDay);
      bar.style.left = barX + 'px';
      bar.style.top = LANE_TOP + laneIndex * LANE_HEIGHT + 'px';
      bar.style.width = Math.max(3, barEnd - barX) + 'px';
      if (laneIndex === 0) bar.setAttribute('data-testid', 'bar-' + id);
      bar.setAttribute('data-lane', String(laneIndex));

      for (const ph of lane) {
        const seg = el('div', 'seg');
        const startDate = cal.dateOf(ph.startPos);
        const x0 = posToX(ph.startPos, cal, range, pxPerDay);
        const x1 = posToX(ph.endPos, cal, range, pxPerDay);
        const width = Math.max(3, x1 - x0);
        // Сегменты позиционируются абсолютно: flex-раскладка накапливала бы
        // ширины предыдущих сегментов и уводила цепочку вправо.
        seg.style.left = (x0 - barX) + 'px';
        seg.style.width = Math.max(3, width - 2) + 'px'; // 2px зазор
        seg.style.background = stackColorVar(ph.series);
        seg.setAttribute('data-testid', `seg-${id}-${ph.stack}${stackSuffix(task, ph.stack, occurrences)}`);
        seg.setAttribute('data-stack', ph.stack);
        seg.setAttribute('data-executor', ph.executor);
        seg.dataset.tip = [
          `Задача ${task.num}: ${task.name}`,
          `${ph.label} — ${ph.executor}, ${ph.hours} ч (${cal.hoursToDays(ph.hours).toFixed(2)} раб. дн)`,
          `${fmtDate(startDate)} — ${fmtDate(cal.finishDateOf(ph.endPos))}`,
          ph.wait > 1e-9 ? `Ожидание исполнителя: ${(ph.wait * HOURS_PER_DAY).toFixed(1)} ч` : '',
          task.baselineStart ? `Базовый план: ${fmtDate(task.baselineStart)} — ${fmtDate(task.baselineFinish)}` : '',
          task.durationDays != null ? `Плановая длительность: ${task.durationDays} дн, расчёт: ${task.computedSpanDays.toFixed(2)} раб. дн` : ''
        ].filter(Boolean).join('\n');
        if (width > 54) {
          const repeated = repeats.get(ph.stack) > 1;
          const tag = el('span', 'seg-label', repeated ? `${ph.label}: ${ph.executor}` : ph.label);
          seg.appendChild(tag);
        }
        bar.appendChild(seg);
      }
      track.appendChild(bar);
    });
  } else if (task.done) {
    const done = el('div', 'done-badge', 'выполнена');
    track.appendChild(done);
  } else {
    const none = el('div', 'no-phases', 'нет фаз');
    track.appendChild(none);
  }

  // ограничение «не раньше» (например, готовность ТТ)
  if (task.notBefore && task.scheduled) {
    const limit = el('div', 'limit-marker');
    limit.style.left = dayIndex(cal.snapForward(task.notBefore), range.start) * pxPerDay + 'px';
    limit.setAttribute('data-testid', 'notbefore-' + id);
    limit.title = 'Не раньше: ' + fmtDate(task.notBefore);
    track.appendChild(limit);
  }

  // actual-start marker (pin)
  if (task.actualStart && task.scheduled) {
    const pin = el('div', 'pin-marker');
    pin.style.left = dayIndex(task.actualStart, range.start) * pxPerDay + 'px';
    pin.setAttribute('data-testid', 'pin-' + id);
    pin.title = 'Фактическое начало: ' + fmtDate(task.actualStart);
    track.appendChild(pin);
  }

  return row;
}

/** Plain table view - required relief for low-contrast series colors. */
function renderTable(root, state) {
  const schedule = state.sched;
  const { cal } = state;
  root.innerHTML = '';
  root.setAttribute('data-testid', 'table-view');
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
    <th>№</th><th>Приоритет</th><th>Название</th><th>План, дн</th>
    <th>Базовое начало</th><th>Базовое окончание</th>
    <th>Расчётное начало</th><th>Расчётное окончание</th><th>Расчёт, раб. дн</th>
    <th>Фазы (порядок)</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  const rows = visibleTasks(state);
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.textContent = 'Под фильтр не подходит ни одна задача';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  rows.forEach(({ task: t, id }) => {
    const tr = document.createElement('tr');
    tr.setAttribute('data-testid', 'table-row-' + id);
    const phaseText = t.phases.length
      ? t.phases.map((p) => `${p.label} ${p.hours}ч/${p.executor}${p.startPos != null ? ' (' + fmtDate(cal.dateOf(p.startPos)) + ')' : ''}`).join(' → ')
      : '—';
    tr.innerHTML = `
      <td>${t.num}</td>
      <td>${t.priority}</td>
      <td class="t-name"></td>
      <td>${t.durationDays ?? '—'}</td>
      <td>${fmtDate(t.baselineStart)}</td>
      <td>${fmtDate(t.baselineFinish)}</td>
      <td>${fmtDate(t.computedStart)}</td>
      <td>${fmtDate(t.computedFinish)}</td>
      <td>${t.computedSpanDays != null ? t.computedSpanDays.toFixed(2) : '—'}</td>
      <td class="t-phases"></td>`;
    tr.querySelector('.t-name').textContent = t.name;
    tr.querySelector('.t-phases').textContent = phaseText;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  root.appendChild(table);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
