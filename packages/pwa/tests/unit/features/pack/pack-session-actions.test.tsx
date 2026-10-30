import { afterEach, describe, expect, it } from 'bun:test';
import type { SessionConfig, SessionView } from '@ferretry/protocol';
import { useState } from 'react';
import { type PackActionContext, usePackSessionActions } from '../../../../src/features/pack/pack-session-actions.tsx';
import { ActionsMenu } from '../../../../src/features/session-actions/actions-menu.tsx';
import { sessionActionSections } from '../../../../src/features/session-actions/registry.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { patchSessionPack } from '../../../../src/lib/pack-api.ts';
import type { DaemonFetch } from '../../../../src/lib/runtime-models.ts';
import { type Mounted, mount, must } from '../../../support/dom.ts';
import { click, textOf, waitFor, waitForText } from '../../../support/learning-dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const DAEMON = daemonConnection({ daemonId: 'daemon/a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const LEGACY = sessionView('session-hadi', { config: { teammate: 'hadi' } });
/** What the wire adds to the shell fixture, so an answer parses against the protocol schema. */
const WIRE_CONFIG: Partial<SessionConfig> = {
  incarnation: 'session-hadi-1',
  runtimeGeneration: 1,
  remoteControl: false,
  harnessFlags: [],
  turn: 4,
  intervalSeconds: 30,
  timeoutSeconds: 0,
  nudgeAfterSeconds: 0,
  killAfterSeconds: 0,
  directSendMaxChars: 0,
  resumeMenuChoice: 'full',
  maxSnapshots: 5,
  retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** An in-memory daemon answering the one Pack route, or the refusal a test queued. */
function fakeDaemon() {
  const calls: Call[] = [];
  const refusals: Array<{ readonly status: number; readonly body: unknown }> = [];
  const fetch: DaemonFetch = async (input, init) => {
    const url = new URL(String(input));
    const body: unknown = JSON.parse(String(init?.body ?? 'null'));
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    const refusal = refusals.shift();
    if (refusal !== undefined) return Response.json(refusal.body, { status: refusal.status });
    const enabled = (body as { enabled: boolean }).enabled;
    return Response.json({
      view: sessionView('session-hadi', { config: { ...WIRE_CONFIG, teammate: 'hadi', pack: enabled } }),
      restartRequired: true,
      note: `Pack mode is ${enabled ? 'on' : 'off'}. This ferret is running, so it takes effect when the ferret restarts.`,
    });
  };
  return { calls, refusals, fetch };
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function Page({
  fetcher,
  view,
  canControl,
  failures,
}: {
  readonly fetcher: DaemonFetch;
  readonly view: SessionView;
  readonly canControl: boolean;
  readonly failures: string[];
}) {
  const { contributions, host } = usePackSessionActions({ connection: DAEMON, fetcher });
  const [form, setForm] = useState<string | null>(null);
  const context: PackActionContext = { view, canControl };
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
const row = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-session-action-item="pack"]');

describe('Pack mode in a ferret’s Actions menu', () => {
  it('reads a ferret from before the switch as on, switches it off for the next launch, and says so', async () => {
    const daemon = fakeDaemon();
    const failures: string[] = [];
    mounted = await mount(<Page fetcher={daemon.fetch} view={LEGACY} canControl failures={failures} />);
    const root = mounted.container;
    await openMenu(root);
    const toggle = must(row(root), 'pack row');
    expect(toggle.getAttribute('role')).toBe('menuitemcheckbox');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(textOf(toggle)).toContain('On');
    await click(toggle);
    await waitForText(root, 'takes effect when the ferret restarts');
    expect(daemon.calls).toEqual([
      { method: 'PATCH', path: '/v1/sessions/session-hadi/pack', body: { enabled: false } },
    ]);
    const note = must(root.querySelector('[data-pack-action-note]'), 'note');
    expect(note.getAttribute('role')).toBe('status');
    // The daemon's answer wins until the list re-reads the session, so the row does not flip back.
    if (row(root) === null) await openMenu(root);
    await waitFor(() => row(root)?.getAttribute('aria-checked') === 'false', 'the row to read off');
    await click(must(note.querySelector('button[aria-label="Dismiss"]'), 'Dismiss'));
    expect(root.querySelector('[data-pack-action-note]')).toBeNull();

    daemon.refusals.push({ status: 403, body: { error: 'operator access is closed', code: 'forbidden' } });
    await click(must(row(root), 'row'));
    await waitFor(() => failures.length === 1, 'the failure');
    expect(failures[0]).toContain('operator access is closed');
  });

  it('offers nothing to a reader who cannot control this ferret', async () => {
    mounted = await mount(<Page fetcher={fakeDaemon().fetch} view={LEGACY} canControl={false} failures={[]} />);
    expect(row(mounted.container)).toBeNull();
  });

  it('says HTTP when a refusal carries no words', async () => {
    const bare: DaemonFetch = async () => new Response('not json', { status: 502 });
    const refused = await patchSessionPack(DAEMON, 'session-hadi', true, bare).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 502, message: 'HTTP 502' });
  });
});
