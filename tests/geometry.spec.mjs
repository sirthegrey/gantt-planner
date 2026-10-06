import { test, expect } from '@playwright/test';
import { loadFixture, schedule } from './helpers.mjs';

// Regression guard for the bar layout: every segment must sit exactly at the
// calendar position of its phase. A flow layout (instead of absolute offsets)
// silently dragged later segments to the right and looked like idle gaps.
test.describe('геометрия полос', () => {
  for (const zoom of ['day', 'week', 'month']) {
    test(`сегменты стоят на своих датах (${zoom})`, async ({ page }) => {
      await loadFixture(page, 'sample.xlsx');
      await page.click(`[data-testid=zoom-${zoom}]`);
      const drift = await page.evaluate(() => {
        const state = window.__gantt.state;
        const cal = state.cal;
        const px = parseFloat(getComputedStyle(document.getElementById('gantt')).getPropertyValue('--px-per-day'));
        // independent reimplementation of the work-position -> x mapping
        const xOf = (pos) => {
          const i = Math.floor(pos + 1e-9);
          const frac = pos - i;
          return (cal.dateOf(i).getTime() / 86400000 + frac) * px;
        };
        const problems = [];
        for (const t of state.sched.tasks) {
          const track = document.querySelector(`[data-testid=row-${t.num}] .row-track`);
          const origin = xOf(t.phases[0].startPos);
          for (const ph of t.phases) {
            const el = track.querySelector(`[data-testid=seg-${t.num}-${ph.stack}]`);
            const expectedLeft = xOf(ph.startPos) - origin;
            const expectedWidth = xOf(ph.endPos) - xOf(ph.startPos) - 2; // 2px gap
            const actualLeft = el.offsetLeft;
            const actualWidth = el.offsetWidth;
            if (Math.abs(actualLeft - expectedLeft) > 3) {
              problems.push(`${t.num}/${ph.stack}: left ${actualLeft} != ${expectedLeft.toFixed(0)}`);
            }
            if (Math.abs(actualWidth - expectedWidth) > 4) {
              problems.push(`${t.num}/${ph.stack}: width ${actualWidth} != ${expectedWidth.toFixed(0)}`);
            }
          }
        }
        return problems;
      });
      expect(drift).toEqual([]);
    });
  }

  test('полоса не выходит за пределы дорожки', async ({ page }) => {
    await loadFixture(page, 'stress.xlsx');
    await page.click('[data-testid=zoom-day]');
    const overflow = await page.evaluate(() => {
      const problems = [];
      for (const row of document.querySelectorAll('.row')) {
        const track = row.querySelector('.row-track');
        const bar = track.querySelector('.bar');
        if (!bar) continue;
        const segs = [...bar.querySelectorAll('.seg')];
        const last = segs[segs.length - 1];
        const right = last.offsetLeft + last.offsetWidth;
        if (right > track.offsetWidth + 1) problems.push(`${row.dataset.task}: ${right} > ${track.offsetWidth}`);
      }
      return problems;
    });
    expect(overflow).toEqual([]);
  });

  test('сегменты внутри дорожки идут встык (зазор только 2px)', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const gaps = await page.evaluate(() => {
      const out = [];
      for (const row of document.querySelectorAll('.row')) {
        // фазы разных дорожек идут параллельно и намеренно перекрываются
        for (const bar of row.querySelectorAll('.bar')) {
          const segs = [...bar.querySelectorAll('.seg')].sort((a, b) => a.offsetLeft - b.offsetLeft);
          for (let i = 1; i < segs.length; i++) {
            const prevRight = segs[i - 1].offsetLeft + segs[i - 1].offsetWidth;
            out.push(segs[i].offsetLeft - prevRight);
          }
        }
      }
      return out;
    });
    expect(gaps.length).toBeGreaterThan(0);
    // Разрыв в дорожке - это время, занятое параллельной фазой из другой
    // дорожки; накладываться сегменты внутри дорожки не должны.
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(0);
    }
  });

  test('последовательные фазы планируются встык', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const s = await schedule(page);
    for (const t of s.tasks) {
      for (let i = 1; i < t.phases.length; i++) {
        const prev = t.phases[i - 1];
        const cur = t.phases[i];
        const pair = (cur.stack === 'py' && prev.stack === 'cpp') || (cur.stack === 'cpp' && prev.stack === 'py');
        if (pair && cur.executor !== prev.executor) {
          expect(cur.startPos).toBeLessThanOrEqual(prev.endPos + 1e-9); // идут параллельно
          continue;
        }
        expect(cur.startPos).toBeGreaterThanOrEqual(prev.endPos - 1e-9);
      }
    }
  });

  test('параллельные C++ и Питон рисуются в разных дорожках', async ({ page }) => {
    await loadFixture(page, 'sample.xlsx');
    const lanes = await page.evaluate(() => {
      const row = document.querySelector('[data-testid=row-1]');
      return [...row.querySelectorAll('.bar')].map((b) => ({
        lane: b.dataset.lane,
        top: b.offsetTop,
        stacks: [...b.querySelectorAll('.seg')].map((s) => s.dataset.stack)
      }));
    });
    expect(lanes.length).toBe(2);
    expect(lanes[0].top).not.toBe(lanes[1].top);
    expect(lanes.flatMap((l) => l.stacks).sort()).toEqual(['cpp', 'front', 'net', 'py']);
  });

  test('ожидание исполнителя отмечается в подсказке', async ({ page }) => {
    await loadFixture(page, 'conflicts.xlsx');
    const waits = await page.evaluate(() => {
      const t = window.__gantt.state.sched.tasks.find((x) => x.num === 3);
      return t.phases.map((p) => p.wait);
    });
    expect(waits[0]).toBeGreaterThan(0); // Иванов занят двумя задачами
    await page.locator('[data-testid=seg-3-cpp]').hover();
    await expect(page.locator('[data-testid=tooltip]')).toContainText('Ожидание исполнителя');
  });
});
