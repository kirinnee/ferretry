import { afterEach, describe, expect, it } from 'bun:test';
import {
  AgendaModeSwitch,
  useAgendaSessionActions,
} from '../../../../../app/features/agenda/agenda-session-actions.tsx';
import { createAgendaModePanel } from '../../../../../app/views/agenda-mode-panel.tsx';
import type { AgendaRuntime } from '../../../../../app/lib/agenda-runtime.ts';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { patchSessionAgenda } from '../../../../../app/lib/agenda-api.ts';
import type { AgendaCall } from '../../../../../app/lib/agenda-call.ts';
import { type Mounted, mount, must } from '@ferretry/app/testing';
import { click, textOf, waitFor, waitForText } from '../../../../support/app/learning-dom.ts';
import { callFromFetch } from '../../../../support/app/call-from-fetch.ts';

const FERRET = 'session-hadi';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** An in-memory daemon answering Agenda's agenda-mode routes, or the refusal a test queued. */
function fakeDaemon(initially = false) {
  const calls: Call[] = [];
  const refusals: Array<{ readonly status: number; readonly body: unknown }> = [];
  let enabled = initially;
  const client = callFromFetch(async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body: unknown = init.body === undefined ? null : JSON.parse(String(init.body));
    calls.push({ method, path: url.pathname, body });
    if (method === 'GET')
      return Response.json({ enabled, restartRequired: false, note: `Agenda mode is ${enabled ? 'on' : 'off'}.` });
    const refusal = refusals.shift();
    if (refusal !== undefined) return Response.json(refusal.body, { status: refusal.status });
    enabled = (body as { enabled: boolean }).enabled;
    return Response.json({
      ferret: FERRET,
      enabled,
      restartRequired: true,
      note: `Agenda mode is ${enabled ? 'on' : 'off'}. This ferret is running, so it takes effect when the ferret restarts.`,
    });
  });
  return { calls, refusals, client };
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function Page({
  client,
  canControl,
  failures,
}: {
  readonly client: AgendaCall;
  readonly canControl: boolean;
  readonly failures?: string[];
}) {
  const actions = useAgendaSessionActions({ client });
  return (
    <>
      <AgendaModeSwitch
        actions={actions}
        ferret={FERRET}
        canControl={canControl}
        {...(failures === undefined ? {} : { onFailure: (sentence: string) => failures.push(sentence) })}
      />
      {actions.host}
    </>
  );
}

const row = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-session-action-item="agenda"]');
const toggleOf = (root: HTMLElement) => must(row(root)?.querySelector('input[role="switch"]'), 'agenda switch');

describe('Agenda mode in a ferret’s toolbar', () => {
  it('reads a ferret that is off as off, switches it on for the next launch, and says so', async () => {
    const daemon = fakeDaemon();
    const failures: string[] = [];
    mounted = await mount(<Page client={daemon.client} canControl failures={failures} />);
    const root = mounted.container;
    await waitFor(() => toggleOf(root).getAttribute('aria-checked') === 'false' && textOf(root).includes('Off'), 'off');
    expect(daemon.calls).toEqual([{ method: 'GET', path: `/v1/ferrets/${FERRET}/agenda-mode`, body: null }]);
    await click(toggleOf(root));
    await waitForText(root, 'takes effect when the ferret restarts');
    expect(daemon.calls.slice(1)).toEqual([
      { method: 'PATCH', path: `/v1/ferrets/${FERRET}/agenda-mode`, body: { enabled: true } },
    ]);
    const note = must(root.querySelector('[data-agenda-action-note]'), 'note');
    expect(note.getAttribute('role')).toBe('status');
    // The daemon's answer wins, so the switch does not flip back.
    await waitFor(() => toggleOf(root).getAttribute('aria-checked') === 'true', 'the switch to read on');
    await click(must(note.querySelector('button[aria-label="Dismiss"]'), 'Dismiss'));
    expect(root.querySelector('[data-agenda-action-note]')).toBeNull();

    daemon.refusals.push({ status: 403, body: { error: 'operator access is closed', code: 'forbidden' } });
    await click(toggleOf(root));
    await waitFor(() => failures.length === 1, 'the failure');
    expect(failures[0]).toContain('operator access is closed');
  });

  it('says a refusal in its own status line when the toolbar has no failure line', async () => {
    const daemon = fakeDaemon(true);
    daemon.refusals.push({ status: 403, body: { error: 'operator access is closed', code: 'forbidden' } });
    mounted = await mount(<Page client={daemon.client} canControl />);
    const root = mounted.container;
    await waitFor(() => toggleOf(root).getAttribute('aria-checked') === 'true', 'on');
    await click(toggleOf(root));
    await waitForText(root, 'Agenda mode could not be switched: operator access is closed');
  });

  it('offers nothing to a reader who cannot control this ferret, and reads nothing for one', async () => {
    const daemon = fakeDaemon();
    mounted = await mount(<Page client={daemon.client} canControl={false} />);
    expect(row(mounted.container)).toBeNull();
    expect(daemon.calls).toEqual([]);
  });

  it('the toolbar panel itself draws the daemon’s note and a refusal (it has no failure line)', async () => {
    const daemon = fakeDaemon();
    const Panel = createAgendaModePanel({ client: daemon.client } as unknown as AgendaRuntime);
    mounted = await mount(<Panel {...({ subject: FERRET } as unknown as PanelProps)} />);
    const root = mounted.container;
    await waitFor(() => toggleOf(root).getAttribute('aria-checked') === 'false', 'off');
    await click(toggleOf(root));
    await waitForText(root, 'takes effect when the ferret restarts');
    daemon.refusals.push({ status: 403, body: { error: 'operator access is closed', code: 'forbidden' } });
    await click(toggleOf(root));
    await waitForText(root, 'Agenda mode could not be switched: operator access is closed');
  });

  it('says HTTP when a refusal carries no words', async () => {
    const bare = callFromFetch(async () => new Response('not json', { status: 502 }));
    const refused = await patchSessionAgenda(bare, FERRET, true).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 502, message: 'HTTP 502' });
  });
});
