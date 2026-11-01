import { describe, it } from 'bun:test';
import {
  type AccountList,
  type AccountSummary,
  type InputRaise,
  type InputTargetFacts,
  type LoginObserved,
  padInputValue,
  PutLoginEntryRequestSchema,
  type SignInSummary,
} from '@ferretry/protocol';
import should from 'should';
import { InputLoginAdapter } from '../../../src/lib/input-requests/login-adapter.ts';
import { identityOf } from '../../../src/lib/input-requests/login-observer.ts';
import { LoginDirectory, LoginVault } from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';
import type { InputCaller as ServiceCaller } from '../../../src/lib/input-requests/ports.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from './support.ts';

/** The adaptive lock (!A149) through the REAL input service: the card says it, and the hold runs it. */

const HOST: ServiceCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const NOW = Date.parse('2026-10-30T12:00:00.000Z');

const PAGE: InputTargetFacts = {
  kind: 'browser',
  pageId: 'page-1',
  origin: 'https://accounts.example.test',
  secure: true,
  navigationId: 'loader-1',
  fields: [
    {
      fieldId: 'password',
      frameOrigin: 'https://accounts.example.test',
      frameId: 'main',
      backendNodeId: 9,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
    },
  ],
};

const PAGE_RAISE: InputRaise = {
  target: { kind: 'browser', key: 'app' },
  prompt: 'the password',
  submit: 'owner-default',
  fields: [{ id: 'password', sensitivity: 'secret', element: { kind: 'ref', ref: 'e3' } }],
} as InputRaise;

const flag = { value: true, observedAt: '2026-10-30T09:00:00.000Z', count: 2 };
/** What the daemon saw at PAGE's password field, said all three ways (`value` false: the other way). */
const proof = (value = true): LoginObserved => ({
  at: 'accounts.example.test',
  surface: 'page',
  identity: identityOf(PAGE, 'accounts.example.test') as string,
  since: '2026-10-30T09:00:00.000Z',
  masked: { ...flag, value },
  noEchoAfterSubmit: flag,
  navigatedAway: flag,
});
const account = (id: string): AccountSummary => ({
  id,
  label: id.toLowerCase(),
  fields: { password: true, totp: false },
  factors: [],
  signIns: [],
  createdAt: 'a',
  updatedAt: 'a',
});
/** A sign-in of `owner` on `host` (a site whose login domain it is), keeping `observed`. */
const signInAt = (id: string, owner: string, host: string, observed: readonly LoginObserved[]): SignInSummary => ({
  id,
  account: owner,
  place: { kind: 'site', domains: [host], match: [host] },
  method: { kind: 'password' },
  ...(observed.length === 0 ? {} : { observed }),
  createdAt: 'a',
  updatedAt: 'a',
});
type Listing = Pick<AccountList, 'accounts' | 'signIns'>;
const proven = (): Listing => ({
  accounts: [account('EXAMPLE')],
  signIns: [signInAt('si_00000000000000e1', 'EXAMPLE', 'accounts.example.test', [proof()])],
});
const logins = (listing: () => Listing) => ({
  listing: async () => listing(),
  fill: async () => '',
  save: async () => undefined,
});

async function raised(w: ReturnType<typeof inputRequestService>, raise: InputRaise = RAISE) {
  const view = await w.service.raise(SESSION, raise);
  const request = (await w.service.list(HOST)).find(candidate => candidate.agendaItemId === view.id);
  if (request === undefined) throw new Error('not raised');
  return { view, request };
}

const deliver = async (w: ReturnType<typeof inputRequestService>, request: { id: string; observedDigest?: string }) =>
  await w.service.deliver(
    SESSION,
    request.id,
    {
      deliveryId: crypto.randomUUID(),
      observedDigest: request.observedDigest as string,
      fields: [{ field: 'password', padded: padInputValue('hunter2-UNIQUE-pw') }],
      submit: true,
    } as never,
    HOST,
  );

describe('the lock a card shows, and the hold that runs it', () => {
  it('should hold a sudo terminal with echo off for 10 seconds, and tell the agent so', async () => {
    const w = inputRequestService({ facts: { ...FACTS, canonical: true, trustedProgram: true } });
    const { view, request } = await raised(w);
    should(request.lock).deepEqual({ seconds: 10, reason: 'hidden-terminal' });
    should(view.lockSeconds).equal(10);
    await w.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest as string,
        padded: padInputValue('hunter2-UNIQUE-pw'),
        submit: true,
      },
      HOST,
    );
    should(w.quarantine.until(SESSION, ['dev'])).equal(NOW + 10_000);
  });

  it('should hold a terminal that echoes for the full two minutes', async () => {
    const w = inputRequestService({ facts: { ...FACTS, echo: 'on', canonical: true, trustedProgram: true } });
    const { request } = await raised(w);
    should(request.lock).deepEqual({ seconds: 120, reason: 'not-proven' });
    await w.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest as string,
        padded: padInputValue('hunter2-UNIQUE-pw'),
        submit: true,
      },
      HOST,
    );
    should(w.quarantine.until(SESSION, ['dev'])).equal(NOW + 120_000);
  });

  it('should give a plain value no lock at all', async () => {
    const { request } = await raised(inputRequestService(), { ...RAISE, sensitivity: 'plain' });
    should(request).not.have.property('lock');
  });

  it('should probe a qualifying page and hold it 10 seconds after a clean probe', async () => {
    const asked: (readonly string[])[] = [];
    const w = inputRequestService({
      steered: () => false,
      facts: PAGE,
      probe: async fieldIds => {
        asked.push(fieldIds);
        return 'hidden';
      },
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(asked).deepEqual([['password']]);
    should(request.lock).deepEqual({ seconds: 10, reason: 'probed-field' });
    await deliver(w, request);
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 10_000);
  });

  it('should keep the full lock when the probe stops, shows the value, throws or cannot run', async () => {
    for (const probe of [
      async () => 'aborted' as const,
      async () => 'shown' as const,
      async () => await Promise.reject(new Error('the page went away')),
    ]) {
      const { request } = await raised(inputRequestService({ steered: () => false, facts: PAGE, probe }), PAGE_RAISE);
      should(request.lock).deepEqual({ seconds: 120, reason: 'not-proven' });
    }
    const { request } = await raised(inputRequestService({ steered: () => false, facts: PAGE }), PAGE_RAISE);
    should(request.lock?.seconds).equal(120);
  });

  it('should not probe a page a saved login already proves, and hold it 10 seconds', async () => {
    let probed = false;
    const w = inputRequestService({
      steered: () => false,
      facts: PAGE,
      logins: logins(proven),
      probe: async () => {
        probed = true;
        return 'hidden';
      },
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(probed).be.false();
    should(request.lock).deepEqual({ seconds: 10, reason: 'proven-field' });
  });

  it('should never shorten at the write a lock the card showed long', async () => {
    let listing: Listing = { accounts: [], signIns: [] };
    const w = inputRequestService({ steered: () => false, facts: PAGE, logins: logins(() => listing) });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.seconds).equal(120);
    listing = proven();
    await deliver(w, request);
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
  });

  it('should earn the lock again without the probe when the card is redrawn onto a re-rendered field', async () => {
    let facts: InputTargetFacts = PAGE;
    const w = inputRequestService({ steered: () => false, facts: () => facts, probe: async () => 'hidden' });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.reason).equal('probed-field');
    facts = {
      ...PAGE,
      fields: PAGE.kind === 'browser' ? [{ ...PAGE.fields[0], backendNodeId: 77 } as never] : [],
    } as InputTargetFacts;
    await deliver(w, request).catch(() => undefined);
    const [redrawn] = await w.service.list(HOST);
    should(redrawn?.lock).deepEqual({ seconds: 120, reason: 'not-proven' });
    should(w.writes).deepEqual([]);
  });

  it('should give a redrawn plain card no lock', async () => {
    let facts: InputTargetFacts = PAGE;
    const w = inputRequestService({ steered: () => false, facts: () => facts });
    const plain = {
      ...PAGE_RAISE,
      fields: [{ id: 'password', sensitivity: 'plain', element: { kind: 'ref', ref: 'e3' } }],
    } as InputRaise;
    const { request } = await raised(w, plain);
    facts = {
      ...PAGE,
      fields: PAGE.kind === 'browser' ? [{ ...PAGE.fields[0], backendNodeId: 77 } as never] : [],
    } as InputTargetFacts;
    await deliver(w, request).catch(() => undefined);
    const [redrawn] = await w.service.list(HOST);
    should(redrawn?.observedDigest).not.equal(request.observedDigest);
    should(redrawn).not.have.property('lock');
  });

  it('should not probe, and keep the full lock, where the ferret ran a page script or no observer can tell', async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return 'hidden' as const;
    };
    const scripted = await raised(inputRequestService({ steered: () => true, facts: PAGE, probe }), PAGE_RAISE);
    const blind = await raised(inputRequestService({ facts: PAGE, probe }), PAGE_RAISE);
    should(probed).be.false();
    should(scripted.request.lock?.seconds).equal(120);
    should(blind.request.lock?.seconds).equal(120);
  });

  it('should hold the full lock at the write when the ferret acted on a page after the card was raised', async () => {
    let acted = false;
    const w = inputRequestService({
      steered: since => acted && since !== Number.POSITIVE_INFINITY,
      facts: PAGE,
      probe: async () => 'hidden',
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.seconds).equal(10);
    acted = true;
    await deliver(w, request);
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
  });

  it('should hold the full lock when the saved logins cannot be read', async () => {
    const w = inputRequestService({
      steered: () => false,
      facts: PAGE,
      logins: {
        listing: async () => await Promise.reject(new Error('damaged')),
        fill: async () => '',
        save: async () => undefined,
      },
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.seconds).equal(120);
  });
});

describe('the facts the lock reads: every sign-in matched to the target, together', () => {
  const lockWith = async (listing: Listing) =>
    (
      await raised(
        inputRequestService({ steered: () => false, facts: PAGE, logins: logins(() => listing) }),
        PAGE_RAISE,
      )
    ).request.lock;

  it("should read the union of every matched sign-in's facts, whichever account proved the field", async () => {
    const two: Listing = {
      accounts: [account('EXAMPLE'), account('EXAMPLE_WORK')],
      signIns: [
        signInAt('si_00000000000000e1', 'EXAMPLE', 'accounts.example.test', []),
        signInAt('si_00000000000000e2', 'EXAMPLE_WORK', 'accounts.example.test', [proof()]),
      ],
    };
    should(await lockWith(two)).deepEqual({ seconds: 10, reason: 'proven-field' });
  });

  it('should read them together the other way too: one matched sign-in saying "no" keeps the lock long', async () => {
    const split: Listing = {
      accounts: [account('EXAMPLE'), account('EXAMPLE_WORK')],
      signIns: [
        signInAt('si_00000000000000e1', 'EXAMPLE', 'accounts.example.test', [proof()]),
        signInAt('si_00000000000000e2', 'EXAMPLE_WORK', 'accounts.example.test', [proof(false)]),
      ],
    };
    should(await lockWith(split)).deepEqual({ seconds: 120, reason: 'not-proven' });
  });

  it('should never read the facts of a sign-in matched somewhere else', async () => {
    const elsewhere: Listing = {
      accounts: [account('EXAMPLE')],
      signIns: [signInAt('si_00000000000000e1', 'EXAMPLE', 'accounts.other.test', [proof()])],
    };
    should(await lockWith(elsewhere)).deepEqual({ seconds: 120, reason: 'not-proven' });
  });

  it("should keep a site's proof however many facts the account's other sign-ins hold (the real store)", async () => {
    const index = new MemoryLoginIndex();
    const sealed = new MemorySecretDocuments();
    const cipher = new FakeSecretCipher();
    const directory = new LoginDirectory(index, sealed, cipher, { now: () => '2026-10-30T09:00:00.000Z' });
    await directory.put(
      'EXAMPLE',
      PutLoginEntryRequestSchema.parse({
        label: 'Example',
        password: 'hunter2-UNIQUE-pw',
        match: ['accounts.example.test', 'ssh@build.example.test'],
      }),
    );
    const { signIns } = await directory.accounts.list();
    const site = signIns.find(signIn => signIn.place.kind === 'site')?.id as string;
    const ssh = signIns.find(signIn => signIn.place.kind === 'terminal')?.id as string;
    await directory.accounts.observeSignIn(site, {
      at: 'accounts.example.test',
      surface: 'page',
      identity: identityOf(PAGE, 'accounts.example.test') as string,
      masked: true,
      noEchoAfterSubmit: true,
      navigatedAway: true,
    });
    // The account's ssh sign-in fills its own facts to the limit: sixteen fields it saw there.
    for (let n = 0; n < 16; n += 1)
      await directory.accounts.observeSignIn(ssh, {
        at: 'ssh@build.example.test',
        surface: 'terminal',
        identity: n.toString(16).padStart(16, '0'),
        masked: true,
      });
    const w = inputRequestService({
      steered: () => false,
      facts: PAGE,
      logins: new InputLoginAdapter(directory, new LoginVault(index, sealed, cipher)),
    });
    should((await raised(w, PAGE_RAISE)).request.lock).deepEqual({ seconds: 10, reason: 'proven-field' });
  });
});
