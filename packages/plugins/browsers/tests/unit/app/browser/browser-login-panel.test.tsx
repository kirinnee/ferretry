/**
 * The Browser panel the half builds offers "Open browser login window" and draws its status banner, over the daemon's
 * own client (`GET|POST /v1/browser/login`). Drawn through `app/index.ts`, as the shell mounts it.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import app from '../../../../app/index.ts';
import manifest from '../../../../manifest.ts';
import { BrowserLoginStatusSchema } from '../../../../contract/index.ts';
import { noteClientDaemon } from '@ferretry/app/testing';
import { recordingClient } from '../../../support/app/client.ts';
import { withDocument } from '../../../support/app/dom.ts';

await withDocument();

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const closed = { state: 'closed', profilePrimed: false };
const openOn = (password: string) =>
  BrowserLoginStatusSchema.parse({
    state: 'open',
    profilePrimed: false,
    openedAt: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:10:00.000Z',
    connection: { host: '127.0.0.1', port: 5951, password, sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 host' },
  });

/** A daemon whose login window answers from `login()`; every other route is refused, as on a quiet machine. */
const daemon = (login: (route: string, body: unknown) => unknown, daemonId?: string) => {
  const scripted = recordingClient((route, init) => {
    if (route === 'GET /v1/browser/login' || route === 'POST /v1/browser/login') return login(route, init?.body);
    if (route === 'GET /v1/browser/state') return { state: 'stopped' };
    return new Error(`no route ${route}`);
  });
  if (daemonId !== undefined) noteClientDaemon(scripted.client, daemonId);
  return scripted;
};

const panelOver = (client: PluginClient) =>
  must(app.build?.({ manifest, client })?.panels?.browser, 'the browser panel');

const shown = (client: PluginClient) =>
  mount(
    createElement(
      Suspense,
      { fallback: null },
      createElement(
        panelOver(client) as unknown as FunctionComponent<PanelProps>,
        {
          subject: 'session-a',
        } as PanelProps,
      ),
    ),
  );

const named = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text),
    `button named “${text}”`,
  );

const loginCalls = (calls: readonly { readonly route: string; readonly init?: { readonly body?: unknown } }[]) =>
  calls.filter(call => call.route.endsWith('/v1/browser/login')).map(call => [call.route, call.init?.body]);

describe('the Browser panel’s login window', () => {
  it('offers the button, and a press starts the window through the daemon’s own client', async () => {
    let status: unknown = closed;
    const { calls, client } = daemon((route, body) => {
      if (route === 'POST /v1/browser/login') {
        expect(body).toEqual({ action: 'start' });
        status = { state: 'opening', profilePrimed: false };
      }
      return status;
    });
    const view = await shown(client);
    await settle();
    // Watching starts with a read and draws nothing for a closed window.
    expect(loginCalls(calls)).toEqual([['GET /v1/browser/login', undefined]]);
    expect(view.container.querySelector('[aria-label="Browser login window"]')).toBeNull();

    await interact(() => named(view.container, 'Open browser login window').click());
    await settle();
    // The POST is followed by an authoritative GET, and the banner says what the daemon says.
    expect(loginCalls(calls).slice(1)).toEqual([
      ['POST /v1/browser/login', { action: 'start' }],
      ['GET /v1/browser/login', undefined],
    ]);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Browser login opening');
    await view.unmount();
  });

  it('draws the open window with its expiry and connection details, and closes it on the reader’s word', async () => {
    let status: unknown = openOn('first-password');
    const { calls, client } = daemon((route, body) => {
      if (route === 'POST /v1/browser/login') status = closed;
      expect(route === 'GET /v1/browser/login' || (body as { action: string }).action === 'stop').toBe(true);
      return status;
    });
    const view = await shown(client);
    await settle();
    expect(view.container.querySelector('[aria-label="Browser login window"]')?.textContent).toContain(
      'Browser login window open',
    );
    expect(view.container.textContent).toContain('first-password');

    await interact(() => named(view.container, 'Close').click());
    await interact(() => named(view.container, 'Close — I signed in').click());
    await settle();
    expect(loginCalls(calls)).toContainEqual(['POST /v1/browser/login', { action: 'stop', primed: true }]);
    expect(view.container.querySelector('[aria-label="Browser login window"]')).toBeNull();
    await view.unmount();
  });

  it('says a failed start in words and shows the failure as a banner, never as a closed window', async () => {
    let failing = false;
    const { client } = daemon(route => {
      if (route === 'POST /v1/browser/login') {
        failing = true;
        return new Error('no display on this machine');
      }
      return failing ? new Error('no display on this machine') : closed;
    });
    const view = await shown(client);
    await settle();
    await interact(() => named(view.container, 'Open browser login window').click());
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('no display on this machine');
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(
      'Browser login status unknown · no display on this machine',
    );
    await view.unmount();
  });

  it('does not let one daemon’s window credential reach the panel of another', async () => {
    const a = daemon(() => openOn('password-of-daemon-a'), 'daemon-a');
    const b = daemon(() => closed, 'daemon-b');
    const viewA = await shown(a.client);
    const viewB = await shown(b.client);
    await settle();
    expect(viewA.container.textContent).toContain('password-of-daemon-a');
    expect(viewB.container.textContent).not.toContain('password-of-daemon-a');
    expect(viewB.container.querySelector('[aria-label="Browser login window"]')).toBeNull();
    // Each daemon was asked on its own client, and only there.
    expect(loginCalls(a.calls).length).toBeGreaterThan(0);
    expect(loginCalls(b.calls).every(([route]) => route === 'GET /v1/browser/login')).toBe(true);
    await viewA.unmount();
    await viewB.unmount();
  });
});
