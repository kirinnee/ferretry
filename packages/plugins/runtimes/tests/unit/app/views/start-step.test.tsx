/**
 * THE FIRST RUN'S START PAGE UNDER THE SETUP FLOW. Drawn as a step it is handed `PanelProps.step`: it must decide (`ready`,
 * or the flow's loading cover waits and then offers Skip), and a copy that landed completes the step through the host
 * (`done`), not around it. Drawn without a host (Settings) it still answers onboarding itself.
 *
 * The Copy panel is stood in for by a button that reports a landed copy: its own behaviour is `copy-settings.test.tsx`'s.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { noteClientDaemon, ShellContext } from '@ferretry/app/testing';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import * as realCopy from '../../../../app/features/fleet/setup/copy-settings.tsx';
import type { LiveRuntimesClient } from '../../../../app/lib/client.ts';
import { type Call, machine } from '../features/fleet/account-support.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

// `mock.module` is process-wide and `mock.restore()` does not undo it: the real module is put back after this file, or
// every later file in the same run (the Copy panel's own parity tests) would draw this stand-in.
const COPY_SETTINGS = '../../../../app/features/fleet/setup/copy-settings.tsx';
const realCopySettings: object = { ...realCopy };

mock.module(COPY_SETTINGS, () => ({
  CopySettings: ({ onCopied }: { readonly onCopied?: () => void }) => (
    <button type="button" data-fake-copied="" onClick={onCopied}>
      Copy landed
    </button>
  ),
}));

afterAll(() => {
  mock.module(COPY_SETTINGS, () => realCopySettings);
});

const { createStartStep } = await import('../../../../app/views/setup-transfer.tsx');

const DAEMON = 'fy_daemon_start';
// The same object on every read: a new one each time would make the external store loop.
const SNAPSHOT = { daemons: [{ daemon: DAEMON, machine: 'studio-mac' }] };
const STEP_ROUTE = 'POST /v1/onboarding/steps/:plugin/:stepId';

/** A host that records what the page told it, in order (the kernel's `StepHost`, nothing of the setup flow). */
const fakeHost = (): { readonly host: StepHost; readonly told: string[] } => {
  const told: string[] = [];
  const host: StepHost = {
    phase: 'daemon',
    appliesTo: [],
    segment: {},
    remember: () => undefined,
    ready: () => void told.push('ready'),
    skip: why => void told.push(`skip:${why}`),
    notNeeded: () => void told.push('notNeeded'),
    commit: () => undefined,
    done: () => void told.push('done'),
    busy: label => void told.push(`busy:${label}`),
    next: () => void told.push('next'),
    back: () => void told.push('back'),
  };
  return { host, told };
};

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const open = async (props: PanelProps): Promise<Call[]> => {
  const calls: Call[] = [];
  const client: LiveRuntimesClient = {
    call: (async (route: string, init?: { readonly params?: Record<string, string>; readonly body?: unknown }) => {
      calls.push({ route, params: init?.params, query: undefined, body: init?.body });
      if (route === 'GET /v1/runtimes/machine') return machine();
      return { ok: true };
    }) as LiveRuntimesClient['call'],
  };
  noteClientDaemon(client, DAEMON);
  const shell = { runtime: { daemons: { snapshot: () => SNAPSHOT, subscribe: () => () => undefined } } };
  const Start = createStartStep(client) as unknown as ComponentType<PanelProps>;
  mounted = await mount(
    <ShellContext.Provider value={shell as never}>
      <Start {...props} />
    </ShellContext.Provider>,
  );
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
  return calls;
};

describe('the Start page as an onboarding step', () => {
  it('tells its host it is ready, so it is not left under the loading cover', async () => {
    const { host, told } = fakeHost();
    await open({ step: host });
    expect(told).toEqual(['ready']);
    expect(mounted?.container.querySelector('[data-onboarding-step-body="start"]')).not.toBeNull();
  });

  it('a copy that landed completes the step through the host, and posts no answer of its own', async () => {
    const { host, told } = fakeHost();
    const calls = await open({ step: host });
    await interact(() =>
      must(mounted?.container.querySelector<HTMLElement>('[data-choice="clone"] input'), 'copy card').click(),
    );
    await interact(() => must(mounted?.container.querySelector<HTMLElement>('[data-fake-copied]'), 'copied').click());
    expect(told).toEqual(['ready', 'done']);
    expect(calls.some(call => call.route === STEP_ROUTE)).toBe(false);
  });

  it('drawn without a host (Settings) it answers onboarding itself and calls nothing on a host', async () => {
    const calls = await open({});
    await interact(() =>
      must(mounted?.container.querySelector<HTMLElement>('[data-choice="clone"] input'), 'copy card').click(),
    );
    await interact(() => must(mounted?.container.querySelector<HTMLElement>('[data-fake-copied]'), 'copied').click());
    const posted = calls.filter(call => call.route === STEP_ROUTE);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.params).toEqual({ plugin: 'runtimes', stepId: 'start' });
    expect(posted[0]?.body).toEqual({ state: 'done' });
  });
});
