import { afterEach, describe, expect, it } from 'bun:test';
import { useState } from 'react';
import {
  type LearningActionContext,
  type LearningSessionActionsOptions,
  useLearningSessionActions,
} from '../../../../src/features/learning/learning-session-actions.tsx';
import { ActionsMenu } from '../../../../src/features/session-actions/actions-menu.tsx';
import { sessionActionSections } from '../../../../src/features/session-actions/registry.ts';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { AT, type FakeLearningDaemon, fakeLearningDaemon, learningDaemon } from '../../../support/learning.ts';
import { byText, click, textOf, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const HADI = sessionView('session-hadi', { config: { teammate: 'hadi', cwd: '/work/ferretry' } });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** The page's part: the registry's sections for this ferret, drawn by the real menu, beside the host. */
function Page({
  daemon,
  canControl,
  options = {},
  failures,
}: {
  readonly daemon: FakeLearningDaemon;
  readonly canControl: boolean;
  readonly options?: Partial<LearningSessionActionsOptions>;
  readonly failures: string[];
}) {
  const { contributions, host } = useLearningSessionActions({
    connection: learningDaemon,
    fetcher: daemon.fetch,
    sessions: [HADI],
    ...options,
  });
  const [form, setForm] = useState<string | null>(null);
  const context: LearningActionContext = { view: HADI, canControl };
  return (
    <>
      <ActionsMenu
        sections={sessionActionSections(contributions, context)}
        compact={false}
        name="Hadi"
        form={form}
        onFormChange={setForm}
        onFailure={sentence => failures.push(sentence)}
      />
      {host}
    </>
  );
}

const openMenu = async (root: HTMLElement) =>
  click(must(root.querySelector('[data-session-actions-trigger]'), 'Actions trigger'));
const item = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-session-action-item="${id}"]`);

describe('Learning in a ferret’s Actions menu', () => {
  it('switches passive learning, saying what the daemon did, and reports a refusal through the menu', async () => {
    const daemon = fakeLearningDaemon();
    daemon.state.sessions = [{ sessionId: 'session-hadi', passive: false, since: AT, setBy: 'default' }];
    const failures: string[] = [];
    mounted = await mount(<Page daemon={daemon} canControl failures={failures} />);
    const root = mounted.container;
    await waitFor(() => daemon.calls.some(call => call.path === '/v1/learning/sessions'), 'the sessions read');
    await openMenu(root);
    expect(textOf(root)).toContain('Learning');
    const toggle = must(item(root, 'passive-learning'), 'passive row');
    expect(toggle.getAttribute('role')).toBe('menuitemcheckbox');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(textOf(toggle)).toContain('Off');
    await click(toggle);
    await waitForText(root, 'Re-instructed; it costs one turn.');
    expect(daemon.calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/v1/sessions/session-hadi/learning' });
    expect(daemon.calls.at(-1)?.body).toEqual({ passive: true });
    const note = must(root.querySelector('[data-learning-action-note]'), 'note');
    expect(note.getAttribute('role')).toBe('status');
    await waitFor(() => item(root, 'passive-learning')?.getAttribute('aria-checked') === 'true', 'the row to flip on');
    expect(textOf(must(item(root, 'passive-learning'), 'row'))).toContain('On');
    await click(must(note.querySelector('button[aria-label="Dismiss"]'), 'Dismiss'));
    expect(root.querySelector('[data-learning-action-note]')).toBeNull();

    daemon.once('PATCH /v1/sessions/session-hadi/learning', { status: 403, body: { error: 'fleet.use is closed' } });
    await click(must(item(root, 'passive-learning'), 'row'));
    await waitFor(() => failures.length === 1, 'the failure');
    expect(failures[0]).toContain('fleet.use is closed');
  });

  it('opens the scan dialog scoped to this ferret, and View in Learning goes to the hub', async () => {
    const daemon = fakeLearningDaemon();
    const viewed: string[] = [];
    mounted = await mount(
      <Page daemon={daemon} canControl failures={[]} options={{ onViewLearning: () => viewed.push('hub') }} />,
    );
    const root = mounted.container;
    await openMenu(root);
    await click(must(item(root, 'scan-ferret'), 'scan row'));
    await waitForText(root, 'Nothing runs until you press Start.');
    const estimate = daemon.calls.find(call => call.path === '/v1/learning/scan/estimate');
    expect(estimate?.body).toEqual({ scope: { kind: 'sessions', sessionIds: ['session-hadi'] } });
    // The scan never starts by itself.
    expect(daemon.calls.some(call => call.method === 'POST' && call.path === '/v1/learning/scan')).toBe(false);
    await click(byText(root, 'button', 'Start scan'));
    await waitForText(root, 'You can close this; the scan keeps going');
    daemon.state.scan = { ...must(daemon.state.scan, 'scan'), state: 'finished', added: 1, done: 4 };
    await waitForText(root, 'Added 1 lesson to To review.');
    await click(byText(root, 'button', 'View in Learning'));
    expect(viewed).toEqual(['hub']);
    expect(root.querySelector('[role="dialog"]')).toBeNull();

    await openMenu(root);
    await click(must(item(root, 'scan-ferret'), 'scan row'));
    await waitForText(root, 'Scan for lessons');
    await click(byText(root, 'footer button', 'Cancel'));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a View in Learning with no host to go to just closes', async () => {
    const daemon = fakeLearningDaemon();
    daemon.state.scan = { runId: 'r', state: 'running', total: 2, done: 0, startedAt: AT, added: 0, merged: 0 };
    mounted = await mount(<Page daemon={daemon} canControl failures={[]} options={{ sessions: undefined }} />);
    const root = mounted.container;
    await openMenu(root);
    await click(must(item(root, 'scan-ferret'), 'scan row'));
    await waitForText(root, 'Reading ferret 1 of 2…');
    daemon.state.scan = { ...daemon.state.scan, state: 'finished', done: 2 };
    await waitForText(root, 'No new lessons.');
    await click(byText(root, 'button', 'View in Learning'));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('offers neither entry to a connection that may not change the ferret', async () => {
    mounted = await mount(<Page daemon={fakeLearningDaemon()} canControl={false} failures={[]} />);
    const trigger = mounted.container.querySelector('[data-session-actions-trigger]');
    if (trigger !== null) await click(trigger);
    expect(item(mounted.container, 'passive-learning')).toBeNull();
    expect(item(mounted.container, 'scan-ferret')).toBeNull();
  });
});

/** What Info › Runtime reads: the same flag the Actions toggle flips, per ferret. */
function PassiveForProbe({ daemon, ids }: { readonly daemon: FakeLearningDaemon; readonly ids: readonly string[] }) {
  const { passiveFor } = useLearningSessionActions({ connection: learningDaemon, fetcher: daemon.fetch });
  return <p data-probe="">{ids.map(id => `${id}=${String(passiveFor(id))}`).join(' ')}</p>;
}

describe('passiveFor — the flag Info › Runtime reads', () => {
  it('is true, false, and off for a ferret the list omits, once the daemon has answered', async () => {
    const daemon = fakeLearningDaemon();
    daemon.state.sessions = [
      { sessionId: 'session-on', passive: true, since: AT, setBy: 'default' },
      { sessionId: 'session-off', passive: false, since: AT, setBy: 'default' },
    ];
    mounted = await mount(<PassiveForProbe daemon={daemon} ids={['session-on', 'session-off', 'session-new']} />);
    const probe = must(mounted.container.querySelector('[data-probe]'), 'probe');
    await waitFor(() => probe.textContent?.includes('session-on=true') === true, 'the learning read');
    expect(probe.textContent).toBe('session-on=true session-off=false session-new=false');
  });

  it('stays null, never off, for a daemon that cannot answer', async () => {
    const daemon = fakeLearningDaemon();
    daemon.once('GET /v1/learning/sessions', { status: 404, body: { error: 'no such route' } });
    mounted = await mount(<PassiveForProbe daemon={daemon} ids={['session-on']} />);
    await waitFor(() => daemon.calls.some(call => call.path === '/v1/learning/sessions'), 'the read');
    expect(must(mounted.container.querySelector('[data-probe]'), 'probe').textContent).toBe('session-on=null');
  });
});
