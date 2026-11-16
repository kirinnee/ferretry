/**
 * Terminals' app half, parity with today's workspace surfaces (docs/design/rebuild-parity.tsv, owner `terminals`).
 *
 * The half the shell builds is mounted over a scripted client and the test reads what it drew: the Console panel (the
 * pane snapshot, S-0270), the phone key bar above it, and the Processes panel. The views' own behaviour is in the
 * ported suites beside this folder.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { ALL_PROCESSES } from '../../support/app/session-processes.ts';

type Mounted = Awaited<ReturnType<typeof mount>>;
const open: Mounted[] = [];
afterEach(async () => {
  for (const view of open.splice(0)) await view.unmount();
});

const calls: string[] = [];

const scripted = (): PluginClient =>
  ({
    call: async (key: string): Promise<unknown> => {
      calls.push(key);
      if (key === 'GET /v1/ferrets/:ferretId/snapshot') return 'PANE-LINE-ONE\nPANE-LINE-TWO';
      if (key === 'GET /v1/ferrets/:ferretId/processes') return ALL_PROCESSES;
      throw new Error(`unscripted ${key}`);
    },
  }) as unknown as PluginClient;

const half = () => must(app.build?.({ manifest, client: scripted() }), 'the built half');

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const shown = async (id: 'console' | 'processes' | 'terminals', subject = 'agent-session'): Promise<Mounted> => {
  const Panel = must(half().panels?.[id], `the ${id} panel`);
  const view = await mount(
    createElement(Suspense, { fallback: null }, createElement(Panel as FunctionComponent<PanelProps>, { subject })),
  );
  open.push(view);
  await settle();
  return view;
};

describe('the Terminals app half mounts the workspace surfaces today drew', () => {
  it('S-0270 the Console panel draws the ferret’s pane from the declared snapshot route', async () => {
    expect(manifest.ui?.panels?.map(panel => panel.id)).toEqual(['terminals', 'console', 'processes']);
    expect(manifest.actions?.routes?.map(route => route.key)).toContain('GET /v1/ferrets/:ferretId/snapshot');
    const view = await shown('console');
    expect(view.container.textContent).toContain('PANE-LINE-ONE');
    expect(view.container.querySelector('[data-console-input]')).not.toBeNull();
    expect(calls).toContain('GET /v1/ferrets/:ferretId/snapshot');
  });

  it('a panel with no ferret draws nothing', () => {
    for (const id of ['terminals', 'console', 'processes'] as const)
      expect(half().panels?.[id]?.({ subject: undefined } as never)).toBeNull();
  });

  it('the phone key bar sits above the Console on a phone, and only there', async () => {
    const wide = await shown('console');
    expect(wide.container.querySelector('[aria-label="Terminal keys"]')).toBeNull();
    await wide.unmount();
    open.pop();
    const before = window.innerWidth;
    window.innerWidth = 390;
    try {
      const phone = await shown('console');
      expect(phone.container.querySelector('[aria-label="Terminal keys"]')).not.toBeNull();
      expect(phone.container.querySelector('[data-terminal-key="esc"]')).not.toBeNull();
    } finally {
      window.innerWidth = before;
    }
  });

  it('the Processes panel lists what runs under the ferret through the client', async () => {
    const view = await shown('processes');
    expect(calls).toContain('GET /v1/ferrets/:ferretId/processes');
    expect(view.container.textContent).toContain('bun test --watch');
  });
});
