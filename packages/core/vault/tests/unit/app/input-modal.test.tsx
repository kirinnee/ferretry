/**
 * The input modal: pending sign-in cards of a machine, one at a time, a code card first and the newest first; a tap that
 * names an ask opens that exact card; a card raised over a minute ago is read again at once; and nothing secret is drawn.
 */
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { InputModalHost } from '../../../app/features/input/input-modal.tsx';
import {
  askFromUrl,
  chooseCard,
  forgetColdAsk,
  INPUT_MODAL_ATTRIBUTE,
  isStale,
  orderPending,
  STALE_CARD_MS,
  takeColdAsk,
  tappedAsks,
} from '../../../app/lib/input-modal.ts';
import type { InputRequest } from '../../../contract/index.ts';
import { ShellContext } from '@ferretry/app/testing';
import { click, typeInto } from '../../support/app/dom-form.ts';
import { settle } from '../../support/app/dom-form.ts';
import { interact, mount } from '../../support/app/dom.ts';
import { FAKE_VALUE, terminalRequest } from '../../support/app/input-fixtures.ts';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const id = (letter: string): string => letter.repeat(32);

const secretCard = (patch: Partial<Record<string, unknown>> = {}): InputRequest =>
  terminalRequest({ id: id('a'), agendaItemId: 'A7', raisedAt: ago(5_000), ...patch });
const codeCard = (patch: Partial<Record<string, unknown>> = {}): InputRequest =>
  terminalRequest({
    sensitivity: 'code',
    fields: [{ id: 'value', label: 'Code', sensitivity: 'code' }],
    prompt: 'Enter the code we sent you:',
    ...patch,
  });

function rig(
  initial: readonly InputRequest[],
  /** A route's own answer (a deliver held open, a card redrawn by an observe); `undefined` leaves it to the rig. */
  answer?: (route: string, redraw: (request: InputRequest) => void) => Promise<unknown> | undefined,
) {
  let open = [...initial];
  const calls: string[] = [];
  let changed: (() => void) | undefined;
  const client = {
    call: async (route: string, init?: { params?: Record<string, string> }) => {
      calls.push(route);
      const own = answer?.(route, request => {
        open = open.map(each => (each.id === request.id ? request : each));
      });
      if (own !== undefined) return await own;
      if (route === 'GET /v1/input-requests') return { requests: open };
      if (route.endsWith('/cancel')) open = open.filter(each => each.id !== init?.params?.requestId);
      return {};
    },
    subscribe: (_event: unknown, listener: () => void) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  } as never;
  return {
    client,
    calls,
    lists: () => calls.filter(call => call === 'GET /v1/input-requests').length,
    raise: (request: InputRequest) => {
      open = [...open, request];
      changed?.();
    },
  };
}

const shownId = (): string | null =>
  document.body.querySelector('[data-input-modal-request]')?.getAttribute('data-input-modal-request') ?? null;

afterEach(() => {
  setSystemTime();
  tappedAsks.take('m');
  window.history.replaceState(null, '', '/');
  forgetColdAsk();
});

describe('the input modal', () => {
  it('shows nothing while no card is waiting, and no signal', async () => {
    const { client } = rig([]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(document.body.querySelector('[data-input-modal]')).toBeNull();
      expect(document.documentElement.hasAttribute(INPUT_MODAL_ATTRIBUTE)).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('shows two pending cards one at a time: the newest code card first, then the rest', async () => {
    setSystemTime(new Date(NOW));
    const secret = secretCard();
    const oldCode = codeCard({ id: id('b'), agendaItemId: 'A8', raisedAt: ago(40_000) });
    const newCode = codeCard({ id: id('c'), agendaItemId: 'A9', raisedAt: ago(20_000) });
    const { client } = rig([secret, oldCode, newCode]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBe(id('c'));
      expect(document.body.querySelectorAll('[data-input-modal-request]')).toHaveLength(1);
      expect(document.body.querySelector('[data-input-modal-more]')?.textContent).toBe('2 more waiting');
      expect(document.documentElement.getAttribute(INPUT_MODAL_ATTRIBUTE)).toBe('open');

      await click(document.body.querySelector('[data-input-cancel]'));
      await settle();
      // The card says what happened before the next one comes.
      expect(shownId()).toBe(id('c'));
      expect(document.body.querySelector('[data-input-settled]')).not.toBeNull();
      await click(document.body.querySelector('[data-input-modal-next]'));
      await settle();
      expect(shownId()).toBe(id('b'));

      await click(document.body.querySelector('[data-input-cancel]'));
      await settle();
      await click(document.body.querySelector('[data-input-modal-next]'));
      await settle();
      expect(shownId()).toBe(id('a'));
      expect(document.body.querySelector('[data-input-modal-more]')).toBeNull();

      await click(document.body.querySelector('[data-input-cancel]'));
      await settle();
      await click(document.body.querySelector('[data-input-modal-next]'));
      await settle();
      expect(document.body.querySelector('[data-input-modal]')).toBeNull();
      expect(document.documentElement.hasAttribute(INPUT_MODAL_ATTRIBUTE)).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('comes up by itself when a card is raised while the app is open', async () => {
    setSystemTime(new Date(NOW));
    const { client, raise } = rig([]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBeNull();
      await interact(() => raise(secretCard()));
      await settle();
      expect(shownId()).toBe(id('a'));
    } finally {
      await mounted.unmount();
    }
  });

  it('opens exactly the card a notification tap names (?ask=)', async () => {
    setSystemTime(new Date(NOW));
    const { client } = rig([secretCard(), codeCard({ id: id('c'), agendaItemId: 'A9', raisedAt: ago(20_000) })]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBe(id('c'));
      await interact(() => tappedAsks.want('m', 'A7'));
      await settle();
      expect(shownId()).toBe(id('a'));
    } finally {
      await mounted.unmount();
    }
  });

  it('opens the tapped card even when the tap came before the app was ready', async () => {
    setSystemTime(new Date(NOW));
    await interact(() => tappedAsks.want('m', 'A7'));
    const { client } = rig([secretCard(), codeCard({ id: id('c'), agendaItemId: 'A9', raisedAt: ago(20_000) })]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBe(id('a'));
    } finally {
      await mounted.unmount();
    }
  });

  it('ignores a tap that names a card this machine does not hold, and another machine’s tap', async () => {
    setSystemTime(new Date(NOW));
    const { client } = rig([secretCard()]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      await interact(() => tappedAsks.want('m', 'A99'));
      await settle();
      expect(shownId()).toBe(id('a'));
      await interact(() => tappedAsks.want('other', 'A7'));
      await settle();
      expect(shownId()).toBe(id('a'));
    } finally {
      tappedAsks.take('other');
      await mounted.unmount();
    }
  });

  it('reads a stale card again the moment it opens, not at the next poll', async () => {
    setSystemTime(new Date(NOW));
    const fresh = rig([secretCard({ raisedAt: ago(5_000) })]);
    const first = await mount(<InputModalHost client={fresh.client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBe(id('a'));
      expect(fresh.lists()).toBe(1);
    } finally {
      await first.unmount();
    }

    const stale = rig([secretCard({ raisedAt: ago(STALE_CARD_MS + 5_000) })]);
    const second = await mount(<InputModalHost client={stale.client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBe(id('a'));
      // No poll tick has passed (the clock is pinned): the second read is the stale card's own.
      expect(stale.lists()).toBe(2);
    } finally {
      await second.unmount();
    }
  });

  it('draws no value: only facts and prompts', async () => {
    setSystemTime(new Date(NOW));
    const { client, calls } = rig([secretCard()]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
      expect(calls.every(call => call.startsWith('GET '))).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the modal’s rules', () => {
  it('puts a code card first and the newest first inside each group, and skips a card past pending', () => {
    const list = [
      secretCard({ id: id('1'), raisedAt: ago(1_000) }),
      codeCard({ id: id('2'), raisedAt: ago(50_000) }),
      codeCard({ id: id('3'), raisedAt: ago(30_000) }),
      secretCard({ id: id('4'), raisedAt: ago(9_000) }),
      secretCard({ id: id('5'), raisedAt: ago(500), state: 'delivered' }),
    ];
    expect(orderPending(list).map(each => each.id)).toEqual([id('3'), id('2'), id('1'), id('4')]);
  });

  it('calls a card stale after a minute', () => {
    expect(isStale(secretCard({ raisedAt: ago(STALE_CARD_MS - 1) }), NOW)).toBe(false);
    expect(isStale(secretCard({ raisedAt: ago(STALE_CARD_MS + 1) }), NOW)).toBe(true);
  });

  it('reads only a well-formed ask from a routed address', () => {
    expect(askFromUrl('//[')).toBeUndefined();
    expect(askFromUrl('/d/m/ferrets/f/chat?ask=A3')).toBe('A3');
    expect(askFromUrl('/d/m/ferrets/f/chat?ask=%3Cscript%3E')).toBeUndefined();
    expect(askFromUrl('/d/m/ferrets/f/chat')).toBeUndefined();
    expect(askFromUrl('/d/m/ferrets/f/chat?ask=A0')).toBeUndefined();
  });

  it('keeps the card on screen while it is listed or settled, but a tap overrides it', () => {
    const one = secretCard({ id: id('1'), agendaItemId: 'A1' });
    const two = codeCard({ id: id('2'), agendaItemId: 'A2' });
    const base = { dismissed: new Set<string>(), pinnedAsk: undefined, settled: false };
    expect(chooseCard({ ...base, requests: [one, two], currentId: id('1') })).toBe(id('1'));
    expect(chooseCard({ ...base, requests: [two], currentId: id('1'), settled: true })).toBe(id('1'));
    expect(chooseCard({ ...base, requests: [two], currentId: id('1') })).toBe(id('2'));
    expect(chooseCard({ ...base, requests: [one, two], currentId: id('2'), pinnedAsk: 'A1' })).toBe(id('1'));
    expect(
      chooseCard({ ...base, requests: [one], currentId: undefined, dismissed: new Set([id('1')]) }),
    ).toBeUndefined();
  });
});

describe('the vault’s shell hooks', () => {
  it('gives the shell the modal as a background view and hears a tap that names an ask', async () => {
    const { default: half } = await import('../../../app/index.ts');
    expect(Object.keys(half.shell.background ?? {})).toEqual(['input-modal']);
    const context = { daemon: 'm', client: {} as never };
    await half.shell.notificationOpened?.(context, { url: '/d/m/ferrets/f/chat?ask=A12' });
    expect(tappedAsks.take('m')).toBe('A12');
    // A tap with no ask (or a bad one) asks for nothing.
    await half.shell.notificationOpened?.(context, { url: '/d/m/ferrets/f/chat' });
    await half.shell.notificationOpened?.(context, { url: '/d/m/ferrets/f/chat?ask=nope' });
    expect(tappedAsks.take('m')).toBeUndefined();
  });
});

describe('putting the modal off', () => {
  it('"Not now" closes it for every card waiting, and a card raised later still comes up', async () => {
    setSystemTime(new Date(NOW));
    const { client, raise } = rig([secretCard(), codeCard({ id: id('c'), agendaItemId: 'A9', raisedAt: ago(20_000) })]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBe(id('c'));
      await click(document.body.querySelector('[aria-label="Not now"]'));
      await settle();
      expect(shownId()).toBeNull();
      expect(document.documentElement.hasAttribute(INPUT_MODAL_ATTRIBUTE)).toBe(false);
      await interact(() => raise(codeCard({ id: id('d'), agendaItemId: 'A10', raisedAt: ago(1_000) })));
      await settle();
      expect(shownId()).toBe(id('d'));
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing from a read that finishes after the modal is gone', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const client = {
      call: async () => {
        await held;
        return { requests: [secretCard()] };
      },
      subscribe: () => () => undefined,
    } as never;
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    await mounted.unmount();
    release?.();
    await settle();
    expect(shownId()).toBeNull();
  });
});

describe('a machine that cannot be read', () => {
  it('shows nothing and does not throw; the next read tries again', async () => {
    const client = {
      call: async () => {
        throw new Error('could not reach this machine');
      },
      subscribe: () => () => undefined,
    } as never;
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});

const dialogs = (): number => document.body.querySelectorAll('[role="dialog"]').length;
const inertCount = (): number => document.body.querySelectorAll('[inert]').length;

describe('one modal at a time, app-wide', () => {
  it('shows one machine’s modal, then the next once it closes, and gives the focus back each time', async () => {
    setSystemTime(new Date(NOW));
    const first = rig([secretCard()]);
    const second = rig([codeCard({ id: id('c'), agendaItemId: 'A9', raisedAt: ago(20_000) })]);
    // The page has something focused (the thing the owner was on) BEFORE the cards arrive.
    const page = await mount(
      <button data-opener="" type="button">
        opener
      </button>,
    );
    const opener = document.body.querySelector<HTMLButtonElement>('[data-opener]');
    opener?.focus();
    const mounted = await mount(
      <>
        <InputModalHost client={first.client} daemon="m1" />
        <InputModalHost client={second.client} daemon="m2" />
      </>,
    );
    try {
      await settle();
      // Both lists resolved together: ONE dialog, and nothing in it is inert (each dialog used to mark the other inert).
      expect(dialogs()).toBe(1);
      expect(document.body.querySelectorAll('[data-input-modal]')).toHaveLength(1);
      const panel = document.body.querySelector('[role="dialog"]');
      expect(panel?.closest('[inert]')).toBeNull();
      const firstShown = shownId();

      await click(document.body.querySelector('[aria-label="Not now"]'));
      await settle();
      // The other machine's card comes up after it.
      expect(dialogs()).toBe(1);
      expect(shownId()).not.toBe(firstShown);
      expect(shownId()).not.toBeNull();
      expect(document.body.querySelector('[role="dialog"]')?.closest('[inert]')).toBeNull();

      await click(document.body.querySelector('[aria-label="Not now"]'));
      await settle();
      expect(dialogs()).toBe(0);
      expect(inertCount()).toBe(0);
      expect(document.documentElement.hasAttribute(INPUT_MODAL_ATTRIBUTE)).toBe(false);
      // The focus is back where it was, never on the page body.
      expect(document.activeElement).toBe(opener);
    } finally {
      await mounted.unmount();
      await page.unmount();
    }
  });

  it('puts the focus back where it was when a card closes with no other waiting', async () => {
    setSystemTime(new Date(NOW));
    const { client } = rig([secretCard()]);
    const page = await mount(
      <button data-opener="" type="button">
        opener
      </button>,
    );
    const opener = document.body.querySelector<HTMLButtonElement>('[data-opener]');
    opener?.focus();
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(dialogs()).toBe(1);
      await click(document.body.querySelector('[aria-label="Not now"]'));
      await settle();
      expect(dialogs()).toBe(0);
      expect(document.activeElement).toBe(opener);
    } finally {
      await mounted.unmount();
      await page.unmount();
    }
  });
});

describe('an app opened cold by a notification tap', () => {
  it('opens the card the address names (?ask=A7), not the higher-priority one, and strips the ask', async () => {
    setSystemTime(new Date(NOW));
    window.history.replaceState(null, '', '/d/m/ferrets/f/chat?ask=A7&keep=1');
    forgetColdAsk();
    const { client } = rig([secretCard(), codeCard({ id: id('c'), agendaItemId: 'A9', raisedAt: ago(20_000) })]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBe(id('a'));
      expect(window.location.search).toBe('?keep=1');
    } finally {
      await mounted.unmount();
    }
  });

  it('hands the ask only to the machine the address names, and only once', async () => {
    setSystemTime(new Date(NOW));
    window.history.replaceState(null, '', '/d/m/ferrets/f/chat?ask=A7');
    forgetColdAsk();
    const other = rig([codeCard({ id: id('c'), agendaItemId: 'A9', raisedAt: ago(20_000) })]);
    const named = rig([secretCard(), codeCard({ id: id('d'), agendaItemId: 'A9', raisedAt: ago(20_000) })]);
    const mounted = await mount(
      <>
        <InputModalHost client={other.client} daemon="other" />
        <InputModalHost client={named.client} daemon="m" />
      </>,
    );
    try {
      await settle();
      // `other` keeps its own order; `m` opened the card the address named. Only one dialog shows at a time, so look at
      // the ask that was taken: it is gone from the address, and a second mount of `m` finds nothing to open.
      expect(window.location.search).toBe('');
      expect(takeColdAsk('m')).toBeUndefined();
    } finally {
      await mounted.unmount();
    }
  });

  it('opens nothing, and does not throw, when the machine in the address is not readable', () => {
    window.history.replaceState(null, '', '/d/%E0%A4%A/ferrets/f/chat?ask=A7');
    forgetColdAsk();
    expect(takeColdAsk('m')).toBeUndefined();
    expect(window.location.search).toBe('?ask=A7');
  });
});

describe('a card that settles late', () => {
  it('does not settle the card that replaced it: the new card keeps its Send and its polling', async () => {
    setSystemTime(new Date(NOW));
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { client, lists } = rig(
      [secretCard(), codeCard({ id: id('c'), agendaItemId: 'A9', raisedAt: ago(20_000) })],
      route =>
        route.endsWith('/deliver')
          ? gate.then(() => ({
              id: id('a'),
              deliveryId: '123e4567-e89b-42d3-a456-426614174000',
              state: 'delivered',
              submitted: true,
            }))
          : undefined,
    );
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      // The code card (A9) is first; tap A7 so the secret card is on screen, and send its value.
      await interact(() => tappedAsks.want('m', 'A7'));
      await settle();
      expect(shownId()).toBe(id('a'));
      await typeInto(document.body.querySelector('[data-input-value]'), FAKE_VALUE);
      await click(document.body.querySelector('[data-input-send]'));
      // While A7's Send is still in the daemon's hands, a tap switches to A9.
      await interact(() => tappedAsks.want('m', 'A9'));
      await settle();
      expect(shownId()).toBe(id('c'));
      const before = lists();

      await interact(() => release());
      await settle();

      // A7's late answer is A7's: A9 still shows its own card, no Close, and is still being read.
      expect(shownId()).toBe(id('c'));
      expect(document.body.querySelector('[data-input-settled]')).toBeNull();
      expect(document.body.querySelector('[data-input-modal-next]')).toBeNull();
      expect(lists()).toBeGreaterThan(before);
    } finally {
      release();
      await mounted.unmount();
    }
  });
});

describe('a stale card is looked at again before the owner types', () => {
  it('has the machine re-observe the target, then reads the redrawn card', async () => {
    setSystemTime(new Date(NOW));
    const stale = secretCard({ raisedAt: ago(STALE_CARD_MS + 5_000) });
    const redrawn = { ...stale, observedDigest: 'e'.repeat(64) } as InputRequest;
    const seen: string[] = [];
    const { client, calls } = rig([stale], (route, redraw) => {
      if (!route.endsWith('/observe')) return undefined;
      seen.push(route);
      redraw(redrawn);
      return Promise.resolve({});
    });
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(seen).toEqual(['POST /v1/ferrets/:ferretId/input-requests/:requestId/observe']);
      // Observed first, then read again: the list that follows has the redrawn facts, so no Send is refused for them.
      const order = calls;
      expect(order.indexOf('POST /v1/ferrets/:ferretId/input-requests/:requestId/observe')).toBe(1);
      expect(order.at(-1)).toBe('GET /v1/input-requests');
      expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the card as it was when the machine cannot look again', async () => {
    setSystemTime(new Date(NOW));
    const { client } = rig([secretCard({ raisedAt: ago(STALE_CARD_MS + 5_000) })], route =>
      route.endsWith('/observe') ? Promise.reject(new Error('the machine could not look')) : undefined,
    );
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(shownId()).toBe(id('a'));
    } finally {
      await mounted.unmount();
    }
  });

  it('does not look again at a card that is fresh', async () => {
    setSystemTime(new Date(NOW));
    const { client, calls } = rig([secretCard({ raisedAt: ago(5_000) })]);
    const mounted = await mount(<InputModalHost client={client} daemon="m" />);
    try {
      await settle();
      expect(calls.some(call => call.endsWith('/observe'))).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('a locked machine', () => {
  const lockedShell = (locked: readonly string[]) =>
    ({ runtime: { lockedDaemons: () => locked, subscribe: () => () => undefined } }) as never;

  it('says so on the card and points at the Unlock on that machine’s page', async () => {
    setSystemTime(new Date(NOW));
    const { client } = rig([secretCard()]);
    const locked = ['m'];
    const mounted = await mount(
      <ShellContext.Provider value={lockedShell(locked)}>
        <InputModalHost client={client} daemon="m" />
      </ShellContext.Provider>,
    );
    try {
      await settle();
      expect(shownId()).toBe(id('a'));
      const note = document.body.querySelector('[data-input-modal-locked]')?.textContent ?? '';
      expect(note).toContain('locked');
      expect(note).toContain('Unlock');
    } finally {
      await mounted.unmount();
    }
  });

  it('says so, with no card to show, when a tap names a card on a machine that cannot be read', async () => {
    setSystemTime(new Date(NOW));
    // A locked machine's read waits for the unlock: it never answers.
    const client = { call: () => new Promise(() => undefined), subscribe: () => () => undefined } as never;
    const locked = ['m'];
    await interact(() => tappedAsks.want('m', 'A7'));
    const mounted = await mount(
      <ShellContext.Provider value={lockedShell(locked)}>
        <InputModalHost client={client} daemon="m" />
      </ShellContext.Provider>,
    );
    try {
      await settle();
      expect(dialogs()).toBe(1);
      expect(document.body.querySelector('[data-input-modal-locked]')?.textContent).toContain('Unlock');
      expect(document.body.querySelector('[data-input-modal-request]')).toBeNull();
      // “Not now” puts it away.
      await click(document.body.querySelector('[aria-label="Not now"]'));
      await settle();
      expect(dialogs()).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it('says nothing about a lock on a machine that is not locked', async () => {
    setSystemTime(new Date(NOW));
    const { client } = rig([secretCard()]);
    const mounted = await mount(
      <ShellContext.Provider value={lockedShell(['other'])}>
        <InputModalHost client={client} daemon="m" />
      </ShellContext.Provider>,
    );
    try {
      await settle();
      expect(document.body.querySelector('[data-input-modal-locked]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
