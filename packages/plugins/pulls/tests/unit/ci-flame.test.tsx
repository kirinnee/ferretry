import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { CiRunSchema } from '../../contract/index.ts';
import { barLabel, CiFlame, flameNote, formatDuration } from '../../app/features/ci-flame/index.ts';
import { buildFlame, findPath, layoutBars, rowTotals } from '../../app/features/ci-flame/model.ts';
import { CHECK_RUN, FAILED_RUN, QUEUED_RUN, RUNNING_RUN, secondsAfterT0 } from '../fixtures/flame-runs.ts';

const NOW = secondsAfterT0(300);
const RUNNING_NOW = secondsAfterT0(100);

describe('the fixtures are real contract shapes', () => {
  it('parse as a CiRun', () => {
    for (const run of [FAILED_RUN, RUNNING_RUN, CHECK_RUN, QUEUED_RUN])
      expect(CiRunSchema.safeParse(run).success).toBe(true);
  });
});

describe('formatDuration', () => {
  it('reads at a glance', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(4_200)).toBe('4.2 s');
    expect(formatDuration(38_000)).toBe('38 s');
    expect(formatDuration(60_000)).toBe('1 m');
    expect(formatDuration(200_000)).toBe('3 m 20 s');
    expect(formatDuration(3_900_000)).toBe('1 h 05 m');
  });
});

describe('the flame model', () => {
  const flame = buildFlame(FAILED_RUN, NOW);
  const root = must(flame.root ?? null, 'a root');

  it('the run adds its jobs; a job holds its steps; widths sum per level', () => {
    expect(root.ms).toBe(38_000 + 252_000 + 110_000);
    expect(root.children.map(job => [job.name, job.ms])).toEqual([
      ['lint', 38_000],
      ['test', 252_000],
      ['build', 110_000],
    ]);
    const totals = rowTotals(layoutBars(root));
    expect(totals[0]).toBe(100);
    expect(totals[1]).toBeCloseTo(100, 9);
    // Steps never add up to more than their job: the gap is the job's own setup and teardown.
    expect(totals[2] ?? 0).toBeLessThanOrEqual(100 + 1e-9);
    for (const job of root.children)
      expect(job.children.reduce((sum, step) => sum + step.ms, 0)).toBeLessThanOrEqual(job.ms);
  });

  it('a skipped job, a skipped step and an instant step are counted, never drawn', () => {
    // docs (skipped) + its one step + build's skipped "Notify".
    expect(flame.unplotted).toBe(3);
    expect(root.children.map(job => job.name)).not.toContain('docs');
    expect(JSON.stringify(root)).not.toContain('Notify');
  });

  it('a bar’s share of the zoomed bar: the test job is 63% of the total, its widest step is longest', () => {
    const bars = layoutBars(root);
    const test = must(bars.find(bar => bar.node.key === 'job:2') ?? null, 'the test job');
    expect(test.x).toBeCloseTo(9.5, 9);
    expect(test.width).toBeCloseTo(63, 9);
    const path = must(findPath(root, 'step:2:4') ?? null, 'the unit tests step');
    expect(path.map(node => node.kind)).toEqual(['run', 'job', 'step']);
    expect(findPath(root, 'step:2:99')).toBeUndefined();
  });

  it('zooming into a job lays out only that job; its bar fills row 0', () => {
    const job = must(findPath(root, 'job:2')?.at(-1) ?? null, 'the test job');
    const bars = layoutBars(job);
    expect(bars[0]).toMatchObject({ row: 0, x: 0, width: 100 });
    expect(bars.every(bar => bar.row <= 1)).toBe(true);
    expect(bars.filter(bar => bar.row === 1)).toHaveLength(5);
  });

  it('a running item ends at now and is flagged live; a queued run has no bars; a check is one bar', () => {
    const running = must(buildFlame(RUNNING_RUN, RUNNING_NOW).root ?? null, 'a root');
    const live = must(findPath(running, 'step:6:3')?.at(-1) ?? null, 'the live step');
    expect(live).toMatchObject({ live: true, ms: 50_000, status: 'running' });
    expect(buildFlame(RUNNING_RUN, secondsAfterT0(130)).root?.children[1]?.children[2]?.ms).toBe(80_000);
    expect(buildFlame(QUEUED_RUN, NOW)).toEqual({ root: undefined, unplotted: 1 });
    const check = must(buildFlame(CHECK_RUN, NOW).root ?? null, 'a root');
    expect(check).toMatchObject({ kind: 'run', ms: 75_000, children: [] });
  });
});

describe('a bar’s words', () => {
  const node = must(buildFlame(FAILED_RUN, NOW).root?.children[1]?.children[3] ?? null, 'the unit tests step');
  it('all of it when it fits, the name cut with an ellipsis when only that fits, nothing when neither does', () => {
    expect(barLabel(node, 0)).toBe('Unit tests · 2 m 58 s');
    expect(barLabel(node, 400)).toBe('Unit tests · 2 m 58 s');
    expect(barLabel(node, 100)).toBe('Unit tests');
    expect(barLabel(node, 60)).toBe('Unit …');
    expect(barLabel(node, 20)).toBe('');
  });
});

describe('the sentence under the chart', () => {
  it('says the total is longer than the wall time when jobs ran in parallel, and does not when they did not', () => {
    expect(flameNote(400_000, 262_000)).toBe(
      'Width is time spent. Parallel jobs add up, so the total (6\u00a0m\u00a040\u00a0s) is longer than the run’s wall time (4\u00a0m\u00a022\u00a0s).',
    );
    expect(flameNote(75_000, 75_000)).toBe(
      'Width is time spent. The total (1\u00a0m\u00a015\u00a0s) fits inside the run’s wall time (1\u00a0m\u00a015\u00a0s).',
    );
  });
});

const bar = (container: HTMLElement, key: string): Element =>
  must(container.querySelector(`[data-flame-bar="${key}"]`), `bar ${key}`);
const keys = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-flame-bar]')].map(element => element.getAttribute('data-flame-bar') ?? '');
const trail = (container: HTMLElement): string =>
  (container.querySelector('.fy-flame-trail')?.textContent ?? '').replace(/›/gu, ' › ').replace(/\s+/gu, ' ').trim();

describe('the flamegraph', () => {
  it('draws the run, its jobs, then their steps, colours them by status and says what width means', async () => {
    const view = await mount(<CiFlame run={FAILED_RUN} nowMs={NOW} />);
    const all = keys(view.container);
    expect(all[0]).toBe('run');
    expect(all).toContain('job:1');
    expect(all).toContain('step:2:4');
    expect(all).not.toContain('job:4');
    expect(bar(view.container, 'run').getAttribute('data-status')).toBe('failed');
    expect(bar(view.container, 'job:1').getAttribute('data-status')).toBe('passed');
    expect(bar(view.container, 'step:2:4').getAttribute('data-status')).toBe('failed');
    expect(bar(view.container, 'step:2:4').getAttribute('aria-label')).toBe(
      'Step Unit tests · failed · 2 m 58 s · 45% of CI',
    );
    expect(view.container.querySelector('[data-flame-note]')?.textContent).toBe(flameNote(400_000, 262_000));
    expect(view.container.querySelector('[data-flame-unplotted]')?.textContent).toContain(
      '3 items have no time to draw',
    );
    expect(trail(view.container)).toBe('CI');
    await view.unmount();
  });

  it('a click zooms into a job, the breadcrumb goes back, and the chart is whole again', async () => {
    const view = await mount(<CiFlame run={FAILED_RUN} nowMs={NOW} />);
    await interact(() =>
      (bar(view.container, 'job:2') as unknown as HTMLElement).dispatchEvent(
        new window.MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(keys(view.container)).toEqual(['job:2', 'step:2:1', 'step:2:2', 'step:2:3', 'step:2:4', 'step:2:5']);
    expect(bar(view.container, 'job:2').getAttribute('width')).toBe('100%');
    expect(trail(view.container)).toBe('CI › test');
    expect(view.container.querySelector('[data-flame-note]')?.textContent).toBe(flameNote(400_000, 262_000));
    const back = must(view.container.querySelector<HTMLButtonElement>('.fy-flame-back'), 'the CI breadcrumb');
    await interact(() => back.click());
    expect(keys(view.container)).toContain('job:1');
    expect(trail(view.container)).toBe('CI');
    await view.unmount();
  });

  it('a step is a leaf: a click picks it and shows it in the readout without zooming', async () => {
    const view = await mount(<CiFlame run={FAILED_RUN} nowMs={NOW} />);
    const before = keys(view.container);
    await interact(() =>
      (bar(view.container, 'step:2:4') as unknown as HTMLElement).dispatchEvent(
        new window.MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(keys(view.container)).toEqual(before);
    expect(view.container.querySelector('[data-flame-readout]')?.textContent).toBe(
      'Step Unit tests · failed · 2 m 58 s · 45% of CI',
    );
    // One highlight: the picked bar is the only one marked.
    expect([...view.container.querySelectorAll('[data-shown]')].map(el => el.getAttribute('data-flame-bar'))).toEqual([
      'step:2:4',
    ]);
    await view.unmount();
  });

  it('Enter on a focused bar zooms like a click', async () => {
    const view = await mount(<CiFlame run={FAILED_RUN} nowMs={NOW} />);
    const target = bar(view.container, 'job:3') as unknown as HTMLElement;
    expect(target.getAttribute('tabindex')).toBe('0');
    await interact(() => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(trail(view.container)).toBe('CI › build');
    await view.unmount();
  });

  it('a running run flags its live bars; a queued run says nothing has started; a check is one bar', async () => {
    const running = await mount(<CiFlame run={RUNNING_RUN} nowMs={RUNNING_NOW} />);
    expect(bar(running.container, 'step:6:3').hasAttribute('data-live')).toBe(true);
    expect(bar(running.container, 'step:6:3').getAttribute('data-status')).toBe('running');
    expect(bar(running.container, 'step:6:3').getAttribute('aria-label')).toBe(
      'Step Unit tests · running · 50 s · 41% of CI',
    );
    await running.unmount();

    const queued = await mount(<CiFlame run={QUEUED_RUN} nowMs={NOW} />);
    expect(queued.container.querySelector('[data-flame-empty]')?.textContent).toContain(
      'nothing in this run has started',
    );
    expect(queued.container.querySelector('[data-flame-bar]')).toBeNull();
    await queued.unmount();

    const check = await mount(<CiFlame run={CHECK_RUN} nowMs={NOW} />);
    expect(keys(check.container)).toEqual(['run']);
    await check.unmount();
  });
});
