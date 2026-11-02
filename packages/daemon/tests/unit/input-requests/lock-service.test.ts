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
import { identityOf, LoginObserver } from '../../../src/lib/input-requests/login-observer.ts';
import type { ScriptedOriginsView } from '../../../src/lib/sign-in-grants/matcher.ts';
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
    should(request.lock).deepEqual({ seconds: 120, reason: 'terminal-shows' });
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
    for (const [probe, reason] of [
      [async () => 'aborted' as const, 'probe-stopped'],
      [async () => 'shown' as const, 'probe-shown'],
      [async () => await Promise.reject(new Error('the page went away')), 'probe-stopped'],
    ] as const) {
      const { request } = await raised(inputRequestService({ steered: () => false, facts: PAGE, probe }), PAGE_RAISE);
      should(request.lock).deepEqual({ seconds: 120, reason });
    }
    const { request } = await raised(inputRequestService({ steered: () => false, facts: PAGE }), PAGE_RAISE);
    should(request.lock).deepEqual({ seconds: 120, reason: 'first-time' });
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
    should(redrawn?.lock).deepEqual({ seconds: 120, reason: 'first-time' });
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
    should(request.lock).deepEqual({ seconds: 120, reason: 'not-proven' });
  });
});

/**
 * THE LOCK IS JUDGED PER PAGE (&B137 C): the owner's two Google tabs, one ferret. Only what the ferret did on the card's
 * own page, or a page script there or on its site, lengthens the card's lock; another tab, another site's tab in the
 * same profile, an incognito tab or a terminal does not.
 */
describe("what the ferret did, as the lock reads it: this card's page only", () => {
  /** The real observer, on the test's clock, that saw the ferret open the card's profile page a minute before. */
  const observer = () => {
    let now = NOW - 60_000;
    const seen = new LoginObserver({
      sink: { observeSignIn: async () => undefined },
      probe: { shows: async () => undefined, where: async () => undefined },
      now: () => now,
      sleep: async () => undefined,
    });
    seen.acted(SESSION, 'browser').placed({ id: 'page-1', hosts: ['accounts.example.test'] });
    now = NOW;
    return seen;
  };
  const probing = (seen: LoginObserver, scriptedOrigins?: () => ScriptedOriginsView) =>
    inputRequestService({
      observer: seen,
      facts: PAGE,
      probe: async () => 'hidden',
      ...(scriptedOrigins === undefined ? {} : { scriptedOrigins }),
    });
  const PROFILE_TAB = { id: 'page-2', hosts: ['docs.other.test'] };
  const INCOGNITO_TAB = { id: 'page-3', incognito: true as const, hosts: ['accounts.example.test'] };

  it('should keep a 10 second lock when the ferret acts on another tab or a terminal while the card waits', async () => {
    // Arrange
    const seen = observer();
    const w = probing(seen);
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock).deepEqual({ seconds: 10, reason: 'probed-field' });

    // Act — another site's tab in the same profile, an incognito tab on this very site, and a terminal.
    seen.acted(SESSION, 'browser').placed(PROFILE_TAB);
    seen.acted(SESSION, 'browser').placed(INCOGNITO_TAB);
    seen.acted(SESSION, 'terminal').placed(undefined);
    const [shown] = await w.service.list(HOST);
    await deliver(w, request);

    // Assert — the card still says 10 s, and the hold runs 10 s.
    should(shown?.lock).deepEqual({ seconds: 10, reason: 'probed-field' });
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 10_000);
  });

  it("should hold the full lock, and say so on the card, once the ferret uses the card's own page", async () => {
    // Arrange
    const seen = observer();
    const w = probing(seen);
    const { request } = await raised(w, PAGE_RAISE);

    // Act — a navigation (or any act) of this page by the ferret, after the card was raised.
    seen.acted(SESSION, 'browser').placed({ id: 'page-1', hosts: ['accounts.example.test'] });
    const [shown] = await w.service.list(HOST);
    await deliver(w, request);

    // Assert
    should(shown?.lock).deepEqual({ seconds: 120, reason: 'steered' });
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
  });

  it('should hold the full lock when the ferret acts on a tab that shares its storage, on its site', async () => {
    // Arrange
    const seen = observer();
    const w = probing(seen);
    const { request } = await raised(w, PAGE_RAISE);

    // Act — a profile tab that was on accounts.example.test around the act.
    seen.acted(SESSION, 'browser').placed({ id: 'page-2', hosts: ['docs.other.test', 'accounts.example.test'] });
    await deliver(w, request);

    // Assert
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
  });

  it('should count an act as on every page until it is placed, and for good when its page is never known', async () => {
    // Arrange
    const seen = observer();
    const w = probing(seen);
    await raised(w, PAGE_RAISE);

    // Act — one act still running, one whose page was never known.
    const running = seen.acted(SESSION, 'browser');
    const [during] = await w.service.list(HOST);
    running.placed(PROFILE_TAB);
    const [after] = await w.service.list(HOST);
    seen.acted(SESSION, 'browser').placed(undefined);
    const [unknown] = await w.service.list(HOST);

    // Assert
    should(during?.lock?.reason).equal('steered');
    should(after?.lock?.reason).equal('probed-field');
    should(unknown?.lock?.reason).equal('steered');
  });

  it('should never probe, and keep the full lock, for a page the ferret scripted, or a script on its site', async () => {
    // Arrange — a script of this session on this page; on another tab while it was at this host; and another
    // ferret's script on this host, machine-wide.
    const onPage = observer();
    onPage.acted(SESSION, 'browser', true).placed({ id: 'page-1', hosts: ['other.example.test'] });
    const onSite = observer();
    onSite.acted(SESSION, 'browser', true).placed({ id: 'page-9', incognito: true, hosts: ['accounts.example.test'] });
    const machine: ScriptedOriginsView = { hosts: new Map([['accounts.example.test', NOW - 60_000]]) };
    let probed = 0;
    const counting = (seen: LoginObserver, scriptedOrigins?: () => ScriptedOriginsView) =>
      inputRequestService({
        observer: seen,
        facts: PAGE,
        probe: async () => {
          probed += 1;
          return 'hidden';
        },
        ...(scriptedOrigins === undefined ? {} : { scriptedOrigins }),
      });

    // Act
    const locks = [
      (await raised(counting(onPage), PAGE_RAISE)).request.lock,
      (await raised(counting(onSite), PAGE_RAISE)).request.lock,
      (
        await raised(
          counting(observer(), () => machine),
          PAGE_RAISE,
        )
      ).request.lock,
      (
        await raised(
          counting(observer(), () => ({ hosts: new Map(), everywhere: NOW })),
          PAGE_RAISE,
        )
      ).request.lock,
      (
        await raised(
          counting(observer(), () => ({ hosts: new Map(), running: true })),
          PAGE_RAISE,
        )
      ).request.lock,
    ];

    // Assert
    should(probed).equal(0);
    for (const lock of locks) should(lock).deepEqual({ seconds: 120, reason: 'scripted' });
  });

  it('should not lengthen the lock for a script on another site in this session', async () => {
    // Arrange
    const seen = observer();
    seen.acted(SESSION, 'browser', true).placed({ id: 'page-2', hosts: ['docs.other.test'] });
    const machine: ScriptedOriginsView = { hosts: new Map([['docs.other.test', NOW]]) };

    // Act
    const { request } = await raised(
      probing(seen, () => machine),
      PAGE_RAISE,
    );

    // Assert
    should(request.lock).deepEqual({ seconds: 10, reason: 'probed-field' });
  });

  /** The field's facts prove it after a submit; Ferretry does not press Enter this time. */
  const unsubmitted = async (arms: boolean) => {
    const held: Listing = {
      accounts: [account('EXAMPLE')],
      signIns: [signInAt('si_00000000000000e1', 'EXAMPLE', 'accounts.example.test', [{ ...proof(), tapped: flag }])],
    };
    const w = inputRequestService({ observer: observer(), facts: PAGE, logins: logins(() => held), arms });
    const { request } = await raised(w, { ...PAGE_RAISE, submit: 'agent' } as InputRaise);
    await w.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest as string,
        fields: [{ field: 'password', padded: padInputValue('hunter2-UNIQUE-pw') }],
        submit: false,
      } as never,
      HOST,
    );
    return { w, request };
  };

  it('should hold a value Ferretry did not submit while the page shows its document, never 10 s (secrev-1333 M1)', async () => {
    // Act — the owner's own tap that moved this page on is on record, and the browser armed its pagehide clear.
    const { w, request } = await unsubmitted(true);

    // Assert — the card says why; the page is held the full window, and only while it shows the value's document.
    should(request.lock).deepEqual({ seconds: 120, reason: 'until-moved-on' });
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
    should(w.service.pageHeld(SESSION, ['app'])).deepEqual({
      until: NOW + 120_000,
      documents: ['loader-1'],
      documentsOnly: true,
    });
  });

  it('should keep pictures out for the whole window when the pagehide clear could not be armed', async () => {
    const { w } = await unsubmitted(false);
    should(w.service.pageHeld(SESSION, ['app'])).deepEqual({ until: NOW + 120_000, documents: ['loader-1'] });
  });

  it('should count an act on the page that begins while the login store is read at Send (secrev-1333 L1)', async () => {
    // Arrange — the act lands inside the write's store read, after the card was raised.
    const seen = observer();
    let during = false;
    const w = inputRequestService({
      observer: seen,
      facts: PAGE,
      probe: async () => 'hidden',
      logins: {
        listing: async () => {
          if (during) seen.acted(SESSION, 'browser').placed({ id: 'page-1', hosts: ['accounts.example.test'] });
          return { accounts: [], signIns: [] };
        },
        fill: async () => '',
        save: async () => undefined,
      },
    });
    const { request } = await raised(w, PAGE_RAISE);
    should(request.lock?.seconds).equal(10);

    // Act
    during = true;
    await deliver(w, request);

    // Assert
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
  });

  it('should take the full hold when an act on the page begins after the hold, before the write (secrev-1333 L1)', async () => {
    // Arrange — the act lands while the attempt is journalled as delivering, with the short hold already on.
    const seen = observer();
    let armed = false;
    const w = inputRequestService({
      observer: seen,
      facts: PAGE,
      probe: async () => 'hidden',
      journalled: event => {
        if (!armed || !JSON.stringify(event).includes('delivering')) return;
        armed = false;
        seen.acted(SESSION, 'browser').placed({ id: 'page-1', hosts: ['accounts.example.test'] });
      },
    });
    const { request } = await raised(w, PAGE_RAISE);

    // Act
    armed = true;
    await deliver(w, request);

    // Assert
    should(w.quarantine.until(SESSION, ['~page:app'])).equal(NOW + 120_000);
  });

  it('should count a tab, a script and a machine-wide taint on a sibling subdomain of the site (secrev-1333 L2)', async () => {
    // Arrange — mail.example.test shares accounts.example.test's cookies.
    const acted = observer();
    acted.acted(SESSION, 'browser').placed({ id: 'page-2', hosts: ['mail.example.test'] });
    const scripted = observer();
    scripted.acted(SESSION, 'browser', true).placed({ id: 'page-2', hosts: ['mail.example.test:8443'] });
    const machine: ScriptedOriginsView = { hosts: new Map([['www.example.test', NOW]]) };
    const w = probing(acted);
    await raised(w, PAGE_RAISE);

    // Act
    const [card] = await w.service.list(HOST);
    const scriptedLock = (await raised(probing(scripted), PAGE_RAISE)).request.lock;
    const machineLock = (
      await raised(
        probing(observer(), () => machine),
        PAGE_RAISE,
      )
    ).request.lock;

    // Assert
    should(card?.lock).deepEqual({ seconds: 120, reason: 'steered' });
    should(scriptedLock).deepEqual({ seconds: 120, reason: 'scripted' });
    should(machineLock).deepEqual({ seconds: 120, reason: 'scripted' });
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
    should(await lockWith(split)).deepEqual({ seconds: 120, reason: 'did-not-move-on' });
  });

  it('should never read the facts of a sign-in matched somewhere else', async () => {
    const elsewhere: Listing = {
      accounts: [account('EXAMPLE')],
      signIns: [signInAt('si_00000000000000e1', 'EXAMPLE', 'accounts.other.test', [proof()])],
    };
    should(await lockWith(elsewhere)).deepEqual({ seconds: 120, reason: 'first-time' });
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
