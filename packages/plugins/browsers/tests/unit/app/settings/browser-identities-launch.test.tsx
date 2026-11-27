import { afterEach, describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import { BrowserTab } from '../../../../app/features/settings/browser-tab.tsx';
import daemon, { buildBrowsers } from '../../../../daemon/index.ts';
import { recordingClient } from '../../../support/app/client.ts';
import { Tabs } from '../../../support/tabs.ts';

const FERRETS = { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) };
const IDENTITIES = 'GET /v1/browser/identities';

/** Synthetic: one identity with no saved proxy, launched by a ferret whose launch the test holds and then rejects. */
async function world() {
  let reject: (why: Error) => void = () => undefined;
  let entered: () => void = () => undefined;
  const until = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const launching = new Promise<void>(resolve => {
    entered = resolve;
  });
  const half = implementDaemon(daemon.manifest, {
    build: ctx =>
      buildBrowsers(ctx, {
        launcher: {
          launch: async (_viewport, identity) => {
            entered();
            await until;
            const tabs = new Tabs();
            tabs.idSuffix = `-${identity ?? 'agent'}`;
            return tabs.automation;
          },
        },
      }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding('f1' as FerretId) : ownerStanding(),
  );
  const host = await testHost({
    plugins: [half],
    uses: { ferrets: FERRETS, agentControl: { allows: async () => true } },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate,
    secrets: [],
    config: { 'browsers.yaml': { identities: { docs: {} } } },
  });
  return { host, launching, reject: (why: string) => reject(new Error(why)) };
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('Settings › Browser › Identities with the daemon’s real identity route', () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  it('a mounted row leaves Starting when the paused launch is rejected, with no reload', async () => {
    // Arrange: a launch is in progress; the tab is mounted on the daemon's real answers.
    const built = await world();
    const real = built.host;
    host = real;
    const opening = real.tool('browser_open', { name: 'direct', identity: 'docs' }, { as: ferret('f1') });
    const settled = opening.then(
      () => undefined,
      () => undefined,
    );
    await built.launching;
    const recorded = recordingClient(async route => {
      if (route === IDENTITIES) return JSON.parse((await real.request('GET', '/v1/browser/identities')).body as string);
      if (route === 'GET /v1/config/file')
        return { path: 'browsers.yaml', exists: true, text: 'identities:\n  docs: {}\n', etag: 'etag-1', state: 'ok' };
      if (route === 'GET /v1/config/status') return { directory: '/x', files: [], issues: [], pending: [] };
      if (route === 'GET /v1/browser/state') return { state: 'running' };
      if (route === 'GET /v1/grants')
        return { capabilities: [{ capability: 'fleet', configure: true, configureRefusal: 'granted' }] };
      if (route === 'GET /v1/secrets') return { health: 'ready', secrets: [] };
      return new Error(`no route ${route}`);
    });
    const view = await mount(<BrowserTab client={recorded.client} />);
    await settle();
    const row = (): Element | null => view.container.querySelector('[data-browser-identity="docs"]');
    expect(must(row(), 'the docs row').textContent).toContain('Starting…');

    // Act: the launch fails on the daemon.
    built.reject('chrome would not start');
    await settled;
    await settle();
    for (let waited = 0; waited < 3000 && (row()?.textContent ?? '').includes('Starting…'); waited += 100) {
      await interact(() => sleep(100));
      await settle();
    }

    // Assert: the row is stopped, not stuck on Starting, and has no Stop button.
    const said = row()?.textContent ?? '';
    expect(said).not.toContain('Starting…');
    expect(said).toContain('Stopped');
    expect(row()?.querySelector('[data-browser-identity-stop]')).toBeNull();
    await view.unmount();
  });
});
