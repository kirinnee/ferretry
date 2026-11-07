import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import { hypermediaOn, patchFerretHypermedia, readFerretHypermedia } from '../../../../app/toolbar/hypermedia-api.ts';
import { HypermediaPanel } from '../../../../app/toolbar/hypermedia-panel.tsx';
import { type CallHandler, fakeClient, refusal, withClient } from '../../../support/app/client.tsx';

const READ_ROUTE = 'GET /v1/ferrets/:ferretId';
const PATCH_ROUTE = 'PATCH /v1/ferrets/:ferretId/hypermedia';

/** A ferret summary from before anyone touched the switch: interactive, so the mode default is on. */
const SUMMARY = {
  id: 'ferret-hadi',
  name: 'hadi',
  harness: 'claude-code',
  folder: '/work',
  state: 'working',
  stateAt: '2026-11-07T10:00:00.000Z',
  mode: 'interactive',
};

const answering: CallHandler = call => {
  const enabled = (call.body as { enabled: boolean }).enabled;
  return {
    restartRequired: true,
    note: `Hypermedia is ${enabled ? 'on' : 'off'}. This ferret is running, so it takes effect when the ferret restarts.`,
  };
};

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settle = (ready: () => boolean, what: string) => settleUntil(ready, what, interact);
const switchOf = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-hypermedia-switch]');

describe('Hypermedia in the ferret toolbar', () => {
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

  it('reads the mode default, the ferret’s own value, and the ferret view', async () => {
    expect(hypermediaOn({ mode: 'interactive' })).toBe(true);
    expect(hypermediaOn({ mode: 'auto' })).toBe(false);
    expect(hypermediaOn({ mode: 'interactive', hypermedia: false })).toBe(false);
    const view = fakeClient({ [READ_ROUTE]: () => ({ config: { mode: 'auto', hypermedia: true } }) });
    expect(await readFerretHypermedia(view, 'f')).toBe(true);
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
