/**
 * The timeline as drawn (happy-dom, a fixed `now`): a row and a label per job, the bars where the model puts them, a
 * single tab stop with arrow-key focus, ONE highlight and ONE readout, the now-line only while the run is live, and no
 * movement when the motion switch says stop.
 */
import { interact, type Mounted, mount, must, pressKey } from '@ferretry/app/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { CiTimeline } from '../../app/features/ci-timeline/index.ts';
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

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  delete document.documentElement.dataset.motion;
});

const marks = (c: HTMLElement) => [...c.querySelectorAll<SVGElement>('[data-mark]')];
const readout = (c: HTMLElement) =>
  must(c.querySelector('[data-ci-timeline-readout]'), 'the readout').textContent ?? '';
const tabStops = (c: HTMLElement) => marks(c).filter(mark => mark.getAttribute('tabindex') === '0');

describe('the drawn timeline', () => {
  test('a label row and a row of bars per job, in the model’s order, with a hit target per mark', async () => {
    mounted = await mount(<CiTimeline run={FINISHED.run} now={FINISHED.now} />);
    const c = mounted.container;
    expect([...c.querySelectorAll('[data-ci-timeline-row]')].map(r => r.getAttribute('data-ci-timeline-row'))).toEqual([
      'j0',
      'j1',
      'j2',
    ]);
    expect(c.textContent).toContain('build');
    expect(c.textContent).toContain('lint');
    expect(marks(c).map(m => m.getAttribute('data-mark'))).toEqual([
      'j0',
      'j0s0',
      'j0s1',
      'j0s2',
      'j1',
      'j1s0',
      'j1s1',
    ]);
    // Steps are segments; the skipped job has no bar and no hit target.
    expect(c.querySelectorAll('[data-step]')).toHaveLength(5);
    expect(c.querySelector('[data-job-bar="j2"]')).toBeNull();
    // Queue wait is hatched for every job that waited, and says so in the legend.
    expect(c.querySelectorAll('[data-queue]')).toHaveLength(2);
    expect(must(c.querySelector('[data-ci-timeline-legend]'), 'legend').textContent).toContain('Waiting to start');
  });

  test('every status has a word for a screen reader, not only a colour', async () => {
    mounted = await mount(<CiTimeline run={FINISHED.run} now={FINISHED.now} />);
    const labels = [...mounted.container.querySelectorAll('[data-ci-timeline-row]')].map(r => r.textContent ?? '');
    expect(labels[0]).toContain('Passed');
    expect(labels[1]).toContain('Failed');
    expect(labels[2]).toContain('Skipped');
    for (const mark of marks(mounted.container)) expect(mark.getAttribute('aria-label')).toMatch(/passed|failed/);
  });

  test('the chart is ONE tab stop; arrows move it and the readout follows; one ring marks the focused bar', async () => {
    mounted = await mount(<CiTimeline run={FINISHED.run} now={FINISHED.now} />);
    const c = mounted.container;
    expect(tabStops(c).map(m => m.getAttribute('data-mark'))).toEqual(['j0']);
    expect(c.querySelector('[data-ring]')).toBeNull();
    const svg = must(c.querySelector('[role="listbox"]'), 'the chart');

    await interact(() => must(c.querySelector<SVGElement>('[data-mark="j0"]'), 'job').focus());
    expect(readout(c)).toContain('build: passed');

    await interact(() => pressKey(svg, 'ArrowRight'));
    expect(tabStops(c).map(m => m.getAttribute('data-mark'))).toEqual(['j0s0']);
    expect(readout(c)).toContain('build › Set up job: passed, started +10 s');
    expect(c.querySelectorAll('[data-ring]')).toHaveLength(1);
    expect(c.querySelector('[data-ring]')?.getAttribute('data-ring')).toBe('j0s0');

    await interact(() => pressKey(svg, 'ArrowDown'));
    expect(tabStops(c).map(m => m.getAttribute('data-mark'))).toEqual(['j1s0']);
    expect(readout(c)).toContain('test › Checkout');
    await interact(() => pressKey(svg, 'End'));
    expect(readout(c)).toContain('test › Unit tests: failed');
    expect(c.querySelectorAll('[data-ring]')).toHaveLength(1);
  });

  test('hover lights ONE bar and shows its line; leaving clears it', async () => {
    mounted = await mount(<CiTimeline run={FINISHED.run} now={FINISHED.now} />);
    const c = mounted.container;
    const first = must(c.querySelector('[data-mark="j1s1"]'), 'a step');
    await interact(() => first.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
    expect(readout(c)).toContain('Unit tests');
    expect(c.querySelectorAll('[data-ring]')).toHaveLength(1);
    await interact(() => first.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
    expect(c.querySelector('[data-ring]')).toBeNull();
    expect(readout(c)).toContain('Hover or focus a bar');
  });

  test('the idle readout says what the run is: status, attempt, total, and the wait before the first job', async () => {
    mounted = await mount(<CiTimeline run={FINISHED.run} now={FINISHED.now} />);
    expect(readout(mounted.container)).toContain('CI: failed, attempt 1, took 2 m 15 s, first job started after 10 s');
  });
});

describe('a live run', () => {
  test('has a now-line at now, a Running legend entry, and pulses only when motion is allowed', async () => {
    mounted = await mount(<CiTimeline run={RUNNING.run} now={RUNNING.now} />);
    const c = mounted.container;
    expect(c.querySelector('[data-now-line]')).not.toBeNull();
    expect(c.querySelector('[data-now-line] animate')).not.toBeNull();
    expect(must(c.querySelector('[data-ci-timeline-legend]'), 'legend').textContent).toContain('Running');
    document.documentElement.dataset.motion = 'reduced';
    await mounted.render(<CiTimeline run={RUNNING.run} now={RUNNING.now} />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(c.querySelector('[data-now-line]')).not.toBeNull();
    expect(c.querySelector('[data-now-line] animate')).toBeNull();
  });

  test('a finished run has no now-line', async () => {
    mounted = await mount(<CiTimeline run={FINISHED.run} now={FINISHED.now} />);
    expect(mounted.container.querySelector('[data-now-line]')).toBeNull();
  });

  test('the still frame draws the same bars as the moving one (motion only changes the pulse)', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<CiTimeline run={RUNNING.run} now={RUNNING.now} />);
    const still = [...mounted.container.querySelectorAll('[data-step]')].map(e => e.getAttribute('width'));
    delete document.documentElement.dataset.motion;
    await mounted.render(<CiTimeline run={RUNNING.run} now={RUNNING.now} />);
    expect([...mounted.container.querySelectorAll('[data-step]')].map(e => e.getAttribute('width'))).toEqual(still);
  });
});

describe('a matrix', () => {
  test('six jobs draw six rows and every step of every job', async () => {
    mounted = await mount(<CiTimeline run={MATRIX.run} now={MATRIX.now} />);
    expect(mounted.container.querySelectorAll('[data-ci-timeline-row]')).toHaveLength(6);
    expect(mounted.container.querySelectorAll('[data-step]')).toHaveLength(18);
  });
});

const items = (c: HTMLElement) => [...c.querySelectorAll('[data-ci-timeline-item]')];
const toggle = (details: HTMLDetailsElement, open: boolean) => {
  details.open = open;
  details.dispatchEvent(new window.Event('toggle'));
};

describe('one clock', () => {
  test('a live run drawn a minute later says the later numbers, never the snapshot’s', async () => {
    mounted = await mount(<CiTimeline run={SNAPSHOT_RUN} now={sec(131)} />);
    const c = mounted.container;
    expect(readout(c)).toContain('CI: running, attempt 1, running for 2 m 11 s, first job started after 0 s.');
    expect(must(c.querySelector('[data-row="j1"] [data-queue]'), 'the queue hatch').getAttribute('data-queue')).toBe(
      'j1',
    );
    expect(must(c.querySelector('[data-ci-timeline-row="j1"]'), 'the label').textContent).toContain('waited 2 m 11 s');
    expect(must(c.querySelector('[data-ci-timeline-row="j0"]'), 'the label').textContent).toContain('running 2 m 11 s');
  });

  test('nothing started yet: the readout says it is still waiting, on the clock', async () => {
    mounted = await mount(<CiTimeline run={WAITING_RUN} now={sec(131)} />);
    expect(readout(mounted.container)).toContain('still waiting to start (2 m 11 s)');
  });

  test('a cancelled job’s still-flagged step is drawn inside its job at any hour', async () => {
    mounted = await mount(<CiTimeline run={CANCELLED_RUN} now={sec(3_611)} />);
    const c = mounted.container;
    const job = must(c.querySelector('[data-job-bar="j0"]'), 'the job');
    const step = must(c.querySelector('[data-step="j0s1"]'), 'the step');
    const right = (el: Element) => Number(el.getAttribute('x')) + Number(el.getAttribute('width'));
    expect(right(step)).toBeLessThanOrEqual(right(job) + 1);
    expect(c.querySelector('[data-now-line]')).toBeNull();
    expect(readout(c)).toContain('took 11 s');
  });
});

describe('a run of the biggest size the contract allows', () => {
  const big = BIG_RUN();
  const now = sec(20_000);

  test('mounts with a bounded number of marks, the folded ones in the keyboard order, the list closed', async () => {
    mounted = await mount(<CiTimeline run={big} now={now} />);
    const c = mounted.container;
    expect(c.querySelectorAll('[data-ci-timeline-row]')).toHaveLength(25);
    expect(c.querySelectorAll('[data-step]')).toHaveLength(24 * 12);
    expect(c.querySelectorAll('[data-more]')).toHaveLength(24);
    expect(marks(c)).toHaveLength(24 * 14 + 1);
    expect(marks(c).map(m => m.getAttribute('data-mark'))).toContain('jmore');
    expect(must(c.querySelector('[data-ci-timeline-row="jmore"]'), 'the folded row').textContent).toContain(
      '232 shorter jobs',
    );
    expect(items(c)).toHaveLength(0);
    expect(must(c.querySelector('[data-ci-timeline-more] summary'), 'summary').textContent).toBe(
      'List 232 shorter jobs and 11712 shorter steps',
    );
    expect(readout(c)).toContain('CI: failed, attempt 1');
  });

  test('a click on a folded step mark opens the list at that job; every folded step is a line of text', async () => {
    mounted = await mount(<CiTimeline run={big} now={now} />);
    const c = mounted.container;
    await interact(() =>
      must(c.querySelector('[data-mark="j0more"]'), 'a folded mark').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(must(c.querySelector<HTMLDetailsElement>('[data-ci-timeline-more]'), 'list').open).toBe(true);
    expect(c.querySelectorAll('[data-ci-timeline-fold="j0"] [data-ci-timeline-item]')).toHaveLength(488);
    expect(items(c).some(item => item.getAttribute('data-ci-timeline-item') === 'j0s0')).toBe(true);
    // The hidden jobs are one line each; their steps stay closed until asked for.
    expect(c.querySelectorAll('li[data-ci-timeline-item^="j"][data-status]')).toHaveLength(488 + 232);
    expect(c.querySelector('[data-ci-timeline-fold="j100"] [data-ci-timeline-item]')).toBeNull();
    expect(must(c.querySelector('[data-ci-timeline-fold="j100"] summary'), 'a hidden job').textContent).toBe(
      '500 steps',
    );

    await interact(() =>
      toggle(must(c.querySelector<HTMLDetailsElement>('[data-ci-timeline-fold="j100"]'), 'fold'), true),
    );
    expect(c.querySelectorAll('[data-ci-timeline-fold="j100"] [data-ci-timeline-item]')).toHaveLength(500);
    await interact(() =>
      toggle(must(c.querySelector<HTMLDetailsElement>('[data-ci-timeline-fold="j100"]'), 'fold'), false),
    );
    expect(c.querySelector('[data-ci-timeline-fold="j100"] [data-ci-timeline-item]')).toBeNull();
    await interact(() => toggle(must(c.querySelector<HTMLDetailsElement>('[data-ci-timeline-more]'), 'list'), false));
    expect(items(c)).toHaveLength(0);
  });

  test('Enter or Space on a focused folded mark opens the list; the folded-jobs mark opens it without a fold', async () => {
    mounted = await mount(<CiTimeline run={big} now={now} />);
    const c = mounted.container;
    const chart = must(c.querySelector('[role="listbox"]'), 'the chart');
    await interact(() => must(c.querySelector<SVGElement>('[data-mark="j1more"]'), 'a folded mark').focus());
    expect(readout(c)).toContain('job 2 › 488 shorter steps');
    expect(readout(c)).toContain('press Enter to list them');
    expect(c.querySelector('[data-ring="j1more"]')).not.toBeNull();
    await interact(() => pressKey(chart, 'Enter'));
    expect(c.querySelectorAll('[data-ci-timeline-fold="j1"] [data-ci-timeline-item]')).toHaveLength(488);
    await interact(() => must(c.querySelector<SVGElement>('[data-mark="jmore"]'), 'folded jobs').focus());
    expect(c.querySelector('[data-ring="jmore"]')).not.toBeNull();
    await interact(() => pressKey(chart, ' '));
    expect(must(c.querySelector<HTMLDetailsElement>('[data-ci-timeline-more]'), 'list').open).toBe(true);
    // Enter on an ordinary bar does nothing.
    await interact(() => must(c.querySelector<SVGElement>('[data-mark="j0s1"]'), 'a step').focus());
    await interact(() => pressKey(chart, 'Enter'));
    expect(c.querySelector('[data-ci-timeline-fold="j0"]')?.hasAttribute('open')).toBe(false);
  });

  test('a folded job that never started is a line of words, not a bar; a lone folded job and step read in the singular', async () => {
    const queued = {
      ...WAITING_RUN,
      jobs: Array.from({ length: 25 }, (_, index) => ({
        id: index + 1,
        name: `job ${index + 1}`,
        status: 'queued' as const,
        queuedMs: 1_000,
        steps: [],
      })),
    };
    mounted = await mount(<CiTimeline run={queued} now={sec(5)} />);
    const c = mounted.container;
    expect(must(c.querySelector('[data-ci-timeline-more] summary'), 'summary').textContent).toBe('List 1 shorter job');
    await interact(() => toggle(must(c.querySelector<HTMLDetailsElement>('[data-ci-timeline-more]'), 'list'), true));
    expect(items(c).map(item => item.textContent)).toEqual(['job 25: queued']);
    expect(c.querySelector('[data-ci-timeline-fold]')).toBeNull();

    const step = (number: number) => ({
      name: `s${number}`,
      number,
      status: 'passed' as const,
      start: new Date(sec(number)).toISOString(),
      end: new Date(sec(number) + (number === 13 ? 1 : 5_000)).toISOString(),
    });
    const job = {
      id: 1,
      name: 'long',
      status: 'passed' as const,
      queuedMs: 0,
      steps: Array.from({ length: 13 }, (_, i) => step(i + 1)),
    };
    await mounted.render(<CiTimeline run={{ ...FINISHED.run, jobs: [job] }} now={sec(500)} />);
    expect(must(c.querySelector('[data-ci-timeline-more] summary'), 'summary').textContent).toBe('List 1 shorter step');
  });
});
