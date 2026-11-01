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

  it('should refuse a terminal sign-in for any program but sudo, su or doas, a provider one and one with no password', () => {
    for (const place of [
      { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'prod.example.com' },
      { kind: 'terminal', tool: 'npm', host: 'kirin-box' },
      { kind: 'terminal', tool: 'passwd', host: 'kirin-box' },
    ])
      should(
        ineligibleBecause(
          signIn({ place, observed: [{ ...tappedFact(`${place.tool}@kirin-box`), surface: 'terminal' }] } as never),
        ),
      ).equal('tool-not-covered');
    // sudo with the owner's tapped history can have one: what was refused before !A197.
    should(
      ineligibleBecause(
        signIn({
          place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
          observed: [{ ...tappedFact('sudo@kirin-box'), surface: 'terminal', navigatedAway: undefined }],
        } as never),
      ),
    ).be.undefined();
    should(ineligibleBecause(signIn({ method: { kind: 'google', via: 'GOOGLE' } } as never))).equal('via-provider');
    should(ineligibleBecause(signIn({ method: { kind: 'passkey' } } as never))).equal('not-password');
  });
});

const sudoPrompt = (
  over: Partial<Extract<InputTargetFacts, { readonly kind: 'terminal' }>> = {},
): InputTargetFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 1,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'a'.repeat(64),
  program: 'sudo',
  canonical: true,
  recognisedConsumer: true,
  trustedProgram: true,
  ...over,
});

/** A sudo sign-in's facts, folded from every terminal fill run through the observer, as the account store folds them. */
function terminalHistory() {
  let now = DELIVERED;
  let kept: readonly LoginObserved[] = [];
  const observer = new LoginObserver({
    sink: {
      observeSignIn: async (_id, observation) => {
        kept = foldObservation(kept, observation, new Date(now).toISOString());
      },
    },
    probe: { shows: async () => false, where: async () => undefined, prompt: async () => 'kirin@kirin-box:~$' },
    now: () => now,
    sleep: async ms => {
      now += ms;
    },
  });
  const fill = async (
    by: LoginObserverBy | undefined,
    options: { facts?: InputTargetFacts; steered?: boolean; submitted?: boolean } = {},
  ) => {
    now += 60_000;
    const delivery: LoginDelivery = {
      sessionId: 's1',
      login: 'SUDO',
      signIn: SIGN_IN,
      domains: [],
      target: { kind: 'terminal', key: 'dev' },
      facts: options.facts ?? sudoPrompt(),
      fields: [{ id: 'value', sensitivity: 'secret' } as never],
      secrets: ['pw-UNIQUE'],
      submitted: options.submitted ?? true,
      matchKey: 'sudo@kirin-box',
      surfaces: ['dev'],
      since: now - 1_000,
      deliveredAt: now,
      ...(by === undefined ? {} : { by }),
    };
    if (options.steered === true) observer.acted('s1', 'terminal');
    await observer.delivered(delivery);
  };
  const summary = (): SignInSummary =>
    signIn({ place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' }, observed: [...kept] } as never);
  return { fill, summary, kept: () => kept };
}

// R3c-T (!A197, r3c-plan §6): a terminal tap counts only into sudo, su or doas the KERNEL proved setuid root, echo off.
describe('the tapped fact at a terminal (invariants 13, 24)', () => {
  it('should qualify a sudo sign-in after two owner taps into a proved setuid sudo, with no "moved on" asked', async () => {
    const h = terminalHistory();
    await h.fill('device');
    await h.fill('device', { submitted: false });
    should(h.kept()[0]?.tapped).containDeep({ value: true, count: 2 });
    should(h.kept()[0]?.navigatedAway).be.undefined();
    should(ineligibleBecause(h.summary())).be.undefined();
    should(tappedIdentities(h.summary())).eql([h.kept()[0]?.identity]);
  });

  it('should not qualify it on plan fills, rule fills and the admin token, however many', async () => {
    const h = terminalHistory();
    for (const by of ['plan', 'rule', 'host'] as const) for (let index = 0; index < 5; index += 1) await h.fill(by);
    await h.fill('device');
    await h.fill(undefined);
    should(h.kept()[0]?.masked?.count).equal(17);
    should(h.kept()[0]?.tapped).containDeep({ value: true, count: 1 });
    should(ineligibleBecause(h.summary())).equal('no-history');
  });

  it('should count no tap into a sudo that is not setuid root, echoes, is no line, or is unproved, and start again', async () => {
    for (const facts of [
      sudoPrompt({ trustedProgram: undefined }),
      sudoPrompt({ echo: 'on' }),
      sudoPrompt({ canonical: false }),
      sudoPrompt({ recognisedConsumer: false }),
      // A shell that renamed itself sudo: the kernel proved nothing of it.
      sudoPrompt({ program: undefined, trustedProgram: undefined, recognisedConsumer: false }),
      // passwd started under a getpass name the kernel proves, but not one a rule may type into.
      sudoPrompt({ program: 'passwd' }),
    ]) {
      const h = terminalHistory();
      await h.fill('device');
      await h.fill('device', { facts });
      await h.fill('device');
      should(h.kept()[0]?.tapped).containDeep({ value: true, count: 1 });
      should(ineligibleBecause(h.summary())).equal('no-history');
    }
  });

  it('should count no tap the ferret steered by acting on a terminal since the card was raised', async () => {
    const h = terminalHistory();
    await h.fill('device');
    await h.fill('device', { steered: true });
    should(h.kept()[0]?.tapped).containDeep({ value: true, count: 1 });
    should(ineligibleBecause(h.summary())).equal('no-history');
  });
});
