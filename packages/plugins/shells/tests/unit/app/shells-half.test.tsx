import { interact, mount, must } from '@ferretry/app/testing';
import type { AppHalf, PluginClient } from '@ferretry/kernel/manifest';
import { describe, expect, it } from 'bun:test';
import { type ReactNode, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';

const HASH = `sha256-${'A'.repeat(43)}=`;
const SUMMARY = {
  name: 'web',
  kind: 'packages',
  locked: true,
  floating: false,
  narHash: HASH,
  build: 'not-built',
  usedBy: [],
};

interface Fake extends PluginClient {
  readonly calls: { route: string; init: unknown }[];
}

const fakeClient = (answers: Readonly<Record<string, unknown>>): Fake => {
  const calls: { route: string; init: unknown }[] = [];
  return {
    calls,
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      if (!(route in answers)) throw new Error(`no answer for ${route}`);
      return answers[route];
    },
    subscribe: () => () => {},
  } as unknown as Fake;
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

const open = async (client: Fake) => {
  const half = app.build?.({ manifest, client }) as AppHalf<typeof manifest>;
  const Settings = half.settings.shells as () => ReactNode;
  const view = await mount(
    <Suspense fallback={null}>
      <Settings />
    </Suspense>,
  );
  await settle();
  return view;
};

describe('the Shells half, bound to the shell', () => {
  it('builds only the shells Settings tab, over the one client it is handed', async () => {
    const half = app.build?.({ manifest, client: fakeClient({}) }) as AppHalf<typeof manifest>;
    expect(Object.keys(half.settings)).toEqual(['shells']);
    expect(Object.keys(half.screens ?? {})).toEqual([]);
  });

  it('shows nix and the shells from the two reads', async () => {
    const client = fakeClient({
      'GET /v1/shells': { shells: [SUMMARY] },
      'GET /v1/shells/nix': { present: true, version: '2.24.0', path: '/nix/bin/nix' },
    });
    const view = await open(client);
    expect(view.container.querySelector('[data-testid="shells-nix"]')?.textContent).toContain('2.24.0');
    expect(view.container.querySelector('[data-shell="web"]')?.textContent).toContain('Not built');
    expect(client.calls.map(call => call.route).sort()).toEqual(['GET /v1/shells', 'GET /v1/shells/nix']);
    await view.unmount();
  });

  it('says why nix is missing, in the daemon’s words, and lists no shells', async () => {
    const client = fakeClient({
      'GET /v1/shells': { shells: [] },
      'GET /v1/shells/nix': { present: false, consequence: 'Ferrets use the machine’s tools.', remedy: 'Install nix.' },
    });
    const view = await open(client);
    expect(view.container.querySelector('[data-testid="shells-nix"]')?.textContent).toContain('Install nix.');
    expect(view.container.textContent).toContain('No shells yet.');
    await view.unmount();
  });

  it('builds a shell through its own route by key', async () => {
    const client = fakeClient({
      'GET /v1/shells': { shells: [SUMMARY] },
      'GET /v1/shells/nix': { present: true, version: '2.24.0', path: '/nix/bin/nix' },
      'POST /v1/shells/:name/build': {
        name: 'web',
        narHash: HASH,
        outcome: 'built',
        builtAt: '2026-11-08T00:00:00.000Z',
      },
    });
    const view = await open(client);
    const row = must(view.container.querySelector('[data-shell="web"]'), 'the web row');
    const build = must(
      [...row.querySelectorAll('button')].find(button => button.textContent === 'Build'),
      'the Build button',
    );
    await interact(() => build.click());
    await settle();
    const call = must(
      client.calls.find(entry => entry.route === 'POST /v1/shells/:name/build'),
      'the build call',
    );
    expect(call.init).toEqual({ params: { name: 'web' } });
    await view.unmount();
  });
});
