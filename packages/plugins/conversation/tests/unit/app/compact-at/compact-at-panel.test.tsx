import { afterEach, describe, expect, it } from 'bun:test';
import type { Authority, ViewPlace } from '@ferretry/app';
import { interact, type Mounted, mount, must, settleUntil, WithViewPlace } from '@ferretry/app/testing';
import { CompactAtLoader, CompactAtPanel } from '../../../../app/compact-at/compact-at-panel.tsx';
import type { CompactAtFormHost } from '../../../../app/compact-at/compact-at-form.tsx';
import { type CallHandler, fakeClient, refusal } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const READ_ROUTE = 'GET /v1/ferrets/:ferretId/compact-at';
const PATCH_ROUTE = 'PATCH /v1/ferrets/:ferretId/compact-at';
const READ = { own: 250_000, effective: 250_000, window: 1_000_000, restartRequired: true, note: 'At next launch.' };
const DEFAULT = { effective: 'auto', restartRequired: false, note: 'Default.' };

const host = (notes: string[], closes: number[]): CompactAtFormHost => ({
  close: () => closes.push(1),
  notify: note => notes.push(note),
});

const settle = (ready: () => boolean, what: string) => settleUntil(ready, what, interact);
const radio = (root: HTMLElement, value: string) =>
  root.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
const toggle = (root: HTMLElement) =>
  must(root.querySelector<HTMLButtonElement>('[data-compact-at-panel] > button'), 'the toggle');

/** A per-daemon view's place (shell contract S1) whose every route reads `authority`; `press` runs `unlock` first. */
const placeOf = (authority: Authority, unlock: () => Promise<boolean> = async () => true): ViewPlace => ({
  daemon: 'd1',
  machine: 'laptop',
  online: true,
  authority: () => authority,
  authorityOf: () => authority,
  press: async act => (authority.kind === 'locked' && !(await unlock()) ? undefined : await act()),
});

const openPanel = async (
  routes: Readonly<Record<string, CallHandler>>,
  subject: string | null = 'f1',
  place?: ViewPlace,
) => {
  const client = fakeClient(routes);
  const panel = <CompactAtPanel {...(subject === null ? {} : { subject })} />;
  mounted = await mount(
    withClient(client, place === undefined ? panel : <WithViewPlace place={place}>{panel}</WithViewPlace>),
  );
  return { client, root: mounted.container };
};

describe('Compact memory at in the ferret toolbar', () => {
  it('is hidden from someone who cannot control the ferret, and asks the daemon nothing', async () => {
    for (const refusal of ['not-granted', 'device-not-granted'] as const) {
      const { root, client } = await openPanel(
        { [READ_ROUTE]: () => READ },
        'f1',
        placeOf({ kind: 'refused', refusal }),
      );
      expect(root.querySelector('[data-compact-at-panel]')).toBeNull();
      expect(client.calls).toEqual([]);
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('is off, with the reason as its title, while this device does not know yet what it may do', async () => {
    const { root } = await openPanel({ [READ_ROUTE]: () => READ }, 'f1', placeOf({ kind: 'unknown' }));
    expect(toggle(root).disabled).toBe(true);
    expect(toggle(root).title).toBe('Checking what this device may do…');
  });

  it('on a locked machine a save asks for the unlock first, and a dismissed one sends nothing', async () => {
    let asked = 0;
    const { client, root } = await openPanel(
      { [READ_ROUTE]: () => DEFAULT, [PATCH_ROUTE]: () => ({ effective: 200_000, restartRequired: true, note: 'x' }) },
      'f1',
      placeOf({ kind: 'locked' }, async () => {
        asked += 1;
        return false;
      }),
    );
    expect(toggle(root).disabled).toBe(false);
    await interact(() => toggle(root).click());
    await settle(() => radio(root, '200000') !== null, 'the form');
    await interact(() => radio(root, '200000')?.click());
    await interact(() =>
      must(root.querySelector('form'), 'the form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await settle(() => asked === 1, 'the unlock');
    expect(client.callsTo(PATCH_ROUTE)).toEqual([]);
  });

  it('says Default when the toolbar read fails', async () => {
    const { root } = await openPanel(
      {
        [READ_ROUTE]: () => {
          throw refusal(503, 'down', 'down');
        },
      },
      'f1',
      placeOf({ kind: 'open' }),
    );
    await settle(() => toggle(root).textContent?.includes('Default') === true, 'the default label');
    expect(toggle(root).disabled).toBe(false);
  });

  it('draws nothing when the toolbar names no ferret', async () => {
    const { root, client } = await openPanel({}, null);
    expect(root.querySelector('[data-compact-at-panel]')).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('says Default for a ferret with no value, and describes one that has a value', async () => {
    const plain = await openPanel({ [READ_ROUTE]: () => DEFAULT });
    await settle(() => plain.client.calls.length > 0, 'the read');
    expect(toggle(plain.root).textContent).toContain('Compact memory at…');
    expect(toggle(plain.root).textContent).toContain('Default');
    await mounted?.unmount();
    const own = await openPanel({ [READ_ROUTE]: () => READ });
    await settle(() => toggle(own.root).textContent?.includes('250k') === true, 'the ferret’s own value');
  });

  it('shows a note while it reads, then the form on what the daemon answered', async () => {
    let release: (answer: unknown) => void = () => undefined;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    const client = fakeClient({ [READ_ROUTE]: () => pending });
    mounted = await mount(
      <CompactAtLoader client={client} ferretId="f1" host={host([], [])} onSaved={() => undefined} own={undefined} />,
    );
    expect(mounted.container.textContent).toContain('Reading the current setting…');
    await interact(() => release(READ));
    await settle(() => radio(mounted?.container as HTMLElement, '250000')?.checked === true, 'the 250k choice');
  });

  it('still opens a working form when the read fails, on the ferret’s own value', async () => {
    const client = fakeClient({
      [READ_ROUTE]: () => {
        throw refusal(500, 'internal', 'nope');
      },
    });
    mounted = await mount(
      <CompactAtLoader client={client} ferretId="f1" host={host([], [])} onSaved={() => undefined} own={400_000} />,
    );
    await settle(() => radio(mounted?.container as HTMLElement, '400000')?.checked === true, 'the 400k choice');
  });

  it('saves through the daemon, says its note in a status line, and shows the saved value on the toggle', async () => {
    const { client, root } = await openPanel({
      [READ_ROUTE]: () => DEFAULT,
      [PATCH_ROUTE]: () => ({ effective: 200_000, restartRequired: true, note: 'At next launch.' }),
    });
    await interact(() => toggle(root).click());
    expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
    must(root.querySelector('fieldset[aria-label="Compact memory at"]'), 'the open form');
    await settle(() => radio(root, '200000') !== null, 'the form');
    await interact(() => radio(root, '200000')?.click());
    await interact(() =>
      must(root.querySelector('form'), 'the form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await settle(() => root.querySelector('[data-compact-at-note]') !== null, 'the note');
    expect(client.calls.map(call => call.route)).toEqual([READ_ROUTE, READ_ROUTE, PATCH_ROUTE]);
    expect(client.callsTo(PATCH_ROUTE)[0]?.body).toEqual({ compactAt: 200_000 });
    const note = must(root.querySelector('[data-compact-at-note]'), 'the note');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toContain('At next launch.');
    expect(root.querySelector('form')).toBeNull();
    expect(toggle(root).textContent).toContain('200k');
    await interact(() =>
      must(note.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]'), 'Dismiss').click(),
    );
    expect(root.querySelector('[data-compact-at-note]')).toBeNull();
  });
});
