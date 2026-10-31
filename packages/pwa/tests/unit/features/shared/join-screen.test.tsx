import { beforeAll, describe, expect, it } from 'bun:test';
import type { SharedRedeemResponse } from '@ferretry/protocol';
import { JoinScreen } from '../../../../src/features/shared/join-screen.tsx';
import {
  JOIN_REFUSED_SENTENCE,
  NOT_A_SHARE_LINK,
  PASSKEY_EXPLAIN,
  REFUSED_JOIN_AGAIN_NOTE,
  REFUSED_SENTENCE,
  REFUSED_TITLE,
  WINDOW_CLOSED_SENTENCE,
} from '../../../../src/features/shared/shared-model.ts';
import {
  OLD_KEY_NOTE,
  REDEEM_LOCKED_SENTENCE,
  UNLOCK_THEN_LINK,
  UNLOCKED_THEN_LINK,
} from '../../../../src/features/shared/shared-screens-model.ts';
import type { Ticker } from '../../../../src/features/shared/use-clock.ts';
import { fingerprintHead, type MemberSubscription } from '../../../../src/lib/member-keys.ts';
import { testSubscription } from '../../../support/member-keys.ts';
import {
  deferred,
  failedAttempt,
  FAKE_FRAGMENT,
  fakeMembers,
  type Members,
  okAttempt,
  refusedAttempt,
  SEED,
} from '../../../support/shared-screens.ts';
import { click, settle } from '../../../support/dom-form.ts';
import { interact, mount } from '../../../support/dom.ts';

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

let sub: MemberSubscription;
beforeAll(async () => {
  sub = await testSubscription(SEED.daemonId);
});

/** The clock the screen reads, moved by the test, and the ticker it is driven by. */
function clock(start: string) {
  let at = new Date(start);
  const ticks: (() => void)[] = [];
  const ticker: Ticker = onTick => {
    ticks.push(onTick);
    return () => undefined;
  };
  return {
    now: () => at,
    ticker,
    advanceTo: async (next: string) => {
      at = new Date(next);
      await interact(() => {
        for (const tick of ticks) tick();
      });
    },
  };
}

async function open(handlers: Parameters<typeof fakeMembers>[0], start = '2026-10-31T10:01:19.000Z') {
  const fake = fakeMembers(handlers);
  const time = clock(start);
  const shared: string[] = [];
  let homes = 0;
  const view = await mount(
    <JoinScreen
      members={fake.members}
      fragment={FAKE_FRAGMENT}
      now={time.now}
      ticker={time.ticker}
      onShared={daemonId => shared.push(daemonId)}
      onHome={() => {
        homes += 1;
      }}
    />,
  );
  await settle();
  return { ...fake, time, view, shared, homes: () => homes };
}

const fresh = { begin: async () => ({ kind: 'new' as const, seed: SEED }) } satisfies Partial<Members>;
const joined = (): Partial<Members> => ({ join: async () => ({ kind: 'joined', subscription: sub }) });

describe('a link that is not a share link', () => {
  it('says so in a heading and a sentence, and offers the way out', async () => {
    const { view, homes } = await open({ begin: async () => ({ kind: 'invalid', sentence: NOT_A_SHARE_LINK }) });
    expect(q('h1')?.textContent).toBe('This link does not work');
    expect(text()).toContain(NOT_A_SHARE_LINK);
    await click(q('[data-join-home]'));
    expect(homes()).toBe(1);
    await view.unmount();
  });
});

describe('a publisher this browser has not met', () => {
  it('shows the host and the fingerprint head, and sends nothing before the tap', async () => {
    const { view, calls } = await open({ ...fresh });
    expect(text()).toContain('box.example.test');
    expect(q('[data-fingerprint]')?.textContent).toBe(`${fingerprintHead(SEED.daemonId)}…`);
    expect(fingerprintHead(SEED.daemonId)).toHaveLength(20);
    await click(q('[data-fingerprint]'));
    expect(q('[data-fingerprint]')?.textContent).toBe(SEED.daemonId);
    expect(calls).toEqual(['begin']);
    expect(q('[data-join-old-key]')).toBeNull();
    await view.unmount();
  });

  it('says Joining… while it waits, and a refused link in the sentence the publisher owns', async () => {
    const gate = deferred<{ kind: 'refused'; sentence: string }>();
    const { view, calls } = await open({ ...fresh, join: async () => await gate.promise });
    await click(q('[data-join-button]'));
    expect(q('[data-join-button]')?.textContent).toBe('Joining…');
    expect(q('[data-join-button]')?.hasAttribute('disabled')).toBe(true);
    expect(calls).toEqual(['begin', 'join']);
    gate.resolve({ kind: 'refused', sentence: JOIN_REFUSED_SENTENCE });
    await settle();
    expect(q('h1')?.textContent).toBe('This link was refused');
    expect(text()).toContain(JOIN_REFUSED_SENTENCE);
    expect(q('[data-join-again-try]')).toBeNull();
    await view.unmount();
  });

  it('offers Try again when the publisher cannot be reached, and joins on the second try', async () => {
    let tries = 0;
    const { view, calls } = await open({
      ...fresh,
      join: async () => {
        tries += 1;
        return tries === 1
          ? { kind: 'unreachable', sentence: 'Could not reach the publisher.' }
          : { kind: 'joined', subscription: sub };
      },
    });
    await click(q('[data-join-button]'));
    expect(q('h1')?.textContent).toBe('Could not reach the publisher');
    expect(text()).toContain('Could not reach the publisher.');
    await click(q('[data-join-again-try]'));
    expect(q('h1')?.textContent).toBe('Add a passkey for Alice on Studio');
    expect(calls).toEqual(['begin', 'join', 'join']);
    await view.unmount();
  });

  it('says a browser that cannot do this cannot join', async () => {
    const { view } = await open({
      ...fresh,
      join: async () => ({ kind: 'unsupported', sentence: 'This browser cannot keep keys.' }),
    });
    await click(q('[data-join-button]'));
    expect(q('h1')?.textContent).toBe('This browser cannot join');
    expect(q('[data-join-again-try]')).not.toBeNull();
    await click(q('[data-join-home]'));
    await view.unmount();
  });

  it('stops listening when it is closed before the link has been read', async () => {
    const gate = deferred<{ kind: 'new'; seed: typeof SEED }>();
    const fake = fakeMembers({ begin: async () => await gate.promise });
    const view = await mount(
      <JoinScreen
        members={fake.members}
        fragment={FAKE_FRAGMENT}
        now={() => new Date()}
        onShared={() => undefined}
        onHome={() => undefined}
      />,
    );
    expect(text()).toContain('Working…');
    await view.unmount();
    gate.resolve({ kind: 'new', seed: SEED });
    await settle();
  });
});

describe('adding the passkey', () => {
  it('names who and where, explains it, and counts down live', async () => {
    const { view, time } = await open({ ...fresh, ...joined() });
    await click(q('[data-join-button]'));
    expect(q('h1')?.textContent).toBe('Add a passkey for Alice on Studio');
    expect(text()).toContain(PASSKEY_EXPLAIN);
    expect(q('[data-passkey-countdown]')?.textContent).toBe(
      'Add a passkey in the next 8:41 or this link stops working.',
    );
    expect(q('[data-passkey-countdown]')?.hasAttribute('data-urgent')).toBe(false);
    await time.advanceTo('2026-10-31T10:01:20.000Z');
    expect(q('[data-passkey-countdown]')?.textContent).toContain('8:40');
    await view.unmount();
  });

  it('turns urgent in words under a minute, then says the window closed with a way on', async () => {
    const { view, time } = await open({ ...fresh, ...joined() });
    await click(q('[data-join-button]'));
    await time.advanceTo('2026-10-31T10:09:30.000Z');
    expect(q('[data-passkey-countdown]')?.hasAttribute('data-urgent')).toBe(true);
    expect(text()).toContain('Less than a minute left to add a passkey.');
    await time.advanceTo('2026-10-31T10:10:00.000Z');
    expect(text()).toContain(WINDOW_CLOSED_SENTENCE);
    expect(q('[data-passkey-step]')).toBeNull();
    await click(q('[data-join-again]'));
    expect(q('[data-join-again-note]')?.textContent).toBe(REFUSED_JOIN_AGAIN_NOTE);
    await click(q('[data-join-home]'));
    await view.unmount();
  });

  it('adds the passkey, then unlocks with it and opens Shared with me', async () => {
    const { view, calls, shared } = await open({
      ...fresh,
      ...joined(),
      addPasskey: async () => okAttempt(undefined),
      unlock: async () => okAttempt('unlocked'),
    });
    await click(q('[data-join-button]'));
    await click(q('[data-passkey-step="add"]'));
    expect(q('[data-passkey-added]')).not.toBeNull();
    expect(q('[data-passkey-countdown]')).toBeNull();
    expect(q('[data-passkey-step="unlock"]')?.textContent).toBe('Unlock with passkey');
    expect(shared).toEqual([]);
    await click(q('[data-passkey-step="unlock"]'));
    expect(shared).toEqual([SEED.daemonId]);
    expect(calls).toEqual(['begin', 'join', 'addPasskey', 'unlock']);
    await view.unmount();
  });

  it('says Working… while a passkey is being made', async () => {
    const gate = deferred<ReturnType<typeof okAttempt<undefined>>>();
    const { view } = await open({ ...fresh, ...joined(), addPasskey: async () => await gate.promise });
    await click(q('[data-join-button]'));
    await click(q('[data-passkey-step="add"]'));
    expect(q('[data-passkey-step="add"]')?.textContent).toBe('Working…');
    gate.resolve(okAttempt(undefined));
    await settle();
    await view.unmount();
  });

  it('gives the sentence and Try again for a failure that is not the window', async () => {
    let tries = 0;
    const { view } = await open({
      ...fresh,
      ...joined(),
      addPasskey: async () => {
        tries += 1;
        return tries === 1 ? failedAttempt('ceremony', 'That passkey could not be checked.') : okAttempt(undefined);
      },
    });
    await click(q('[data-join-button]'));
    await click(q('[data-passkey-step="add"]'));
    expect(text()).toContain('That passkey could not be checked.');
    expect(q('[data-passkey-step="add"]')?.textContent).toBe('Try again');
    await click(q('[data-passkey-step="add"]'));
    expect(q('[data-passkey-step="unlock"]')).not.toBeNull();
    await view.unmount();
  });

  it('keeps the unlock step with its failure until it works', async () => {
    const { view, shared } = await open({
      ...fresh,
      ...joined(),
      addPasskey: async () => okAttempt(undefined),
      unlock: async () => failedAttempt('ceremony', 'Use the same device.'),
    });
    await click(q('[data-join-button]'));
    await click(q('[data-passkey-step="add"]'));
    await click(q('[data-passkey-step="unlock"]'));
    expect(text()).toContain('Use the same device.');
    expect(q('[data-passkey-step="unlock"]')?.textContent).toBe('Try again');
    expect(shared).toEqual([]);
    await view.unmount();
  });

  it('reads a window that closed during the ceremony as closed', async () => {
    const { view } = await open({
      ...fresh,
      ...joined(),
      addPasskey: async () => failedAttempt('window-closed', WINDOW_CLOSED_SENTENCE),
    });
    await click(q('[data-join-button]'));
    await click(q('[data-passkey-step="add"]'));
    expect(text()).toContain(WINDOW_CLOSED_SENTENCE);
    expect(q('[data-passkey-step]')).toBeNull();
    expect(q('[data-join-again]')).not.toBeNull();
    await view.unmount();
  });
});

describe('a key the publisher refused', () => {
  it('shows Access refused, offers join-again and forget, and forgets only on the tap', async () => {
    const { view, calls, homes } = await open({
      ...fresh,
      ...joined(),
      addPasskey: async () => refusedAttempt(),
      forget: async () => undefined,
    });
    await click(q('[data-join-button]'));
    await click(q('[data-passkey-step="add"]'));
    expect(q('[data-access-refused] h2')?.textContent).toBe(REFUSED_TITLE);
    expect(text()).toContain(REFUSED_SENTENCE);
    expect(calls).not.toContain('forget');
    await click(q('[data-join-again]'));
    expect(text()).toContain(REFUSED_JOIN_AGAIN_NOTE);
    expect(calls).not.toContain('forget');
    await click(q('[data-refused-forget]'));
    expect(calls).not.toContain('forget');
    await click(q('[data-refused-forget-yes]'));
    await settle();
    expect(calls.at(-1)).toBe('forget');
    expect(homes()).toBe(1);
    await view.unmount();
  });

  it('is refused from an unlock too', async () => {
    const { view } = await open({
      ...fresh,
      ...joined(),
      addPasskey: async () => okAttempt(undefined),
      unlock: async () => refusedAttempt(),
    });
    await click(q('[data-join-button]'));
    await click(q('[data-passkey-step="add"]'));
    await click(q('[data-passkey-step="unlock"]'));
    expect(q('[data-access-refused]')).not.toBeNull();
    await view.unmount();
  });

  it('treats a refused key met again as a fresh join, and says the old key is replaced only after joined', async () => {
    const old = await testSubscription(SEED.daemonId, { status: 'refused' });
    const { view, calls } = await open({
      begin: async () => ({ kind: 'known', seed: SEED, subscription: old }),
      ...joined(),
    });
    expect(q('[data-join-old-key]')?.textContent).toBe(OLD_KEY_NOTE);
    expect(text()).toContain('only replaced after you join');
    expect(calls).toEqual(['begin']);
    await click(q('[data-join-button]'));
    expect(q('h1')?.textContent).toContain('Add a passkey');
    await view.unmount();
  });
});

describe('a publisher this browser already belongs to', () => {
  const known = { begin: async () => ({ kind: 'known' as const, seed: SEED, subscription: sub }) };
  const added = { added: [{ name: 'Team tools' }] } as unknown as SharedRedeemResponse;

  it('waits for the tap before it spends the link, then says what was added', async () => {
    const { view, calls, shared } = await open({
      ...known,
      redeem: async () => okAttempt({ kind: 'added' as const, response: added }),
    });
    expect(q('h1')?.textContent).toBe('You are already in Studio');
    expect(calls).toEqual(['begin']);
    await click(q('[data-known-redeem]'));
    expect(q('[data-known-result="added"]')?.textContent).toBe('Added Team tools.');
    expect(calls).toEqual(['begin', 'redeem']);
    await click(q('[data-join-open-shared]'));
    expect(shared).toEqual([SEED.daemonId]);
    await view.unmount();
  });

  it('says Adding… while the link is spent', async () => {
    const gate = deferred<ReturnType<typeof okAttempt<{ kind: 'added'; response: SharedRedeemResponse }>>>();
    const { view } = await open({ ...known, redeem: async () => await gate.promise });
    await click(q('[data-known-redeem]'));
    expect(q('[data-known-redeem]')?.textContent).toBe('Adding…');
    gate.resolve(okAttempt({ kind: 'added', response: added }));
    await settle();
    await view.unmount();
  });

  it('says the publisher’s refusal of the link, with the way out', async () => {
    const { view, homes } = await open({
      ...known,
      redeem: async () => okAttempt({ kind: 'refused' as const, sentence: JOIN_REFUSED_SENTENCE }),
    });
    await click(q('[data-known-redeem]'));
    expect(text()).toContain(JOIN_REFUSED_SENTENCE);
    expect(q('[data-known-result]')).toBeNull();
    await click(q('[data-join-home]'));
    expect(homes()).toBe(1);
    await view.unmount();
  });

  it('asks to unlock first when the key is locked, unlocks, then spends the link', async () => {
    let redeems = 0;
    const { view } = await open({
      ...known,
      redeem: async () => {
        redeems += 1;
        return redeems === 1
          ? okAttempt({ kind: 'refused' as const, sentence: REDEEM_LOCKED_SENTENCE })
          : okAttempt({ kind: 'added' as const, response: added });
      },
      unlock: async () => okAttempt('unlocked'),
    });
    await click(q('[data-known-redeem]'));
    expect(q('[data-known-unlock-first]')?.textContent).toBe(UNLOCK_THEN_LINK);
    await click(q('[data-known-unlock]'));
    expect(text()).toContain(UNLOCKED_THEN_LINK);
    await click(q('[data-known-redeem]'));
    expect(q('[data-known-result="added"]')).not.toBeNull();
    await view.unmount();
  });

  it('asks to unlock first when the call itself says locked', async () => {
    const { view } = await open({
      ...known,
      redeem: async () => failedAttempt('locked', 'Unlock with your passkey first.'),
    });
    await click(q('[data-known-redeem]'));
    expect(q('[data-known-unlock]')).not.toBeNull();
    expect(q('[data-known-unlock]')?.textContent).toBe('Unlock with passkey');
    await view.unmount();
  });

  it('keeps the unlock button, with the sentence, when the unlock fails', async () => {
    const { view } = await open({
      ...known,
      redeem: async () => failedAttempt('locked', 'Unlock with your passkey first.'),
      unlock: async () => failedAttempt('ceremony', 'Use the same device.'),
    });
    await click(q('[data-known-redeem]'));
    await click(q('[data-known-unlock]'));
    expect(text()).toContain('Use the same device.');
    expect(q('[data-known-unlock]')).not.toBeNull();
    await view.unmount();
  });

  it('shows working while it unlocks', async () => {
    const gate = deferred<ReturnType<typeof okAttempt<string>>>();
    const { view } = await open({
      ...known,
      redeem: async () => failedAttempt('locked', 'Unlock with your passkey first.'),
      unlock: async () => await gate.promise,
    });
    await click(q('[data-known-redeem]'));
    await click(q('[data-known-unlock]'));
    expect(q('[data-known-unlock]')?.textContent).toBe('Working…');
    gate.resolve(okAttempt('unlocked'));
    await settle();
    await view.unmount();
  });

  it('is refused from an unlock', async () => {
    const { view } = await open({
      ...known,
      redeem: async () => failedAttempt('locked', 'Unlock with your passkey first.'),
      unlock: async () => refusedAttempt(),
    });
    await click(q('[data-known-redeem]'));
    await click(q('[data-known-unlock]'));
    expect(q('[data-access-refused]')).not.toBeNull();
    await view.unmount();
  });

  it('says another failure and lets the person try again', async () => {
    const { view } = await open({ ...known, redeem: async () => failedAttempt('unreachable', 'Could not reach it.') });
    await click(q('[data-known-redeem]'));
    expect(text()).toContain('Could not reach it.');
    expect(q('[data-known-redeem]')).not.toBeNull();
    await view.unmount();
  });

  it('sends a refused key to Access refused', async () => {
    const { view } = await open({ ...known, redeem: async () => refusedAttempt() });
    await click(q('[data-known-redeem]'));
    expect(q('[data-access-refused] h2')?.textContent).toBe(REFUSED_TITLE);
    await view.unmount();
  });
});
