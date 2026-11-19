import { describe, expect, test } from 'bun:test';
import {
  DRAWN_JOBS,
  DRAWN_STEPS,
  PLOT_MIN_PX,
  barWidth,
  canFit,
  describeMark,
  focusOrder,
  formatOffset,
  formatSpan,
  layoutTimeline,
  listSteps,
  moveFocus,
  plotWidth,
  timelineTicks,
  xOf,
} from '../../app/features/ci-timeline/timeline-model.ts';
import { CiRunSchema } from '../../contract/index.ts';
import {
  BIG_RUN,
  CANCELLED_RUN,
  FINISHED,
  MATRIX,
  RUNNING,
  SNAPSHOT_RUN,
  WAITING_RUN,
  sec,
} from '../fixtures/ci-timeline-runs.ts';

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

describe('the fixtures are real contract shapes', () => {
  test('parse as a CiRun', () => {
    for (const run of [BIG_RUN(), CANCELLED_RUN, SNAPSHOT_RUN, WAITING_RUN])
      expect(CiRunSchema.safeParse(run).success).toBe(true);
  });
});

describe('one clock', () => {
  test('a live step in a cancelled job keeps E8’s end: an hour later it is still inside its job, and so is the span', () => {
    for (const now of [sec(11), sec(3_611)]) {
      const layout = layoutTimeline(CANCELLED_RUN, now);
      const job = row(layout, 'test');
      expect(job.bar).toMatchObject({ startMs: 1_000, endMs: 11_000, live: false });
      expect(job.steps.map(step => [step.startMs, step.endMs])).toEqual([
        [1_000, 2_000],
        [2_000, 11_000],
      ]);
      expect(job.steps[1]).toMatchObject({ live: true, clamped: true });
      expect(layout.spanMs).toBe(11_000);
      expect(layout.wallMs).toBe(11_000);
      expect(layout.nowMs).toBeUndefined();
    }
  });

  test('a live item ticks to now only while its job and its run are live too', () => {
    const at = (run: typeof SNAPSHOT_RUN, seconds: number) => row(layoutTimeline(run, sec(seconds)), 'test');
    expect(at(SNAPSHOT_RUN, 131).bar?.endMs).toBe(131_000);
    expect(at(SNAPSHOT_RUN, 131).steps[0]?.endMs).toBe(131_000);
    const job = SNAPSHOT_RUN.jobs[0];
    if (job === undefined) throw new Error('fixture job');
    // A job that is no longer live keeps E8's end, and so does its still-flagged step.
    const stoppedJob = { ...SNAPSHOT_RUN, jobs: [{ ...job, live: undefined }] };
    expect(at(stoppedJob, 131).bar?.endMs).toBe(1_000);
    expect(at(stoppedJob, 131).steps[0]?.endMs).toBe(1_000);
    // A run that is no longer live keeps E8's end for every level below it.
    const stoppedRun = { ...SNAPSHOT_RUN, live: undefined };
    expect(at(stoppedRun, 131).bar?.endMs).toBe(1_000);
    expect(at(stoppedRun, 131).steps[0]?.endMs).toBe(1_000);
  });

  test('the wall time, the now-line, the span and the wait of a queued job all read the same moment', () => {
    for (const [seconds, ticked] of [
      [1, 1_000],
      [131, 131_000],
    ] as const) {
      const layout = layoutTimeline(SNAPSHOT_RUN, sec(seconds));
      expect(layout.wallMs).toBe(ticked);
      expect(layout.nowMs).toBe(ticked);
      expect(layout.spanMs).toBe(ticked);
      expect(row(layout, 'deploy').queueMs).toBe(ticked);
      expect(layout.queuedMs).toBe(0);
      expect(layout.started).toBe(true);
    }
    // A run that has finished reads E8's numbers for what it recorded, however late it is drawn.
    const done = layoutTimeline(FINISHED.run, sec(99_999));
    expect(done.wallMs).toBe(135_000);
    expect(done.spanMs).toBe(135_000);
    expect(row(done, 'build').queueMs).toBe(10_000);
    expect(layoutTimeline(RUNNING.run, sec(-5)).wallMs).toBe(0);
  });

  test('nothing started: the wait is the clock’s while the run is live, and E8’s once it is not', () => {
    const live = layoutTimeline(WAITING_RUN, sec(131));
    expect(live).toMatchObject({ started: false, queuedMs: 131_000, wallMs: 131_000 });
    expect(row(live, 'build').queueMs).toBe(131_000);
    const stopped = layoutTimeline({ ...WAITING_RUN, live: undefined }, sec(131));
    expect(stopped).toMatchObject({ started: false, queuedMs: 1_000, wallMs: 1_000 });
    expect(row(stopped, 'build').queueMs).toBe(1_000);
    // A check run (no jobs) reads its own wait; the first job's start is for runs that have jobs.
    expect(layoutTimeline({ ...WAITING_RUN, jobs: [] }, sec(131))).toMatchObject({ started: false, queuedMs: 1_000 });
  });

  test('the first job’s wait is its start offset, however late the run is drawn', () => {
    expect(layoutTimeline(RUNNING.run, sec(500))).toMatchObject({ started: true, queuedMs: 8_000 });
    expect(layoutTimeline(FINISHED.run, sec(500))).toMatchObject({ started: true, queuedMs: 10_000 });
  });
});

describe('a run of the biggest size the contract allows', () => {
  const big = BIG_RUN();
  const layout = layoutTimeline(big, sec(20_000));
  const marks = focusOrder(layout);

  test('draws the longest few jobs and, in each, the longest few steps; the rest fold into one mark', () => {
    expect(layout.rows).toHaveLength(DRAWN_JOBS + 1);
    // Jobs are equal: the first of equals are drawn, in their own order, and the folded row is last.
    expect(layout.rows.slice(0, DRAWN_JOBS).map(r => r.jobIndex)).toEqual(
      Array.from({ length: DRAWN_JOBS }, (_, i) => i),
    );
    expect(layout.rows.map(r => r.rowIndex)).toEqual(layout.rows.map((_, i) => i));
    const folded = layout.rows.at(-1);
    expect(folded).toMatchObject({ key: 'jmore', jobIndex: -1, name: '232 shorter jobs', status: 'failed' });
    expect(folded?.bar).toMatchObject({ kind: 'more', count: 232, status: 'failed', rowKey: 'jmore' });
    expect(layout.hiddenJobs).toHaveLength(256 - DRAWN_JOBS);
    expect(layout.hiddenJobs.every(job => job.steps.length === 0 && job.rowIndex === -1 && job.stepCount === 500)).toBe(
      true,
    );
    // 24 job bars, each with 12 steps and one folded mark, then the folded row's bar.
    expect(marks).toHaveLength(DRAWN_JOBS * (1 + DRAWN_STEPS + 1) + 1);
    const first = layout.rows[0];
    expect(first?.steps.slice(0, -1).map(step => step.key)).toEqual(
      Array.from({ length: DRAWN_STEPS }, (_, i) => `j0s${1 + 2 * i}`),
    );
    expect(first?.steps.at(-1)).toMatchObject({ kind: 'more', key: 'j0more', name: '488 shorter steps', count: 488 });
    expect(new Set(marks.map(mark => mark.key)).size).toBe(marks.length);
    for (const mark of marks) {
      expect(mark.startMs).toBeGreaterThanOrEqual(0);
      expect(mark.endMs).toBeLessThanOrEqual(layout.spanMs);
    }
  });

  test('every step is still there as text: the folded ones of a job are exactly the ones not drawn', () => {
    const hidden = listSteps(big, layout, 0);
    expect(hidden).toHaveLength(500 - DRAWN_STEPS);
    const drawn = layout.rows[0]?.steps.filter(step => step.kind === 'step') ?? [];
    expect(new Set([...drawn, ...hidden].map(mark => mark.key)).size).toBe(500);
    // A job that was folded away lists all 500; one that does not exist lists none.
    expect(listSteps(big, layout, 100)).toHaveLength(500);
    expect(listSteps(big, layout, 9_999)).toEqual([]);
  });

  test('the keyboard reaches the folded marks, and the words say what Enter does', () => {
    expect(moveFocus(layout, 'j0s23', 'ArrowRight')).toBe('j0more');
    expect(moveFocus(layout, 'j0more', 'ArrowDown')).toBe('j1more');
    expect(moveFocus(layout, 'j23more', 'ArrowDown')).toBe('jmore');
    const more = layout.rows[0]?.steps.at(-1);
    expect(describeMark(more!, 0)).toContain('job 1 › 488 shorter steps: passed');
    expect(describeMark(more!, 0)).toContain('press Enter to list them');
    expect(describeMark(layout.rows.at(-1)!.bar!, 0)).toContain('232 shorter jobs: failed');
  });
});

describe('folding the small cases', () => {
  const queued = (count: number) => ({
    ...WAITING_RUN,
    jobs: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      name: `job ${index + 1}`,
      status: 'queued' as const,
      queuedMs: 1_000,
      steps: [],
    })),
  });

  test('one job over the limit folds as "1 shorter job"; folded jobs that never started have no bar to draw', () => {
    const layout = layoutTimeline(queued(DRAWN_JOBS + 1), sec(5));
    expect(layout.rows.at(-1)).toMatchObject({ name: '1 shorter job', status: 'queued', bar: undefined, live: false });
    expect(layout.hiddenJobs).toHaveLength(1);
    expect(layoutTimeline(queued(DRAWN_JOBS), sec(5)).hiddenJobs).toEqual([]);
  });

  test('one step over the limit folds as "1 shorter step", wearing the most urgent status of what it holds', () => {
    const step = (number: number, status: 'passed' | 'failed' | 'running', live = false) => ({
      name: `s${number}`,
      number,
      status,
      start: new Date(number === 1 ? sec(55) : sec(number)).toISOString(),
      end: new Date(number === 1 ? sec(56) : sec(number) + 20_000).toISOString(),
      ...(live ? { live: true } : {}),
    });
    const job = {
      id: 1,
      name: 'long',
      status: 'running' as const,
      queuedMs: 0,
      start: new Date(sec(0)).toISOString(),
      end: new Date(sec(100)).toISOString(),
      live: true,
      steps: [step(1, 'failed', true), ...Array.from({ length: DRAWN_STEPS }, (_, i) => step(i + 2, 'passed'))],
    };
    const run = { ...SNAPSHOT_RUN, jobs: [job] };
    const long = row(layoutTimeline(run, sec(60)), 'long');
    expect(long.steps.at(-1)).toMatchObject({ name: '1 shorter step', status: 'failed', live: true, count: 1 });
    expect(long.steps.filter(mark => mark.kind === 'step')).toHaveLength(DRAWN_STEPS);
  });
});
