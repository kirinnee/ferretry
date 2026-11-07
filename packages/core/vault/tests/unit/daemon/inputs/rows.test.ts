import { createHash } from 'node:crypto';
import { describe, it } from 'bun:test';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding } from '@ferretry/core-gate/contract/testing';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type FerretId,
  type RevealGrant,
  type TargetKind,
  type TargetRef,
} from '@ferretry/kernel/contract';
import should from 'should';
import { closeAck } from '../../../../contract/index.ts';
import { HeardActs, InputHoldsOverService } from '../../../../daemon/adapters/inputs/holds.ts';
import { LoginObserver } from '../../../../daemon/lib/inputs/login-observer.ts';
import { QuarantineRegistry } from '../../../../daemon/lib/inputs/quarantine.ts';
import { inputTools } from '../../../../daemon/lib/runtime/tools/input-wait.ts';
import { digestLine } from '../../../../daemon/lib/inputs/digest.ts';
import type { InputRequestService } from '../../../../daemon/lib/inputs/service.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { inputRequestRoutes } from '../../../../daemon/lib/runtime/mounts/inputs.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from './support.ts';

/** Rows the input routes and the digest enforce, said through the routes and the module themselves. */

const FERRET = 'ferret-1';
const REQUEST_ID = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);

/** A device whose grants allow everything but the `secrets` axes named in `refused`. */
function governance(refused: readonly ('use' | 'configure')[]): CallerGovernance {
  return {
    governed: true,
    decide: demand =>
      demand.capability === 'secrets' && refused.includes(demand.axis)
        ? { allowed: false, refusal: 'device-not-granted' }
        : { allowed: true, refusal: 'granted' },
  };
}

interface Calls {
  readonly reads: number[];
  readonly delivered: unknown[];
}

function callOf(standing: object, body: unknown, calls: Calls): CallContext {
  return {
    request: {
      method: 'POST',
      path: '/',
      query: new Map(),
      headers: new Map(),
      arrival: { kind: 'remote' },
      text: async () => {
        calls.reads.push(1);
        return JSON.stringify(body);
      },
    },
    params: new Map([
      ['ferretId', FERRET],
      ['requestId', REQUEST_ID],
    ]),
    ...standing,
  } as unknown as CallContext;
}

function serviceOf(calls: Calls): InputRequestService {
  return {
    list: async () => [{ id: REQUEST_ID, saved: { accounts: [{ id: 'EXAMPLE' }] } }],
    resealed: (request: unknown) => request,
    targetOf: () => ({ kind: 'terminal', key: 'dev' }),
    deliver: async (_ferret: string, id: string, body: unknown) => {
      calls.delivered.push(body);
      return { id, deliveryId: crypto.randomUUID(), state: 'delivered', submitted: true };
    },
  } as unknown as InputRequestService;
}

const fresh = (): Calls => ({ reads: [], delivered: [] });
const json = (response: ApiResponse): Record<string, unknown> => JSON.parse(response.body);
const DELIVER = 'POST /v1/ferrets/:ferretId/input-requests/:requestId/deliver';

describe('the input routes', () => {
  it('G89 should list a card without its saved accounts for a caller with no secrets.use, and with them otherwise', async () => {
    const calls = fresh();
    const routes = inputRequestRoutes(serviceOf(calls));
    const list = routes['GET /v1/ferrets/:ferretId/input-requests'];

    const without = json(await list(callOf({ ...deviceStanding('d1'), governance: governance(['use']) }, {}, calls)));
    const withNames = json(await list(callOf({ ...deviceStanding('d1'), governance: governance([]) }, {}, calls)));

    should(without).deepEqual({ requests: [{ id: REQUEST_ID }] });
    should(withNames).deepEqual({ requests: [{ id: REQUEST_ID, saved: { accounts: [{ id: 'EXAMPLE' }] } }] });
  });

  it('I43 should refuse typing a saved account without secrets.use and saving one without secrets.configure', async () => {
    const calls = fresh();
    const routes = inputRequestRoutes(serviceOf(calls));
    const typed = { deliveryId: crypto.randomUUID(), observedDigest: DIGEST, entry: 'EXAMPLE', submit: true };
    const saved = {
      deliveryId: crypto.randomUUID(),
      observedDigest: DIGEST,
      padded: padInputValue('hunter2-UNIQUE'),
      save: { entry: 'EXAMPLE', label: 'example' },
      submit: true,
    };

    const noUse = await routes[DELIVER](
      callOf({ ...deviceStanding('d1'), governance: governance(['use']) }, typed, calls),
    );
    const noConfigure = await routes[DELIVER](
      callOf({ ...deviceStanding('d1'), governance: governance(['configure']) }, saved, calls),
    );
    const allowed = await routes[DELIVER](
      callOf({ ...deviceStanding('d1'), governance: governance([]) }, typed, calls),
    );

    should(noUse.status).equal(403);
    should(json(noUse).code).equal('grant_device_not_granted');
    should(noConfigure.status).equal(403);
    should(noConfigure.body).not.containEql('hunter2-UNIQUE');
    should(allowed.status).equal(200);
    should(calls.delivered).have.length(1);
  });

  it('I44 should refuse a ferret at the route before its body is read', async () => {
    const calls = fresh();
    const routes = inputRequestRoutes(serviceOf(calls));
    const body = { deliveryId: crypto.randomUUID(), observedDigest: DIGEST, padded: padInputValue('x'), submit: true };

    const error = await routes[DELIVER](callOf(ferretStanding(FERRET as FerretId), body, calls)).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    should(error).be.instanceOf(ApiError);
    should((error as ApiError).status).equal(403);
    should(calls.reads).deepEqual([]);
    should(calls.delivered).deepEqual([]);
  });
});

describe('the digests a card carries', () => {
  it('I107 should digest a prompt line under a key held by this process, never as a plain sha-256', () => {
    const line = '[sudo] password for kirin:';

    should(digestLine(line)).equal(digestLine(line));
    should(digestLine(line)).not.equal(createHash('sha256').update(line).digest('hex'));
    should(digestLine(line)).match(/^[0-9a-f]{64}$/u);
  });
});

const DEV: TargetRef = { kind: 'terminal' as TargetKind, key: 'dev' };
const HOST = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' } as const;
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

describe('the input_wait tool', () => {
  it('I17 should tell the ferret where its card stands and nothing the daemon observed, and refuse anyone else', async () => {
    const { service } = inputRequestService();
    const view = await service.raise(SESSION, RAISE);
    const [request] = await service.list(HOST);
    await service.cancel(SESSION, request?.id ?? '', HOST);
    const tools = inputTools(service);

    const answer = await tools.input_wait(callOf(ferretStanding(SESSION as FerretId), {}, fresh()), {
      id: `!${view.id}`,
      timeoutMs: 100,
    });
    const owner = await tools.input_wait(callOf(deviceStanding('d1'), {}, fresh()), { id: view.id });

    should(answer.isError).be.undefined();
    should(answer.text).startWith(`!${view.id} was cancelled`);
    should(answer.data).have.property('state', 'cancelled');
    should(answer.data).not.have.property('observed');
    should(owner.isError).be.true();
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

describe('a write-only op’s answer', () => {
  it('should be a strict Ack and nothing else: no bit about a password field reaches the ferret', () => {
    const minted = {
      has: () => false,
      get: () => {
        throw new Error('no ids');
      },
    } as never;

    should(closeAck({ status: 'done', passwordField: true, typed: 'secret' }, minted)).deepEqual({ status: 'done' });
  });
});
