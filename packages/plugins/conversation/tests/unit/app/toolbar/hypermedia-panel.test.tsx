import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { Authority, ViewPlace } from '@ferretry/app';
import { interact, type Mounted, mount, must, settleUntil, WithViewPlace } from '@ferretry/app/testing';
import { patchFerretHypermedia, readFerretHypermedia } from '../../../../app/toolbar/hypermedia-api.ts';
import { HypermediaPanel } from '../../../../app/toolbar/hypermedia-panel.tsx';
import type { HypermediaState } from '../../../../contract/index.ts';
import { type CallHandler, fakeClient, refusal } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

const READ_ROUTE = 'GET /v1/ferrets/:ferretId/hypermedia';
const PATCH_ROUTE = 'PATCH /v1/ferrets/:ferretId/hypermedia';

/** What the route serves for a ferret nobody touched the switch on: interactive, so the mode default is on. */
const SUMMARY: HypermediaState = { enabled: true };

const answering: CallHandler = call => {
  const enabled = (call.body as { enabled: boolean }).enabled;
  return {
    restartRequired: true,
    note: `Hypermedia is ${enabled ? 'on' : 'off'}. This ferret is running, so it takes effect when the ferret restarts.`,
  };
};

/** A per-daemon view's place (shell contract S1) whose every route reads `authority`; `press` runs `unlock` first. */
const placeOf = (authority: Authority, unlock: () => Promise<boolean> = async () => true): ViewPlace => ({
  daemon: 'd1',
  machine: 'laptop',
  online: true,
  authority: () => authority,
  authorityOf: () => authority,
  press: async act => (authority.kind === 'locked' && !(await unlock()) ? undefined : await act()),
});

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settle = (ready: () => boolean, what: string) => settleUntil(ready, what, interact);
const switchOf = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-hypermedia-switch]');

describe('Hypermedia in the ferret toolbar', () => {
  it('offers nothing to a reader who cannot control this ferret, and asks the daemon nothing', async () => {
    const client = fakeClient({ [READ_ROUTE]: () => SUMMARY, [PATCH_ROUTE]: answering });
    mounted = await mount(
      withClient(
        client,
        <WithViewPlace place={placeOf({ kind: 'refused', refusal: 'not-granted' })}>
          <HypermediaPanel subject="ferret-hadi" />
        </WithViewPlace>,
      ),
    );
    expect(switchOf(mounted.container)).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('is off with the reason while this device does not know what it may do', async () => {
    const client = fakeClient({ [READ_ROUTE]: () => SUMMARY, [PATCH_ROUTE]: answering });
    mounted = await mount(
      withClient(
        client,
        <WithViewPlace place={placeOf({ kind: 'unreadable' })}>
          <HypermediaPanel subject="ferret-hadi" />
        </WithViewPlace>,
      ),
    );
    const root = mounted.container;
    await settle(() => switchOf(root)?.getAttribute('data-hypermedia-switch') === 'on', 'the switch to read on');
    expect(switchOf(root)?.disabled).toBe(true);
    expect(switchOf(root)?.title).toContain('could not read what it may do');
  });

  it('on a locked machine the switch asks for the unlock first, and a dismissed one switches nothing', async () => {
    const client = fakeClient({ [READ_ROUTE]: () => SUMMARY, [PATCH_ROUTE]: answering });
    mounted = await mount(
      withClient(
        client,
        <WithViewPlace place={placeOf({ kind: 'locked' }, async () => false)}>
          <HypermediaPanel subject="ferret-hadi" />
        </WithViewPlace>,
      ),
    );
    const root = mounted.container;
    await settle(() => switchOf(root)?.getAttribute('data-hypermedia-switch') === 'on', 'the switch to read on');
    await interact(() => must(switchOf(root), 'the switch').click());
    await settle(() => root.querySelector('[data-hypermedia-action-note]') !== null, 'the note');
    expect(root.querySelector('[data-hypermedia-action-note]')?.textContent).toContain('wants your passkey first');
    expect(client.callsTo(PATCH_ROUTE)).toEqual([]);
    expect(switchOf(root)?.getAttribute('data-hypermedia-switch')).toBe('on');
  });

  it('reads an untouched interactive ferret as on, switches it off for the next launch, and says so', async () => {
    const client = fakeClient({ [READ_ROUTE]: () => SUMMARY, [PATCH_ROUTE]: answering });
    mounted = await mount(withClient(client, <HypermediaPanel subject="ferret-hadi" />));
    const root = mounted.container;
    await settle(() => switchOf(root)?.getAttribute('data-hypermedia-switch') === 'on', 'the switch to read on');
    const toggle = must(switchOf(root), 'the switch');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toContain('On');
    await interact(() => toggle.click());
    await settle(() => root.querySelector('[data-hypermedia-action-note]') !== null, 'the note');
    expect(client.callsTo(PATCH_ROUTE).map(call => [call.params, call.body])).toEqual([
      [{ ferretId: 'ferret-hadi' }, { enabled: false }],
    ]);
    const note = must(root.querySelector('[data-hypermedia-action-note]'), 'the note');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toContain('takes effect when the ferret restarts');
    // The daemon's answer wins, so the switch does not flip back.
    expect(switchOf(root)?.getAttribute('aria-pressed')).toBe('false');
    await interact(() =>
      must(note.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]'), 'Dismiss').click(),
    );
    expect(root.querySelector('[data-hypermedia-action-note]')).toBeNull();

    client.on(PATCH_ROUTE, () => {
      throw refusal(403, 'forbidden', 'operator access is closed');
    });
    await interact(() => must(switchOf(root), 'the switch').click());
    await settle(() => root.querySelector('[data-hypermedia-action-note]') !== null, 'the refusal');
    expect(root.querySelector('[data-hypermedia-action-note]')?.textContent).toContain('operator access is closed');
    expect(switchOf(root)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('draws nothing when the toolbar names no ferret', async () => {
    const client = fakeClient();
    mounted = await mount(withClient(client, <HypermediaPanel />));
    expect(switchOf(mounted.container)).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('stays disabled while the ferret cannot be read', async () => {
    const client = fakeClient({
      [READ_ROUTE]: () => {
        throw refusal(404, 'not_found', 'no such ferret');
      },
    });
    mounted = await mount(withClient(client, <HypermediaPanel subject="gone" />));
    await settle(() => client.calls.length > 0, 'the read');
    expect(switchOf(mounted.container)?.disabled).toBe(true);
    expect(switchOf(mounted.container)?.getAttribute('data-hypermedia-switch')).toBe('unknown');
  });

  it('reads the switch from the route that serves it, as the contract spells it, and refuses any other shape', async () => {
    const on = fakeClient({ [READ_ROUTE]: () => ({ enabled: true }) satisfies HypermediaState });
    expect(await readFerretHypermedia(on, 'f')).toBe(true);
    const off = fakeClient({ [READ_ROUTE]: () => ({ enabled: false }) satisfies HypermediaState });
    expect(await readFerretHypermedia(off, 'f')).toBe(false);
    // Today's ferret view and Ferrets' summary are not what this route serves.
    const view = fakeClient({ [READ_ROUTE]: () => ({ config: { mode: 'auto', hypermedia: true } }) });
    await expect(readFerretHypermedia(view, 'f')).rejects.toThrow();
  });

  it('passes a refusal through with its status and a request id on the write', async () => {
    const client = fakeClient({
      [PATCH_ROUTE]: () => {
        throw refusal(502, 'bad_gateway', 'HTTP 502');
      },
    });
    const refused = await patchFerretHypermedia(client, 'ferret-hadi', true).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DaemonCallError);
    expect(refused).toMatchObject({ status: 502 });
    expect(client.calls[0]?.headers['x-fy-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
