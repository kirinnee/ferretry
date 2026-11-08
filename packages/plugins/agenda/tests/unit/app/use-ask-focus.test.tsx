/**
 * The ask a link asks for (`?ask=A3`), read off the address through the app's router as the `focus` request the Agenda
 * draws: a good id, junk, and two navigations giving two `seq`s.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, RouterProvider } from '@ferretry/app/testing';
import { type AgendaFocus } from '../../../app/features/agenda/agenda.tsx';
import { askFocusFromSearch, useAskFocus } from '../../../app/features/agenda/use-ask-focus.ts';
import { useRouter } from '../../../app/shell.ts';

ensureDom();

let mounted: Mounted | null = null;
beforeEach(() => window.history.replaceState({}, '', '/'));
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  window.history.replaceState({}, '', '/');
});

const seen: (AgendaFocus | null)[] = [];
let go: (to: string) => void = () => undefined;

function Probe() {
  const { navigate } = useRouter();
  go = navigate;
  seen.push(useAskFocus());
  return null;
}

const mountAt = async (address: string): Promise<void> => {
  seen.length = 0;
  window.history.replaceState({}, '', address);
  mounted = await mount(
    <RouterProvider>
      <Probe />
    </RouterProvider>,
  );
};

const last = (): AgendaFocus | null => seen[seen.length - 1] ?? null;

describe('askFocusFromSearch', () => {
  it('reads an ask id as an on-entry request', () => {
    expect(askFocusFromSearch('?ask=A3', 7)).toEqual({ target: 'A3', seq: 7, onEntry: true });
    expect(askFocusFromSearch('?x=1&ask=A12', 1)).toEqual({ target: 'A12', seq: 1, onEntry: true });
  });

  it('is null for no ask and for junk', () => {
    for (const search of [
      '',
      '?',
      '?ask=',
      '?ask=3',
      '?ask=a3',
      '?ask=A0',
      '?ask=A3x',
      '?ask=%E0%A4%A',
      '?agenda=A3',
      '?attention=A3',
    ]) {
      expect(askFocusFromSearch(search, 1)).toBeNull();
    }
  });
});

describe('useAskFocus', () => {
  it('asks for the ask the address names', async () => {
    await mountAt('/d/laptop/ferrets/f1/chat?ask=A3');
    expect(last()).toEqual({ target: 'A3', seq: 1, onEntry: true });
  });

  it('asks for nothing on junk or no ask', async () => {
    await mountAt('/d/laptop/ferrets/f1/chat?ask=nope');
    expect(last()).toBeNull();
    await mounted?.unmount();
    await mountAt('/d/laptop/ferrets/f1/chat');
    expect(last()).toBeNull();
  });

  it('keeps its seq across a re-render of the same entry, and takes a new one for every navigation', async () => {
    await mountAt('/d/laptop/agenda?ask=A3');
    const first = last();
    expect(first?.seq).toBe(1);
    // The same ask again — a second tap on the same notification — is a new request.
    await interact(() => go('/d/laptop/agenda?ask=A3'));
    const second = last();
    expect(second?.target).toBe('A3');
    expect(second?.seq).toBeGreaterThan(first?.seq ?? 0);
    // A different ask is a third.
    await interact(() => go('/d/laptop/agenda?ask=A4'));
    const third = last();
    expect(third?.target).toBe('A4');
    expect(third?.seq).toBeGreaterThan(second?.seq ?? 0);
    // Every render of one entry agreed on its seq.
    expect(new Set(seen.filter(focus => focus?.seq === second?.seq).map(focus => focus?.target)).size).toBe(1);
  });

  it('drops the request when the address leaves the ask', async () => {
    await mountAt('/d/laptop/agenda?ask=A3');
    await interact(() => go('/d/laptop/agenda'));
    expect(last()).toBeNull();
  });
});
