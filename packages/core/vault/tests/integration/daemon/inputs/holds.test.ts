import { describe, it } from 'bun:test';
import type { RevealGrant, TargetKind, TargetRef } from '@ferretry/kernel/contract';
import should from 'should';
import { HeardActs, InputHoldsOverService } from '../../../../daemon/adapters/inputs/holds.ts';
import { LoginObserver } from '../../../../daemon/lib/inputs/login-observer.ts';
import { QuarantineRegistry } from '../../../../daemon/lib/inputs/quarantine.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from '../../../unit/daemon/inputs/support.ts';

const DEV: TargetRef = { kind: 'terminal' as TargetKind, key: 'dev' };
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const revealOf = (target: TargetRef, untilMs: number): RevealGrant =>
  ({ target, until: new Date(untilMs).toISOString() }) as unknown as RevealGrant;
const noCards = {
  openSessions: () => [],
  pendingOn: () => undefined,
  pageHeld: () => undefined,
  pageDocument: async () => undefined,
};

describe('InputHolds, as the act runner asks it', () => {
  it('I82 should enforce the replay lock with no loaded sessions for every terminal and page reader', () => {
    const quarantine = new QuarantineRegistry({ now: () => NOW });
    quarantine.lock();
    const holds = new InputHoldsOverService(noCards, quarantine, () => NOW);
    for (const actor of ['ferret', 'warden', 'owner-tools', 'owner-viewer'] as const) {
      should(holds.decide(DEV, 'read', actor)).deepEqual({ refused: 'quarantined' });
      should(holds.decide({ kind: 'page' as TargetKind, key: 'login' }, 'read', actor)).deepEqual({ refused: 'held' });
    }
    should(holds.decide(DEV, 'type', 'owner-input')).equal('allow');
    quarantine.unlock();
    should(holds.decide(DEV, 'read', 'ferret')).equal('allow');
  });
  it('I72 should refuse every read of a quarantined terminal to the ferret and the owner’s tools, and let the ferret send keys', () => {
    const quarantine = new QuarantineRegistry({ now: () => NOW });
    quarantine.begin(SESSION, ['dev'], 'host');
    const holds = new InputHoldsOverService(noCards, quarantine, () => NOW);

    should(holds.decide(DEV, 'read', 'ferret')).deepEqual({ refused: 'quarantined' });
    should(holds.decide(DEV, 'wait', 'ferret')).deepEqual({ refused: 'quarantined' });
    should(holds.decide(DEV, 'read', 'owner-tools')).deepEqual({ refused: 'quarantined' });
    should(holds.decide(DEV, 'stream', 'owner-viewer')).deepEqual({ refused: 'quarantined' });
    should(holds.decide(DEV, 'keys', 'ferret')).equal('allow');
    should(holds.decide({ ...DEV, key: 'other' }, 'read', 'ferret')).equal('allow');
  });

  it('I77 should show a quarantined terminal only to the owner’s viewer, under an unexpired reveal for that terminal', () => {
    const quarantine = new QuarantineRegistry({ now: () => NOW });
    quarantine.begin(SESSION, ['dev'], 'host');
    const holds = new InputHoldsOverService(noCards, quarantine, () => NOW);

    should(holds.decide(DEV, 'stream', 'owner-viewer', revealOf(DEV, NOW + 60_000))).equal('allow');
    should(holds.decide(DEV, 'read', 'ferret', revealOf(DEV, NOW + 60_000))).deepEqual({ refused: 'quarantined' });
    should(holds.decide(DEV, 'stream', 'owner-viewer', revealOf(DEV, NOW - 1))).deepEqual({ refused: 'quarantined' });
    should(holds.decide(DEV, 'stream', 'owner-viewer', revealOf({ ...DEV, key: 'other' }, NOW + 60_000))).deepEqual({
      refused: 'quarantined',
    });
  });

  it('I32 should let a ferret type into a target whose pending card holds only codes, and refuse it any other card', async () => {
    const secret = inputRequestService();
    await secret.service.raise(SESSION, RAISE);
    // An OTP prompt that shows what is typed, so the code stays a code (a password prompt would make it a secret).
    const code = inputRequestService({
      facts: {
        ...FACTS,
        foreground: { ...FACTS.foreground, comm: 'ssh', argv: 'ssh bastion' },
        program: 'ssh',
        echo: 'on',
        promptLine: 'Verification code:',
      },
    });
    await code.service.raise(SESSION, { ...RAISE, prompt: 'The bastion wants the 2FA code', sensitivity: 'code' });
    const secretHolds = new InputHoldsOverService(secret.service, secret.quarantine, () => NOW);
    const codeHolds = new InputHoldsOverService(code.service, code.quarantine, () => NOW);

    should(secretHolds.decide(DEV, 'keys', 'ferret')).deepEqual({ refused: 'input_pending' });
    should(secretHolds.decide(DEV, 'close', 'ferret')).deepEqual({ refused: 'input_pending' });
    should(secretHolds.decide(DEV, 'read', 'ferret')).equal('allow');
    should(secretHolds.decide(DEV, 'keys', 'owner-input')).equal('allow');
    should(codeHolds.decide(DEV, 'keys', 'ferret')).equal('allow');
    should(codeHolds.decide(DEV, 'close', 'ferret')).deepEqual({ refused: 'input_pending' });
  });
});

const PAGE: TargetRef = { kind: 'page' as TargetKind, key: 'page-1' };

/** A page held after a secret went into its document `loader-1`, and the document the page shows now. */
function heldPage(now: string | undefined, documentsOnly = false) {
  const held = {
    until: NOW + 120_000,
    documents: ['loader-1'],
    ...(documentsOnly ? { documentsOnly: true as const } : {}),
  };
  return new InputHoldsOverService(
    {
      openSessions: () => [SESSION],
      pendingOn: () => undefined,
      pageHeld: (_session, names) => (names.includes('page-1') ? held : undefined),
      pageDocument: async () => now,
    },
    { sessions: () => [], until: () => undefined, replayUntil: () => undefined },
    () => NOW,
  );
}

describe('InputHolds on a held page, with the document prepare read', () => {
  it('I117 should refuse every read while the page shows the value’s document, and mask reads once it moved on', async () => {
    const same = heldPage('loader-1');
    const moved = heldPage('loader-2');
    const untold = heldPage(undefined);

    await same.prepare(PAGE, 'read', 'ferret');
    should(same.decide(PAGE, 'read', 'ferret')).deepEqual({ refused: 'held' });
    await moved.prepare(PAGE, 'read', 'ferret');
    should(moved.decide(PAGE, 'read', 'ferret')).equal('allow-masked');
    await moved.prepare(PAGE, 'script', 'ferret');
    should(moved.decide(PAGE, 'script', 'ferret')).equal('allow-masked');
    await untold.prepare(PAGE, 'read', 'ferret');
    should(untold.decide(PAGE, 'read', 'ferret')).deepEqual({ refused: 'held' });
    // A decide with no prepare before it knows no document: still showing it.
    should(moved.decide(PAGE, 'read', 'ferret')).deepEqual({ refused: 'held' });
  });

  it('I116 should refuse pictures for the whole window, except a hold that follows its document once it moved on', async () => {
    const plain = heldPage('loader-2');
    const follows = heldPage('loader-2', true);
    const followsHere = heldPage('loader-1', true);

    await plain.prepare(PAGE, 'picture', 'ferret');
    should(plain.decide(PAGE, 'picture', 'ferret')).deepEqual({ refused: 'held' });
    await follows.prepare(PAGE, 'picture', 'ferret');
    should(follows.decide(PAGE, 'picture', 'ferret')).equal('allow');
    await followsHere.prepare(PAGE, 'stream', 'owner-viewer');
    should(followsHere.decide(PAGE, 'stream', 'owner-viewer')).deepEqual({ refused: 'held' });
  });
});

describe('InputHolds.observed, the acts the sign-in lock hears', () => {
  const observerAt = (): LoginObserver =>
    new LoginObserver({
      sink: { observeSignIn: async () => undefined },
      probe: { where: async () => undefined, shows: async () => undefined },
      now: () => NOW,
      sleep: async () => undefined,
    });

  it('I93 should void a page’s short lock for a ferret’s act on it after the raise, and for good for a script run before', () => {
    const observer = observerAt();
    const sessions: string[] = [];
    const acts = new HeardActs(observer, () => sessions);
    const holds = new InputHoldsOverService(
      noCards,
      { sessions: () => [], until: () => undefined, replayUntil: () => undefined },
      () => NOW,
      acts,
    );
    const steer = acts.view(observer);

    // A script before the ferret holds anything: no session to file it under, so the page itself is kept.
    holds.observed(PAGE, 'script', 'ferret');
    should(steer.pageSteer?.(SESSION, { id: 'page-1', host: 'accounts.example.test' }, NOW)).equal('scripted');
    should(steer.pageSteer?.(SESSION, { id: 'page-2', host: 'other.example.test' }, NOW)).be.undefined();

    // After the raise the session is known: an act on the card's page counts from then.
    sessions.push(SESSION);
    holds.observed({ ...PAGE, key: 'page-3' }, 'read', 'ferret');
    holds.observed({ ...PAGE, key: 'page-3' }, 'type', 'owner-tools');
    should(steer.pageSteer?.(SESSION, { id: 'page-3', host: 'accounts.example.test' }, NOW)).be.undefined();
    holds.observed({ ...PAGE, key: 'page-3' }, 'type', 'ferret');
    should(steer.pageSteer?.(SESSION, { id: 'page-3', host: 'accounts.example.test' }, NOW)).equal('acted');
  });
});

describe('the observer view, once a script has run on a page', () => {
  it('I100 should read every browser surface as steered for good, and a terminal as the observer itself does', () => {
    const observer = new LoginObserver({
      sink: { observeSignIn: async () => undefined },
      probe: { where: async () => undefined, shows: async () => undefined },
      now: () => NOW,
      sleep: async () => undefined,
    });
    const acts = new HeardActs(observer, () => []);
    const steer = acts.view(observer);
    should(steer.tainted?.(SESSION, 'browser', NOW)).equal(false);
    new InputHoldsOverService(
      noCards,
      { sessions: () => [], until: () => undefined, replayUntil: () => undefined },
      () => NOW,
      acts,
    ).observed({ kind: 'page' as TargetKind, key: 'page-1' }, 'script', 'ferret');
    should(steer.tainted?.(SESSION, 'browser', NOW)).equal(true);
    should(steer.tainted?.(SESSION, 'terminal', NOW)).equal(false);
  });
});
