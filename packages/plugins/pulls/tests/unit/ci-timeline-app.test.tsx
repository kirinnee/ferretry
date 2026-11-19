/**
 * The timeline as drawn (happy-dom, a fixed `now`): a row and a label per job, the bars where the model puts them, a
 * single tab stop with arrow-key focus, ONE highlight and ONE readout, the now-line only while the run is live, and no
 * movement when the motion switch says stop.
 */
import { interact, type Mounted, mount, must, pressKey } from '@ferretry/app/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { CiTimeline } from '../../app/features/ci-timeline/index.ts';
import { FINISHED, MATRIX, RUNNING } from '../fixtures/ci-timeline-runs.ts';

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
