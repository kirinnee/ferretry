import { describe, expect, test } from 'bun:test';
import {
  PLOT_MIN_PX,
  barWidth,
  canFit,
  describeMark,
  focusOrder,
  formatOffset,
  formatSpan,
  layoutTimeline,
  moveFocus,
  plotWidth,
  timelineTicks,
  xOf,
} from '../../app/features/ci-timeline/timeline-model.ts';
import { FINISHED, MATRIX, RUNNING } from '../fixtures/ci-timeline-runs.ts';

const finished = layoutTimeline(FINISHED.run, FINISHED.now);
const running = layoutTimeline(RUNNING.run, RUNNING.now);
const row = (layout: typeof finished, name: string) => {
  const found = layout.rows.find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(`no row ${name}`);
  return found;
};

describe('the layout of a finished run', () => {
  test('one row per job in the order E8 gives (by start), the skipped job last', () => {
    expect(finished.rows.map(r => r.name)).toEqual(['build', 'test', 'lint']);
    expect(finished.rows.map(r => r.jobIndex)).toEqual([0, 1, 2]);
  });

  test('the axis is the run’s wall time, and a finished run has no now-line', () => {
    expect(finished.spanMs).toBe(FINISHED.run.wallMs);
    expect(finished.spanMs).toBe(135_000);
    expect(finished.nowMs).toBeUndefined();
  });

  test('a job bar and its steps sit at their seconds since the run was created', () => {
    const build = row(finished, 'build');
    expect(build.bar).toMatchObject({ startMs: 10_000, endMs: 70_000, status: 'passed', live: false });
    expect(build.steps.map(s => [s.name, s.startMs, s.endMs])).toEqual([
      ['Set up job', 10_000, 14_000],
      ['Install dependencies', 14_000, 40_000],
      ['Compile', 40_000, 70_000],
    ]);
    // Steps end where the next begins, and none leaves its job.
    for (const step of build.steps) {
      expect(step.startMs).toBeGreaterThanOrEqual(build.bar?.startMs ?? 0);
      expect(step.endMs).toBeLessThanOrEqual(build.bar?.endMs ?? 0);
    }
  });

  test('a failed step keeps its status; a skipped step has no segment', () => {
    const test_ = row(finished, 'test');
    expect(test_.steps.map(s => [s.name, s.status])).toEqual([
      ['Checkout', 'passed'],
      ['Unit tests', 'failed'],
    ]);
    expect(test_.bar?.status).toBe('failed');
  });

  test('queue wait is hatched from the origin to the job’s start; a skipped job waits for nothing and has no bar', () => {
    expect(row(finished, 'build').queueMs).toBe(10_000);
    expect(row(finished, 'test').queueMs).toBe(72_000);
    const lint = row(finished, 'lint');
    expect(lint).toMatchObject({ queueMs: 0, status: 'skipped', steps: [] });
    expect(lint.bar).toBeUndefined();
  });
});

describe('the layout of a running run', () => {
  test('the now-line is at now minus creation, and running bars end there', () => {
    expect(running.nowMs).toBe(95_000);
    expect(running.spanMs).toBe(95_000);
    const test_ = row(running, 'test');
    expect(test_.live).toBe(true);
    expect(test_.bar).toMatchObject({ startMs: 42_000, endMs: 95_000, live: true, status: 'running' });
    expect(test_.steps.at(-1)).toMatchObject({ name: 'Integration tests', endMs: 95_000, live: true });
  });

  test('a queued job waits until now (hatched to the now-line) and draws no bar; an unstarted step draws nothing', () => {
    const deploy = row(running, 'deploy');
    expect(deploy).toMatchObject({ status: 'queued', queueMs: 95_000 });
    expect(deploy.bar).toBeUndefined();
    expect(row(running, 'test').steps.map(s => s.name)).toEqual(['Unit tests', 'Integration tests']);
  });

  test('the same run drawn at a later now moves only the live parts', () => {
    const later = layoutTimeline(RUNNING.run, RUNNING.now + 10_000);
    expect(later.nowMs).toBe(105_000);
    expect(row(later, 'build').bar).toEqual(row(running, 'build').bar);
    expect(row(later, 'test').bar?.endMs).toBe(105_000);
  });
});

describe('a matrix and a run with no jobs', () => {
  const matrix = layoutTimeline(MATRIX.run, MATRIX.now);
  test('parallel jobs overlap in time, each on its own row', () => {
    expect(matrix.rows).toHaveLength(6);
    const bars = matrix.rows.map(r => r.bar);
    expect(bars.every(bar => bar !== undefined)).toBe(true);
    const starts = bars.map(bar => bar?.startMs ?? 0);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // The first job ends after the second begins: a gantt, not a list.
    expect((bars[0]?.endMs ?? 0) > (bars[1]?.startMs ?? 0)).toBe(true);
  });

  test('a run with no jobs (a check run from another CI) is one row with one bar and no steps', () => {
    const lone = layoutTimeline(
      { ...FINISHED.run, jobs: [], name: 'jenkins', wallMs: 40_000, queuedMs: 0 },
      FINISHED.now,
    );
    expect(lone.rows).toHaveLength(1);
    expect(lone.rows[0]).toMatchObject({ name: 'jenkins', steps: [] });
  });
});

describe('the axis', () => {
  test('ticks are round numbers from zero, never more than asked for', () => {
    expect(timelineTicks(135_000, 6).map(t => t.label)).toEqual(['0', '30 s', '1 m', '1 m 30 s', '2 m']);
    expect(timelineTicks(95_000, 4).map(t => t.ms)).toEqual([0, 30_000, 60_000, 90_000]);
    expect(timelineTicks(3_000, 2).map(t => t.ms)).toEqual([0, 2_000]);
    for (const span of [1_000, 59_000, 600_000, 7_200_000, 9e9])
      expect(timelineTicks(span, 5).length).toBeLessThanOrEqual(6);
  });

  test('the words people say', () => {
    expect(formatSpan(0)).toBe('0 s');
    expect(formatSpan(400)).toBe('<1 s');
    expect(formatSpan(45_000)).toBe('45 s');
    expect(formatSpan(88_000)).toBe('1 m 28 s');
    expect(formatSpan(120_000)).toBe('2 m');
    expect(formatSpan(3_900_000)).toBe('1 h 05 m');
    expect(formatOffset(0)).toBe('at creation');
    expect(formatOffset(12_000)).toBe('+12 s');
  });
});

describe('pixels', () => {
  test('x maps the axis onto the plot, minus the right padding; bars are never under 2 px', () => {
    expect(xOf(0, 100_000, 616)).toBe(8);
    expect(xOf(100_000, 100_000, 616)).toBe(600);
    expect(xOf(50_000, 100_000, 616)).toBe(304);
    expect(xOf(900_000, 100_000, 616)).toBe(600);
    expect(barWidth({ startMs: 0, endMs: 1 }, 100_000, 616)).toBe(2);
    expect(barWidth({ startMs: 0, endMs: 50_000 }, 100_000, 616)).toBe(296);
  });

  test('a phone box scrolls at the readable minimum, Fit squeezes into the box, a wide box just fills', () => {
    expect(plotWidth(220, false)).toBe(PLOT_MIN_PX);
    expect(plotWidth(220, true)).toBe(220);
    expect(plotWidth(900, false)).toBe(900);
    expect(canFit(220)).toBe(true);
    expect(canFit(900)).toBe(false);
    expect(canFit(0)).toBe(false);
  });
});

describe('keyboard order', () => {
  test('focus walks a job, then its steps, then the next job', () => {
    expect(focusOrder(finished).map(m => m.key)).toEqual(['j0', 'j0s0', 'j0s1', 'j0s2', 'j1', 'j1s0', 'j1s1']);
  });

  test('left and right walk one row and stop at its edges', () => {
    expect(moveFocus(finished, 'j0', 'ArrowRight')).toBe('j0s0');
    expect(moveFocus(finished, 'j0s2', 'ArrowRight')).toBe('j0s2');
    expect(moveFocus(finished, 'j0s0', 'ArrowLeft')).toBe('j0');
    expect(moveFocus(finished, 'j0', 'ArrowLeft')).toBe('j0');
  });

  test('up and down keep the column, or the last mark of a shorter row; the edge stays put', () => {
    expect(moveFocus(finished, 'j0s1', 'ArrowDown')).toBe('j1s1');
    expect(moveFocus(finished, 'j0s2', 'ArrowDown')).toBe('j1s1');
    expect(moveFocus(finished, 'j1s0', 'ArrowUp')).toBe('j0s0');
    expect(moveFocus(finished, 'j1', 'ArrowDown')).toBe('j1');
    expect(moveFocus(finished, 'j0', 'ArrowUp')).toBe('j0');
  });

  test('Home and End, and an unknown mark starts at the first', () => {
    expect(moveFocus(finished, 'j1s0', 'Home')).toBe('j0');
    expect(moveFocus(finished, 'j0', 'End')).toBe('j1s1');
    expect(moveFocus(finished, undefined, 'ArrowDown')).toBe('j0');
    expect(moveFocus(finished, 'gone', 'ArrowLeft')).toBe('j0');
  });

  test('a row with no bar is skipped by the arrows (the queued job has nothing to land on)', () => {
    expect(focusOrder(running).map(m => m.key)).toEqual(['j0', 'j0s0', 'j1', 'j1s0', 'j1s1']);
    expect(moveFocus(running, 'j1', 'ArrowDown')).toBe('j1');
  });
});

describe('what a mark says', () => {
  test('name, status, start and length; a step names its job; a live bar says so; a job says how long it waited', () => {
    const [job, step] = [row(finished, 'test').bar, row(finished, 'test').steps[1]];
    expect(describeMark(job!, 72_000)).toBe('test: failed, started +1 m 12 s, 1 m 03 s, waited 1 m 12 s first');
    expect(describeMark(step!, 0, () => '09:01:15')).toBe(
      'test › Unit tests: failed, started +1 m 15 s (09:01:15), 55 s',
    );
    expect(describeMark(row(running, 'test').bar!, 42_000)).toContain('running for 53 s');
  });
});
