'use strict';

/* Auto-scheduler.
 *
 * Rules:
 *  - Each task's phases run strictly sequentially, in the task's phase order
 *    (default: C++ -> Питон -> Дотнет -> Фронт; reorderable per task in the UI).
 *  - An executor holds at most 2 tasks at once, and two tasks may overlap for
 *    one executor only when their phase sizes differ by 3x or more (a big block
 *    of work and a small one can share a person; two comparable ones cannot).
 *  - Tasks are scheduled in ascending priority, then ascending number, and each
 *    one starts as early as its capacity allows ("as soon as possible").
 *  - A task never starts before its actual start (pinned); with respectBaseline
 *    its baseline start becomes a floor as well.
 *  - An executor's absence (vacation) pauses a phase: the phase keeps its
 *    working hours, skips the absent days and finishes later.
 */

const MAX_CONCURRENT_TASKS_PER_EXECUTOR = 2;
const CONCURRENT_SIZE_RATIO = 3;

/** True if candidate [s, e) overlaps interval [is, ie) with positive length. */
function overlaps(s, e, is, ie) {
  return is < e - 1e-9 && ie > s + 1e-9;
}

/** Two phase sizes may share an executor only when one is 3x the other. */
function sizeRatioOk(hoursA, hoursB) {
  const hi = Math.max(hoursA, hoursB);
  const lo = Math.min(hoursA, hoursB);
  return lo > 0 && hi / lo >= CONCURRENT_SIZE_RATIO - 1e-9;
}

/**
 * C++ и Питон одной задачи могут идти параллельно, если это разные
 * исполнители: это два независимых бэкенд-куска, их не обязательно делать
 * строго друг за другом. Остальные пары фаз остаются последовательными.
 */
function canRunInParallel(a, b) {
  const pair = (a.stack === 'cpp' && b.stack === 'py') || (a.stack === 'py' && b.stack === 'cpp');
  return pair && a.executor !== b.executor;
}

/** Advance a start position off an absent working day. */
function skipBlocked(blocked, pos) {
  if (!blocked || blocked.size === 0) return pos;
  let p = pos;
  let guard = 0;
  while (blocked.has(Math.floor(p + 1e-9)) && guard++ < 5000) p = Math.floor(p + 1e-9) + 1;
  return p;
}

/**
 * Earliest start >= cursor where the executor is free: at most one other task
 * already holds them, and that task's phase is 3x bigger or 3x smaller.
 * Candidates are the cursor and the ends of existing intervals - between two
 * consecutive event points the set of overlaps is constant.
 */
function findSlot(intervals, cursor, duration, hours, blocked) {
  const candidates = Array.from(new Set([cursor, ...intervals.map((iv) => iv.end)]))
    .filter((x) => x >= cursor - 1e-9)
    .sort((a, b) => a - b);

  for (const candidate of candidates) {
    const s = skipBlocked(blocked, candidate);
    const e = s + duration;
    const byTask = new Map();
    for (const iv of intervals) {
      if (overlaps(s, e, iv.start, iv.end)) byTask.set(iv.taskNum, iv);
    }
    if (byTask.size === 0) return s;
    if (byTask.size === 1) {
      const other = byTask.values().next().value;
      if (sizeRatioOk(hours, other.hours)) return s;
    }
  }
  // No feasible candidate: start after everything already booked.
  const tail = intervals.length ? Math.max(...intervals.map((iv) => iv.end)) : cursor;
  return skipBlocked(blocked, Math.max(cursor, tail));
}

/**
 * Place one phase. The phase keeps its working hours: absent days inside its
 * span do not consume progress, they only push the finish date out.
 */
function placePhase(intervals, cursor, hours, blocked) {
  const duration = hours / HOURS_PER_DAY;
  const start = findSlot(intervals, cursor, duration, hours, blocked);
  // span = duration + absent days inside the span; recompute from the base
  // duration each round (adding to the previous span would grow forever).
  let span = duration;
  for (let guard = 0; guard < 1000; guard++) {
    let blockedInside = 0;
    for (let p = Math.ceil(start - 1e-9); p < start + span - 1e-9; p++) {
      if (blocked && blocked.has(p)) blockedInside++;
    }
    if (blockedInside === 0) break;
    const next = duration + blockedInside;
    if (next <= span + 1e-9) break;
    span = next;
  }
  return { start, end: start + span, wait: start - cursor };
}

/** executor -> Set of working-day positions the executor is absent on. */
function buildBlockedMap(cal, absences) {
  const map = new Map();
  for (const a of absences || []) {
    const from = parseDayKey(a.from);
    const to = parseDayKey(a.to);
    if (isNaN(from) || isNaN(to) || to < from) continue;
    const set = map.get(a.executor) || new Set();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const idx = cal.index.get(dayKey(d));
      if (idx !== undefined) set.add(idx);
    }
    map.set(a.executor, set);
  }
  return map;
}

/**
 * Schedule every task. Returns a fresh array of result objects; the input
 * tasks are not mutated.
 *
 * @param {Array} tasks parsed tasks
 * @param {Object} cal Calendar (must be built already)
 * @param {Object} [opts] {respectBaseline, absences}
 */
function scheduleProject(tasks, cal, opts = {}) {
  // Даты плана из файла - это ограничение, а не пожелание: задача не начинается
  // раньше базового начала (галочка «Не раньше плана» включена по умолчанию).
  // Выключенная галочка возвращает режим «как можно раньше»: задача стартует от
  // начала проекта, ждёт только занятость исполнителя.
  const respectBaseline = opts.respectBaseline === undefined ? true : !!opts.respectBaseline;
  const blockedMap = buildBlockedMap(cal, opts.absences);

  // Начало проекта - самая ранняя из границ задач, включая границу, посчитанную
  // назад от базового окончания: иначе задача с одним только окончанием
  // стартовала бы от него же и заведомо опаздывала.
  const floorByTask = new Map();
  for (const t of tasks) {
    floorByTask.set(t, taskFloorPos(t, cal, respectBaseline, orderedPhases(t)));
  }
  const floorPositions = [...floorByTask.values()].filter((p) => p != null);
  let projectStartPos;
  if (floorPositions.length) {
    projectStartPos = Math.min(...floorPositions);
  } else {
    const anchorDates = [];
    for (const t of tasks) {
      if (t.actualStart) anchorDates.push(t.actualStart);
      if (t.baselineStart) anchorDates.push(t.baselineStart);
      if (t.notBefore) anchorDates.push(t.notBefore);
    }
    const fallbackStart = anchorDates.length ? new Date(Math.min(...anchorDates.map((d) => d.getTime()))) : new Date();
    projectStartPos = cal.posOf(fallbackStart) ?? 0;
  }

  const busy = new Map(); // executor -> [{start, end, taskNum, hours, stack}]
  const results = [];

  const ordered = [...tasks].sort((a, b) => a.priority - b.priority || a.num - b.num);
  const numToOrder = new Map(ordered.map((t, i) => [t.num, i]));
  const sourceIndex = new Map(tasks.map((t, i) => [t, i]));

  for (const task of ordered) {
    const phases = orderedPhases(task);
    const done = !!task.actualFinish;

    if (phases.length === 0 || done) {
      results.push({
        ...task,
        srcIndex: sourceIndex.get(task),
        scheduled: false,
        done,
        computedStartPos: null,
        computedFinishPos: null,
        phases: phases.map((p) => ({ ...p, startPos: null, endPos: null }))
      });
      continue;
    }

    // Граница задачи (факт / «Не раньше» / базовое начало), но не раньше
    // начала проекта.
    const floorPos = floorByTask.get(task);
    let cursor = projectStartPos;
    if (floorPos != null) cursor = Math.max(cursor, floorPos);

    const scheduledPhases = [];
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      // Фаза не может начаться раньше, чем закончатся все предыдущие, кроме
      // случая "C++ и Питон у разных исполнителей" - они идут параллельно.
      let readyPos = cursor;
      for (let j = 0; j < i; j++) {
        const prev = scheduledPhases[j];
        if (canRunInParallel(phase, prev)) continue;
        readyPos = Math.max(readyPos, prev.endPos);
      }
      const blocked = blockedMap.get(phase.executor);
      const intervals = busy.get(phase.executor) || [];
      const placed = placePhase(intervals, readyPos, phase.hours, blocked);
      intervals.push({
        start: placed.start,
        end: placed.end,
        taskNum: task.num,
        hours: phase.hours,
        stack: phase.stack
      });
      busy.set(phase.executor, intervals);
      scheduledPhases.push({ ...phase, startPos: placed.start, endPos: placed.end, wait: placed.start - readyPos });
    }

    const startPos = Math.min(...scheduledPhases.map((p) => p.startPos));
    const finishPos = Math.max(...scheduledPhases.map((p) => p.endPos));

    results.push({
      ...task,
      srcIndex: sourceIndex.get(task),
      scheduled: true,
      done: false,
      pinned: !!task.actualStart,
      order: numToOrder.get(task.num),
      computedStartPos: startPos,
      computedFinishPos: finishPos,
      computedStart: cal.dateOf(startPos),
      computedFinish: cal.finishDateOf(finishPos),
      computedSpanDays: finishPos - startPos,
      phases: scheduledPhases
    });
  }

  // Restore the original file order for display.
  results.sort((a, b) => a.num - b.num);
  return { tasks: results, executors: busy, projectStartPos };
}

/**
 * Ранняя граница задачи по датам из файла, в рабочих позициях.
 * Приоритет: фактическое начало (факт) -> «Не раньше» -> базовое начало.
 * Если есть только базовое окончание, начало отсчитывается назад от него на
 * сумму часов всех фаз, чтобы задача успела закончиться к этой дате.
 */
function taskFloorPos(task, cal, respectBaseline, phases) {
  // Фактическое начало - это факт: задача уже началась, сдвинуть её нельзя.
  if (task.actualStart) return cal.posOf(task.actualStart);

  // Остальные даты - нижние границы, берётся самая поздняя из них:
  //  - «Не раньше» (готовность ТТ): раньше нельзя, ТТ не готово;
  //  - базовое начало: раньше нельзя, так запланировано;
  //  - если есть только базовое окончание: раньше нельзя, иначе не успеть.
  const floors = [];
  if (task.notBefore) floors.push(cal.posOf(task.notBefore));
  if (respectBaseline) {
    if (task.baselineStart) {
      floors.push(cal.posOf(task.baselineStart));
    } else if (task.baselineFinish) {
      const totalDays = phases.reduce((sum, p) => sum + cal.hoursToDays(p.hours), 0);
      const finishPos = cal.posOf(task.baselineFinish);
      if (finishPos != null) floors.push(Math.max(0, finishPos - totalDays + 1));
    }
  }
  const valid = floors.filter((p) => p != null);
  return valid.length ? Math.max(...valid) : null;
}

/**
 * Phases in the task's chosen order. phaseOrder holds the *indices* of the
 * task's phase array (a stack may repeat, so keys are not unique).
 */
function orderedPhases(task) {
  const out = [];
  const used = new Set();
  for (const i of task.phaseOrder) {
    const p = task.phases[i];
    if (p && !used.has(i)) {
      out.push(p);
      used.add(i);
    }
  }
  task.phases.forEach((p, i) => { if (!used.has(i)) out.push(p); }); // leftovers
  return out;
}

/** Peak number of distinct tasks each executor holds simultaneously. */
function executorLoad(schedule) {
  const load = new Map();
  for (const [executor, intervals] of schedule.executors) {
    let peak = 0;
    const points = new Set();
    for (const iv of intervals) {
      points.add(iv.start);
      points.add(iv.end);
    }
    for (const p of points) {
      const active = new Set(intervals.filter((iv) => iv.start <= p + 1e-9 && iv.end > p + 1e-9).map((iv) => iv.taskNum));
      peak = Math.max(peak, active.size);
    }
    load.set(executor, {
      peak,
      hours: intervals.reduce((s, iv) => s + (iv.end - iv.start) * HOURS_PER_DAY, 0),
      tasks: new Set(intervals.map((iv) => iv.taskNum)).size
    });
  }
  return load;
}

/**
 * Priority inversions: a task with a lower priority (higher priority number)
 * starting before a higher-priority one. The greedy scheduler hands resources
 * out in priority order, but a task whose earlier phases (or whose fixed
 * actual/baseline start) push it later can still be overtaken - that is worth
 * a warning.
 */
function priorityInversions(schedule) {
  const out = [];
  const tasks = schedule.tasks.filter((t) => t.scheduled && t.computedStartPos != null);
  for (const low of tasks) {
    // Все пропущенные вперёд более приоритетные задачи - в одно предупреждение,
    // иначе на большом файле получается полсотни почти одинаковых строк.
    const overtaken = tasks.filter(
      (high) => high !== low && high.priority < low.priority && high.computedStartPos > low.computedStartPos + 1e-9
    );
    if (!overtaken.length) continue;
    overtaken.sort((a, b) => a.priority - b.priority || a.computedStartPos - b.computedStartPos);
    const head = `Нарушение приоритета: задача ${low.num} (приоритет ${low.priority}) стартует ${fmtDate(low.computedStart)} раньше`;
    if (overtaken.length === 1) {
      const h = overtaken[0];
      out.push({
        kind: 'priority',
        taskNum: low.num,
        overtaken: 1,
        message: `${head} задачи ${h.num} (приоритет ${h.priority}, ${fmtDate(h.computedStart)})`
      });
      continue;
    }
    const shown = overtaken.slice(0, 6).map((h) => `${h.num} (приоритет ${h.priority}, ${fmtDate(h.computedStart)})`);
    const rest = overtaken.length - shown.length;
    out.push({
      kind: 'priority',
      taskNum: low.num,
      overtaken: overtaken.length,
      message: `${head} ${overtaken.length} задач с более высоким приоритетом: ${shown.join(', ')}${rest > 0 ? `, ещё ${rest}` : ''}`
    });
  }
  return out;
}

/**
 * Warnings after scheduling: computed span over the planned duration (col D),
 * over the baseline span, overload, and priority inversions.
 */
function buildWarnings(schedule, cal) {
  const out = [];
  const load = executorLoad(schedule);
  for (const [executor, info] of load) {
    if (info.peak > MAX_CONCURRENT_TASKS_PER_EXECUTOR) {
      out.push({ kind: 'overload', message: `${executor}: пик ${info.peak} задач одновременно (лимит ${MAX_CONCURRENT_TASKS_PER_EXECUTOR})` });
    }
  }
  for (const t of schedule.tasks) {
    if (!t.scheduled) continue;
    if (t.durationDays != null && t.computedSpanDays > t.durationDays + 1e-9) {
      out.push({
        kind: 'over-plan',
        taskNum: t.num,
        message: `Задача ${t.num}: расчёт ${t.computedSpanDays.toFixed(2)} раб. дн > план ${t.durationDays} дн`
      });
    }
    if (t.baselineStart && t.baselineFinish) {
      const baseSpan = cal.workdaysBetween(cal.snapForward(t.baselineStart), cal.snapForward(t.baselineFinish));
      if (baseSpan != null && t.computedSpanDays > baseSpan + 1e-9) {
        out.push({
          kind: 'over-baseline',
          taskNum: t.num,
          message: `Задача ${t.num}: расчёт ${t.computedSpanDays.toFixed(2)} раб. дн > базовый план ${baseSpan} раб. дн`
        });
      }
    }
  }
  out.push(...priorityInversions(schedule));
  return out;
}
