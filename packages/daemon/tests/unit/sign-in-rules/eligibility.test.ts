import { describe, it } from 'bun:test';
import {
  foldObservation,
  type InputTargetFacts,
  type LoginObserved,
  type LoginObserverBy,
  type SignInSummary,
} from '@ferretry/protocol';
import should from 'should';
import { type LoginDelivery, LoginObserver } from '../../../src/lib/input-requests/login-observer.ts';
import { ineligibleBecause, tappedIdentities } from '../../../src/lib/sign-in-rules/index.ts';
import { signIn, tappedFact } from './support.ts';

/**
 * ONLY THE OWNER'S OWN DEVICE TAPS QUALIFY A SIGN-IN (r3c-plan §6, invariant 13): the observer writes `tapped` for a
 * `device` fill alone, and history counts only that fact. Run end to end: each fill goes through the real observer and
 * its facts are folded into the sign-in as the account store folds them.
 */

const DELIVERED = 1_000_000;
const SIGN_IN = 'si_00000000000000a1';

const page = (navigationId = 'doc-1'): InputTargetFacts => ({
  kind: 'browser',
  pageId: 'p',
  origin: 'https://github.com',
  secure: true,
  navigationId,
  fields: [
    {
      fieldId: 'value',
      frameOrigin: 'https://github.com',
      frameId: 'f',
      backendNodeId: 1,
      field: { tag: 'input', type: 'password', name: 'password' },
      box: { x: 0, y: 0, w: 1, h: 1 },
      visible: true,
    },
  ],
});

/** A sign-in's facts, folded from every fill run through the observer; each fill's page moves on (or not) at once. */
function history() {
  let now = DELIVERED;
  let kept: readonly LoginObserved[] = [];
  let moves = true;
  const observer = new LoginObserver({
    sink: {
      observeSignIn: async (_id, observation) => {
        kept = foldObservation(kept, observation, new Date(now).toISOString());
      },
    },
    probe: {
      shows: async () => false,
      where: async () => ({ navigationId: moves ? 'doc-2' : 'doc-1', host: moves ? 'github.com' : 'github.com' }),
    },
    now: () => now,
    sleep: async ms => {
      now += ms;
    },
  });
  const fill = async (by: LoginObserverBy | undefined, options: { moved?: boolean; steered?: boolean } = {}) => {
    moves = options.moved !== false;
    now += 60_000;
    const delivery: LoginDelivery = {
      sessionId: 's1',
      login: 'GITHUB_WORK',
      signIn: SIGN_IN,
      domains: ['github.com'],
      target: { kind: 'browser', key: 'app' },
      facts: page(),
      fields: [{ id: 'value', sensitivity: 'secret' } as never],
      secrets: ['pw-UNIQUE'],
      submitted: true,
      surfaces: ['app'],
      since: now - 1_000,
      deliveredAt: now,
      ...(by === undefined ? {} : { by }),
    };
    if (options.steered === true) observer.acted('s1', 'browser');
    await observer.delivered(delivery);
  };
  const summary = (): SignInSummary => signIn({ observed: [...kept] });
  return { fill, summary, kept: () => kept };
}

describe('the tapped fact (invariants 13, 14)', () => {
  it('should not qualify a sign-in on plan fills, rule fills and the admin token, however many', async () => {
    // Arrange
    const h = history();

    // Act — five plan fills, five rule fills, five deliveries on the admin token, one owner tap
    for (const by of ['plan', 'rule', 'host'] as const) for (let index = 0; index < 5; index += 1) await h.fill(by);
    await h.fill('device');

    // Assert — the page moved on every time, but only one tap counts
    should(h.kept()[0]?.navigatedAway?.count).equal(16);
    should(h.kept()[0]?.tapped).containDeep({ value: true, count: 1 });
    should(ineligibleBecause(h.summary())).equal('no-history');
  });

  it('should qualify a sign-in after two owner taps that moved on', async () => {
    const h = history();
    await h.fill('device');
    await h.fill('device');
    should(h.kept()[0]?.tapped).containDeep({ value: true, count: 2 });
    should(ineligibleBecause(h.summary())).be.undefined();
    should(tappedIdentities(h.summary())).eql([h.kept()[0]?.identity]);
  });

  it('should count no tap the ferret steered, and start again after a tap that did not move on', async () => {
    // Arrange
    const steered = history();
    const stuck = history();

    // Act
    await steered.fill('device');
    await steered.fill('device', { steered: true });
    await stuck.fill('device');
    await stuck.fill('device', { moved: false });
    await stuck.fill('device');

    // Assert
    should(steered.kept()[0]?.tapped).containDeep({ value: true, count: 1 });
    should(ineligibleBecause(steered.summary())).equal('no-history');
    should(stuck.kept()[0]?.tapped).containDeep({ value: true, count: 1 });
    should(ineligibleBecause(stuck.summary())).equal('no-history');
  });

  it('should write nothing for a fill that does not say who filled it', async () => {
    const h = history();
    await h.fill(undefined);
    await h.fill(undefined);
    should(h.kept()[0]?.tapped).be.undefined();
  });
});

describe('who may have a rule at all', () => {
  it('should read history only at the sign-in’s own domains, masked and moved on', () => {
    should(tappedIdentities(signIn({ observed: [tappedFact('gitlab.com')] }))).eql([]);
    should(tappedIdentities(signIn({ observed: [tappedFact('github.com', 1)] }))).eql([]);
    should(
      tappedIdentities(
        signIn({ observed: [{ ...tappedFact('github.com'), masked: { value: false, observedAt: '', count: 2 } }] }),
      ),
    ).eql([]);
    should(tappedIdentities(signIn())).eql(['0123456789abcdef']);
  });

  it('should refuse a terminal sign-in, a provider one and one that types no password', () => {
    should(ineligibleBecause(signIn({ place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } } as never))).equal(
      'tool-not-covered',
    );
    should(ineligibleBecause(signIn({ method: { kind: 'google', via: 'GOOGLE' } } as never))).equal('via-provider');
    should(ineligibleBecause(signIn({ method: { kind: 'passkey' } } as never))).equal('not-password');
  });
});
