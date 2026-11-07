import { afterEach, describe, expect, it } from 'bun:test';
import { FerretLessonsPanel, type FerretLessonsPanelProps } from '../../../app/src/ferret-lessons-panel.tsx';
import { byText, click, textOf, waitFor, waitForText } from '../../support/app/dom-helpers.ts';
import { type Mounted, mount, must } from '../../support/app/dom.ts';
import { AT, directory, type FakeLessonsDaemon, fakeLessonsDaemon } from '../../support/app/lessons.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const panel = (daemon: FakeLessonsDaemon, props: Partial<FerretLessonsPanelProps> = {}) => (
  <FerretLessonsPanel
    connection={daemon.connection}
    ferretId="ferret-hadi"
    ferrets={directory}
    // A running scan is re-read every 2s in production; at that pace the next read raced every wait below.
    scanPollMs={5}
    {...props}
  />
);

const passiveSwitch = (root: HTMLElement) => must(root.querySelector<HTMLInputElement>('[role="switch"]'), 'switch');

describe('Lessons in a ferret’s toolbar', () => {
  it('switches passive lessons, saying what the daemon did, and reports a refusal beside it', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.state.ferrets = [{ ferretId: 'ferret-hadi', passive: false, since: AT, setBy: 'default' }];
    mounted = await mount(panel(daemon));
    const root = mounted.container;
    await waitFor(() => daemon.calls.some(call => call.route === 'GET /v1/lessons/ferrets'), 'the ferrets read');
    await waitFor(() => !passiveSwitch(root).disabled, 'the switch to enable');
    expect(passiveSwitch(root).checked).toBe(false);
    expect(textOf(root)).toContain('Off');
    await click(passiveSwitch(root));
    await waitForText(root, 'Re-instructed; it costs one turn.');
    expect(daemon.calls.at(-1)).toMatchObject({
      route: 'PATCH /v1/ferrets/:ferretId/lessons',
      params: { ferretId: 'ferret-hadi' },
      body: { passive: true },
    });
    const note = must(root.querySelector('[data-lessons-action-note]'), 'note');
    expect(note.getAttribute('role')).toBe('status');
    await waitFor(() => passiveSwitch(root).checked, 'the switch to flip on');
    expect(textOf(root)).toContain('On');
    await click(must(note.querySelector('button[aria-label="Dismiss"]'), 'Dismiss'));
    expect(root.querySelector('[data-lessons-action-note]')).toBeNull();

    daemon.once('PATCH /v1/ferrets/:ferretId/lessons', {
      refuse: { status: 403, code: 'grant_refused', message: 'fleet.use is closed' },
    });
    await click(passiveSwitch(root));
    await waitForText(root, 'fleet.use is closed');
  });

  it('opens the scan dialog scoped to this ferret, and View in Lessons goes to the screen', async () => {
    const daemon = fakeLessonsDaemon();
    const viewed: string[] = [];
    mounted = await mount(panel(daemon, { onViewLessons: () => viewed.push('screen') }));
    const root = mounted.container;
    await click(byText(root, 'button', 'Scan this ferret for lessons'));
    await waitForText(root, 'Nothing runs until you press Start.');
    const estimate = daemon.calls.find(call => call.route === 'POST /v1/lessons/scan/estimate');
    expect(estimate?.body).toEqual({ scope: { kind: 'ferrets', ferretIds: ['ferret-hadi'] } });
    // The scan never starts by itself.
    expect(daemon.calls.some(call => call.route === 'POST /v1/lessons/scan')).toBe(false);
    await click(byText(root, 'button', 'Start scan'));
    await waitForText(root, 'You can close this; the scan keeps going');
    daemon.state.scan = { ...must(daemon.state.scan, 'scan'), state: 'finished', added: 1, done: 4 };
    await waitForText(root, 'Added 1 lesson to To review.');
    await click(byText(root, 'button', 'View in Lessons'));
    expect(viewed).toEqual(['screen']);
    expect(root.querySelector('[role="dialog"]')).toBeNull();

    await click(byText(root, 'button', 'Scan this ferret for lessons'));
    await waitForText(root, 'Scan for lessons');
    await click(byText(root, 'footer button', 'Cancel'));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a View in Lessons with no screen to go to just closes', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.state.scan = { runId: 'r', state: 'running', total: 2, done: 0, startedAt: AT, added: 0, merged: 0 };
    mounted = await mount(panel(daemon, { ferrets: null }));
    const root = mounted.container;
    await click(byText(root, 'button', 'Scan this ferret for lessons'));
    await waitForText(root, 'Reading ferret 1 of 2…');
    daemon.state.scan = { ...daemon.state.scan, state: 'finished', done: 2 };
    await waitForText(root, 'No new lessons.');
    await click(byText(root, 'button', 'View in Lessons'));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the switch disabled, never off, for a daemon that cannot answer', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.once('GET /v1/lessons/ferrets', { refuse: { status: 404, code: 'not_found', message: 'no such route' } });
    mounted = await mount(panel(daemon));
    await waitFor(() => daemon.calls.some(call => call.route === 'GET /v1/lessons/ferrets'), 'the read');
    expect(passiveSwitch(mounted.container).disabled).toBe(true);
    expect(textOf(mounted.container)).not.toContain('Off');
  });
});
