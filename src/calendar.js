'use strict';

/* Work calendar.
 *
 * The schedule runs on a continuous "work-hour axis": every working day owns
 * HOURS_PER_DAY consecutive hours. A position on the axis is expressed in
 * working days (float) - e.g. 2.5 means "halfway through the third working
 * day". Dates are derived from the axis by walking the list of working days,
 * so weekends and holidays never consume schedule time.
 */

const HOURS_PER_DAY = 8;

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function parseDayKey(key) {
  return new Date(key + 'T00:00:00Z');
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

const Calendar = {
  holidays: new Set(),
  /** @type {Date[]} ascending list of working days covering [rangeStart, rangeEnd] */
  days: [],
  index: new Map(), // 'YYYY-MM-DD' -> position in days[]
  rangeStart: null,

  init(holidayKeys) {
    this.holidays = new Set(holidayKeys);
  },

  isHoliday(d) {
    return this.holidays.has(dayKey(d));
  },

  /** Mon-Fri and not a holiday. */
  isWorkday(d) {
    const dow = d.getUTCDay();
    return dow !== 0 && dow !== 6 && !this.isHoliday(d);
  },

  /**
   * Build the working-day list. Must be called before any position math.
   * Pads the range so that tasks can always be pushed later than the plan.
   */
  build(rangeStart, rangeEnd) {
    const start = addDays(rangeStart, -7);
    const end = addDays(rangeEnd, 400);
    this.days = [];
    this.index = new Map();
    this.rangeStart = start;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (this.isWorkday(d)) {
        this.index.set(dayKey(d), this.days.length);
        this.days.push(d);
      }
    }
  },

  /** Working-day count between two dates (exclusive of `to`), for display. */
  workdaysBetween(from, to) {
    const a = this.index.get(dayKey(from));
    const b = this.index.get(dayKey(to));
    if (a === undefined || b === undefined) return null;
    return b - a;
  },

  /** Snap a date forward to the next working day (returns a new Date). */
  snapForward(d) {
    let x = new Date(d.getTime());
    for (let i = 0; i < 400; i++) {
      if (this.isWorkday(x)) return x;
      x = addDays(x, 1);
    }
    return x;
  },

  /** Date -> axis position (working days since rangeStart). */
  posOf(date) {
    const snapped = this.snapForward(date);
    const idx = this.index.get(dayKey(snapped));
    return idx === undefined ? null : idx;
  },

  /** Axis position -> Date of the working day it falls on. */
  dateOf(pos) {
    const idx = Math.floor(pos + 1e-9);
    if (idx < 0) return this.days[0];
    if (idx >= this.days.length) return this.days[this.days.length - 1];
    return this.days[idx];
  },

  /**
   * Finish date (inclusive) of an interval that ends at `posEnd` (exclusive).
   * A phase occupying exactly one day has posEnd - posStart = 1 and its
   * finish date is the day at posStart.
   */
  finishDateOf(posEnd) {
    const idx = Math.max(0, Math.ceil(posEnd - 1e-9) - 1);
    return this.days[Math.min(idx, this.days.length - 1)];
  },

  /** Duration in working days for a number of hours. */
  hoursToDays(hours) {
    return hours / HOURS_PER_DAY;
  }
};
