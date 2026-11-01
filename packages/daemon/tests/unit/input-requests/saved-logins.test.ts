import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputRaise,
  type InputTargetFacts,
  PutLoginEntryRequestSchema,
  padInputValue,
} from '@ferretry/protocol';
import should from 'should';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { InputLoginAdapter } from '../../../src/lib/input-requests/login-adapter.ts';
import { type LoginDelivery, LoginObserver } from '../../../src/lib/input-requests/login-observer.ts';
import type { InputCaller, InputChoicePort, InputLoginPort } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { LoginDirectory, LoginEntryError, LoginVault, totpCode } from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments, plantSeed } from '../runtime/mounts/support.ts';

/**
 * P3, SAVED LOGINS through the REAL input service and the REAL saved-login store (fake cipher, memory files):
 * the first time the owner types and saves, the next time the card offers "Use saved" and the daemon types
 * it. Every sink the service writes to is captured, so a leak of the password, the seed or the code shows.
 */

const SESSION = 'mvv6b4qw-49d0158d';
const PASSWORD = 'hunter2-UNIQUE-pw';
const SEED = 'JBSWY3DPEHPK3PXP';
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const AGENT: InputCaller = { kind: 'agent', sessionId: SESSION };

const sudoFacts = (comm = 'sudo', argv = 'sudo -v'): InputTargetFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm, argv },
  echo: 'off',
  cursorRow: 1,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'a'.repeat(64),
  program: comm,
  canonical: true,
  recognisedConsumer: true,
});

/** A one-time code prompt that shows what is typed, so a `code` card stays a code (a password prompt would not). */
const otpFacts = (): InputTargetFacts =>
  ({
    ...sudoFacts('ssh', 'ssh bastion'),
    echo: 'on',
    promptLine: 'Verification code:',
  }) as InputTargetFacts;

const RAISE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo wants your password',
  sensitivity: 'secret',
  submit: 'owner-default',
};

function harness(
  options: {
    facts?: InputTargetFacts;
    logins?: (port: InputLoginPort) => InputLoginPort;
    /** A daemon that keeps no saved logins at all. */
    none?: true;
    /** Where landed deliveries are told, for a saved login's facts. */
    observer?: (directory: LoginDirectory) => Pick<LoginObserver, 'delivered' | 'tainted'>;
    /** The session's project, folder and the owner's defaults, as the daemon reads them. */
    choice?: InputChoicePort;
  } = {},
) {
  const writes: string[] = [];
  const sinks: string[] = [];
  const saves: unknown[] = [];
  const fills: string[] = [];
  let facts = options.facts ?? sudoFacts();
  let card = 1;
  let id = 1;
  const clock = { now: () => NOW };
  const values = new EphemeralValues(clock);
  const index = new MemoryLoginIndex();
  const sealed = new MemorySecretDocuments();
  const cipher = new FakeSecretCipher();
  const directory = new LoginDirectory(index, sealed, cipher, { now: () => new Date(NOW).toISOString() });
  const vault = new LoginVault(index, sealed, cipher);
  const real = new InputLoginAdapter(directory, vault);
  const spied: InputLoginPort = {
    listing: async () => await real.listing(),
    fill: async (entry, role, at) => {
      fills.push(`${entry}:${role}`);
      return await real.fill(entry, role, at);
    },
    save: async (...args) => await real.save(...args),
  };
  const service = new InputRequestService({
    target: {
      observe: async () => ({ ok: true, facts }),
      type: async (_session, _target, values) => {
        writes.push(...values.map(value => value.text));
        return 'typed';
      },
    },
    agenda: {
      raise: async (_session, raised) => {
        sinks.push(JSON.stringify(raised));
        return { ok: true, id: `A${card++}` as AgendaId };
      },
      close: async (_session, _id, note) => void sinks.push(note),
      promptOf: async () => 'sudo wants your password',
    },
    notifier: { tell: async (_session, _id, message) => void sinks.push(message) },
    journal: {
      publish: async (_session, event) => void sinks.push(JSON.stringify(event)),
      history: async () => [],
      quarantine: async (_session, event) => void sinks.push(JSON.stringify(event)),
      quarantines: async () => [],
    },
    audit: {
      record: async entry => void sinks.push(JSON.stringify(entry)),
      stored: async () => undefined,
      saved: async entry => {
        saves.push(entry);
        sinks.push(JSON.stringify(entry));
      },
    },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    sessions: { ended: async candidate => candidate !== SESSION, all: async () => [SESSION] },
    values,
    quarantine: new QuarantineRegistry(clock),
    redact: async text => values.scrubAll(text),
    ...(options.none === true ? {} : { logins: options.logins?.(spied) ?? spied }),
    ...(options.choice === undefined ? {} : { choice: options.choice }),
    ...(options.observer === undefined ? {} : { observer: options.observer(directory) }),
    hostName: 'Kirin-Box.local',
  });
  /** Everything that left the service except the one write: sinks, plus what the owner and the agent read. */
  const everything = async (): Promise<string> =>
    [
      ...sinks,
      JSON.stringify(await service.list(HOST)),
      JSON.stringify(index.document),
      JSON.stringify(await directory.list()),
    ].join('\n');
  return {
    service,
    writes,
    sinks,
    saves,
    fills,
    values,
    directory,
    sealed,
    everything,
    setFacts: (next: InputTargetFacts) => {
      facts = next;
    },
  };
}

type Harness = ReturnType<typeof harness>;

async function raised(h: Harness, raise: InputRaise = RAISE) {
  const view = await h.service.raise(SESSION, raise);
  const request = (await h.service.list(HOST)).find(candidate => candidate.agendaItemId === view.id);
  if (request === undefined) throw new Error('not raised');
  return { view, request };
}

const typed = (digest: string, value: string, extra: Partial<InputDeliverBody> = {}): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  padded: padInputValue(value),
  submit: true,
  ...extra,
});

const saved = (digest: string, entry: string, signIn?: string): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  entry,
  ...(signIn === undefined ? {} : { signIn }),
  submit: true,
});

/** The sign-in an account has at a place (its only one in these worlds). */
const signInOf = async (h: Harness, account: string): Promise<string> =>
  (await h.directory.accounts.list()).signIns.find(signIn => signIn.account === account)?.id as string;

const refusal = async (promise: Promise<unknown>): Promise<{ code: string; message: string }> =>
  (await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  )) as { code: string; message: string };

describe('the first time: the owner types the value and saves it', () => {
  it('should suggest SUDO_KIRIN_BOX for sudo on this machine, offering nothing yet', async () => {
    const h = harness();
    const { request } = await raised(h);

    should(request.saved).deepEqual({
      match: 'sudo@kirin-box',
      suggest: { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' },
      saves: 'password',
      offers: [],
    });
  });

  it('should type the value, keep it in a new saved login matching the target, and keep a record by name', async () => {
    const h = harness();
    const { request } = await raised(h);
    const result = await h.service.deliver(
      SESSION,
      request.id,
      typed(request.observedDigest as string, PASSWORD, {
        save: { entry: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' },
      }),
      HOST,
    );

    should(result.saved).deepEqual({ entry: 'SUDO_KIRIN_BOX', ok: true });
    should(h.writes).deepEqual([PASSWORD]);
    should(await h.directory.list()).match([
      { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box', match: ['sudo@kirin-box'], fields: { password: true } },
    ]);
    should(h.saves).deepEqual([
      {
        sessionId: SESSION,
        requestId: request.id,
        actor: { kind: 'host' },
        entry: 'SUDO_KIRIN_BOX',
        field: 'password',
      },
    ]);
    should(await h.everything()).not.containEql(PASSWORD);
  });

  it('should save to an existing entry, keeping its label and adding this target to what it matches', async () => {
    const h = harness();
    await h.directory.put(
      'SUDO_LAPTOP',
      PutLoginEntryRequestSchema.parse({ label: 'my sudo', match: ['sudo@laptop'] }),
    );
    const { request } = await raised(h);
    await h.service.deliver(
      SESSION,
      request.id,
      typed(request.observedDigest as string, PASSWORD, { save: { entry: 'SUDO_LAPTOP', label: 'ignored' } }),
      HOST,
    );

    should(await h.directory.list()).match([
      { id: 'SUDO_LAPTOP', label: 'my sudo', match: ['sudo@laptop', 'sudo@kirin-box'] },
    ]);
  });

  it('should keep a plain value as the username', async () => {
    const h = harness();
    const { request } = await raised(h, { ...RAISE, sensitivity: 'plain' });
    should(request.saved?.saves).equal('username');
    await h.service.deliver(
      SESSION,
      request.id,
      typed(request.observedDigest as string, 'kirinnee', { save: { entry: 'SUDO_KIRIN_BOX', label: 'sudo' } }),
      HOST,
    );
    should((await h.directory.list())[0]?.username).equal('kirinnee');
  });

  it('should refuse, with nothing typed, a save that could never happen: a code, or a password too short to mask', async () => {
    const h = harness();
    const code = await raised(h, { ...RAISE, sensitivity: 'private' });
    should(code.request.saved?.saves).be.undefined();
    should(code.request.saved?.suggest).be.undefined();
    const refusedCode = await refusal(
      h.service.deliver(
        SESSION,
        code.request.id,
        typed(code.request.observedDigest as string, '123456', { save: { entry: 'X', label: 'x' } }),
        HOST,
      ),
    );
    const short = await raised(h, { ...RAISE, target: { kind: 'terminal', key: 'other' } });
    const refusedShort = await refusal(
      h.service.deliver(
        SESSION,
        short.request.id,
        typed(short.request.observedDigest as string, 'short', { save: { entry: 'X', label: 'x' } }),
        HOST,
      ),
    );

    should(refusedCode.code).equal('bad_request');
    should(refusedShort.code).equal('bad_request');
    should(refusedShort.message).containEql('without saving');
    should(h.writes).deepEqual([]);
  });

  it('should still deliver when keeping the value fails afterwards, and say so in a fixed sentence', async () => {
    const h = harness({
      logins: port => ({
        ...port,
        save: async () => {
          throw new Error(`disk full near ${PASSWORD}`);
        },
      }),
    });
    const { request } = await raised(h);
    const result = await h.service.deliver(
      SESSION,
      request.id,
      typed(request.observedDigest as string, PASSWORD, { save: { entry: 'SUDO', label: 'sudo' } }),
      HOST,
    );

    should(result.state).equal('delivered');
    should(result.saved?.ok).be.false();
    should(result.saved?.problem).containEql('Settings');
    should(JSON.stringify(result)).not.containEql(PASSWORD);
    should(h.saves).deepEqual([]);
  });
});

describe('the next time: the card offers the saved login, and the owner taps Use', () => {
  async function savedOnce(h: Harness): Promise<void> {
    await h.directory.put(
      'SUDO_KIRIN_BOX',
      PutLoginEntryRequestSchema.parse({ label: 'sudo on kirin-box', match: ['sudo@kirin-box'], password: PASSWORD }),
    );
  }

  it('should offer the matching login as the one-tap choice, and suggest saving to it', async () => {
    const h = harness();
    await savedOnce(h);
    const { request } = await raised(h);

    should(request.saved?.offers).deepEqual([
      {
        id: 'SUDO_KIRIN_BOX',
        label: 'sudo on kirin-box',
        fills: 'password',
        matched: true,
        signIn: await signInOf(h, 'SUDO_KIRIN_BOX'),
        primary: true,
        why: 'only',
      },
    ]);
    should(request.saved?.suggest).deepEqual({ id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' });
  });

  it('should type the saved password through the same guarded write, and tell the agent only "saved"', async () => {
    const h = harness();
    await savedOnce(h);
    const { request, view } = await raised(h);
    const result = await h.service.deliver(
      SESSION,
      request.id,
      saved(request.observedDigest as string, 'SUDO_KIRIN_BOX'),
      HOST,
    );
    const agent = await h.service.agentView(SESSION, view.id, 0);

    should(result).match({ state: 'delivered', submitted: true });
    should(h.writes).deepEqual([PASSWORD]);
    should(agent).match({ state: 'delivered', source: 'saved' });
    should(JSON.stringify(agent)).not.containEql('SUDO_KIRIN_BOX');
    should(
      h.sinks.some(line => line.includes('"source":"saved"') && line.includes('"entry":"SUDO_KIRIN_BOX"')),
    ).be.true();
    should(await h.everything()).not.containEql(PASSWORD);
  });

  it('should quarantine the terminal after a saved password exactly as after a typed one', async () => {
    const h = harness();
    await savedOnce(h);
    const { request } = await raised(h);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_KIRIN_BOX'), HOST);

    should(h.service.quarantinedUntil(SESSION, ['dev'])).be.a.Number();
  });

  it('should not offer a login for another target as the one-tap choice, but keep it selectable by hand', async () => {
    const h = harness();
    await h.directory.put(
      'SUDO_LAPTOP',
      PutLoginEntryRequestSchema.parse({ label: 'sudo on laptop', match: ['sudo@laptop'], password: PASSWORD }),
    );
    const { request } = await raised(h);

    should(request.saved?.offers).deepEqual([
      { id: 'SUDO_LAPTOP', label: 'sudo on laptop', fills: 'password', matched: false },
    ]);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_LAPTOP'), HOST);
    should(h.writes).deepEqual([PASSWORD]);
  });

  it('should drop the one-tap offer when a redrawn card is on a prompt that left line mode (secrev-1234 L3)', async () => {
    const h = harness();
    await savedOnce(h);
    const { request } = await raised(h);
    should(request.saved?.offers[0]?.matched).be.true();
    // The same pane, program, echo and prompt: the card is redrawn, but a relay now reads what is typed.
    h.setFacts({ ...sudoFacts(), canonical: false } as InputTargetFacts);

    await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_KIRIN_BOX'), HOST),
    );
    const redrawn = (await h.service.list(HOST)).find(candidate => candidate.id === request.id);

    should(redrawn?.observedDigest).not.equal(request.observedDigest);
    should(redrawn?.saved).not.have.property('match');
    should(redrawn?.saved?.offers.some(offer => offer.matched || offer.primary === true)).be.false();
    should(h.writes).deepEqual([]);
  });

  it('should not match a look-alike program on the same host', async () => {
    const h = harness({ facts: sudoFacts('sudo-fake', 'sudo-fake') });
    await savedOnce(h);
    const { request } = await raised(h);
    should(request.saved?.offers.map(offer => offer.matched)).deepEqual([false]);
  });

  it('should mark the ferret’s hint without ever making it the one-tap choice, and tell the ferret nothing either way', async () => {
    const h = harness();
    await h.directory.put(
      'SUDO_LAPTOP',
      PutLoginEntryRequestSchema.parse({ label: 'laptop', match: ['sudo@laptop'], password: PASSWORD }),
    );
    const hinted = await raised(h, { ...RAISE, secretHint: 'SUDO_LAPTOP' });
    const unknown = await raised(h, {
      ...RAISE,
      target: { kind: 'terminal', key: 'two' },
      secretHint: 'NO_SUCH_LOGIN',
    });

    should(hinted.request.saved?.offers).deepEqual([
      { id: 'SUDO_LAPTOP', label: 'laptop', fills: 'password', matched: false, hinted: true },
    ]);
    const { id: _a, note: _n, ...first } = hinted.view;
    const { id: _b, note: _m, ...second } = unknown.view;
    should(first).deepEqual(second);
  });

  it('should refuse an agent tapping Use, before a saved value is opened', async () => {
    const h = harness();
    await savedOnce(h);
    const { request } = await raised(h);
    const refused = await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_KIRIN_BOX'), AGENT),
    );

    should(refused.code).equal('forbidden');
    should(h.fills).deepEqual([]);
    should(h.writes).deepEqual([]);
  });

  it('should open nothing when the target changed since the card was drawn', async () => {
    const h = harness();
    await savedOnce(h);
    const { request } = await raised(h);
    h.setFacts(sudoFacts('zsh', '-zsh'));
    const refused = await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_KIRIN_BOX'), HOST),
    );

    should(refused.code).equal('conflict');
    should(h.fills).deepEqual([]);
    should(h.writes).deepEqual([]);
  });

  it('should refuse an unknown login or one without the field, with nothing typed', async () => {
    const h = harness();
    await h.directory.put('BARE', PutLoginEntryRequestSchema.parse({ label: 'bare', username: 'kirin' }));
    const { request } = await raised(h);
    const unknown = await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'NOPE'), HOST),
    );
    const empty = await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'BARE'), HOST),
    );

    should(unknown.code).equal('not_found');
    should(empty.code).equal('bad_request');
    should(h.writes).deepEqual([]);
  });

  it('should refuse a sign-in that is not one of the account it types from, opening and typing nothing (invariant 13)', async () => {
    const h = harness();
    await savedOnce(h);
    await h.directory.put(
      'SUDO_LAPTOP',
      PutLoginEntryRequestSchema.parse({ label: 'laptop', match: ['sudo@laptop'], password: 'laptop-UNIQUE-pw' }),
    );
    const laptop = await signInOf(h, 'SUDO_LAPTOP');
    const { request } = await raised(h);
    const digest = request.observedDigest as string;

    const another = await refusal(
      h.service.deliver(SESSION, request.id, saved(digest, 'SUDO_KIRIN_BOX', laptop), HOST),
    );
    const none = await refusal(
      h.service.deliver(SESSION, request.id, saved(digest, 'SUDO_KIRIN_BOX', 'si_00000000000000ff'), HOST),
    );

    for (const refused of [another, none]) {
      should(refused.code).equal('bad_request');
      should(refused.message).equal('that sign-in is not one of SUDO_KIRIN_BOX; nothing was typed');
    }
    should(h.fills).deepEqual([]);
    should(h.writes).deepEqual([]);
    // Its own sign-in is taken, and the card is still there to take it.
    const own = await signInOf(h, 'SUDO_KIRIN_BOX');
    await h.service.deliver(SESSION, request.id, saved(digest, 'SUDO_KIRIN_BOX', own), HOST);
    should(h.writes).deepEqual([PASSWORD]);
  });

  it('should type nothing when the accounts cannot be read to check the sign-in', async () => {
    let broken = false;
    const h = harness({
      logins: port => ({
        ...port,
        listing: async () => (broken ? await Promise.reject(new Error('damaged')) : await port.listing()),
      }),
    });
    await savedOnce(h);
    const own = await signInOf(h, 'SUDO_KIRIN_BOX');
    const { request } = await raised(h);
    broken = true;

    const refused = await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_KIRIN_BOX', own), HOST),
    );

    should(refused.code).equal('unavailable');
    should(refused.message).equal('Ferretry could not read the saved accounts, so nothing was typed');
    should(h.fills).deepEqual([]);
    should(h.writes).deepEqual([]);
  });

  it("should make the ferret's matched choice the primary, and still type nothing until the owner taps (invariant 12)", async () => {
    const h = harness();
    await savedOnce(h);
    await h.directory.put(
      'SUDO_ADMIN',
      PutLoginEntryRequestSchema.parse({ label: 'admin', match: ['sudo@kirin-box'], password: 'admin-UNIQUE-pw' }),
    );
    const { request, view } = await raised(h, { ...RAISE, secretHint: 'SUDO_ADMIN' });

    should(request.saved?.offers.map(offer => [offer.id, offer.primary === true, offer.why])).deepEqual([
      ['SUDO_ADMIN', true, 'ferret'],
      ['SUDO_KIRIN_BOX', false, undefined],
    ]);
    await h.service.list(HOST);
    await h.service.agentView(SESSION, view.id, 0);
    should(h.fills).deepEqual([]);
    should(h.writes).deepEqual([]);
    const byAgent = await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_ADMIN'), AGENT),
    );
    should(byAgent.code).equal('forbidden');
    should(h.writes).deepEqual([]);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_ADMIN'), HOST);
    should(h.writes).deepEqual(['admin-UNIQUE-pw']);
  });

  it('should make the owner’s site default the primary, and say so (R1-5)', async () => {
    const h = harness({ choice: { of: async () => ({ defaults: { sites: { 'sudo@kirin-box': 'SUDO_ADMIN' } } }) } });
    await savedOnce(h);
    await h.directory.put(
      'SUDO_ADMIN',
      PutLoginEntryRequestSchema.parse({ label: 'admin', match: ['sudo@kirin-box'], password: 'admin-UNIQUE-pw' }),
    );
    const { request } = await raised(h);

    should(request.saved?.offers.map(offer => [offer.id, offer.primary === true, offer.why])).deepEqual([
      ['SUDO_ADMIN', true, 'site'],
      ['SUDO_KIRIN_BOX', false, undefined],
    ]);
    should(h.writes).deepEqual([]);
  });

  it('should let the session’s project default win over the site default, naming the project', async () => {
    const asked: string[] = [];
    const h = harness({
      choice: {
        of: async sessionId => {
          asked.push(sessionId);
          return {
            project: { id: 'p1', name: 'ferretry', nameIsUnique: true },
            defaults: {
              sites: { 'sudo@kirin-box': 'SUDO_KIRIN_BOX' },
              projects: { ferretry: { 'sudo@kirin-box': 'SUDO_ADMIN' } },
            },
          };
        },
      },
    });
    await savedOnce(h);
    await h.directory.put(
      'SUDO_ADMIN',
      PutLoginEntryRequestSchema.parse({ label: 'admin', match: ['sudo@kirin-box'], password: 'admin-UNIQUE-pw' }),
    );
    const { request } = await raised(h);

    should(request.saved?.offers.find(offer => offer.primary === true)).containEql({
      id: 'SUDO_ADMIN',
      why: 'project',
    });
    should(request.saved?.offers.find(offer => offer.primary === true)?.project).equal('ferretry');
    should(new Set(asked)).deepEqual(new Set([SESSION]));
  });

  it('should set nothing when a default names an account that does not sign in here (invariant 11)', async () => {
    const h = harness({
      choice: {
        of: async () => ({
          project: { id: 'p1', name: 'ferretry', nameIsUnique: true },
          defaults: {
            sites: { 'sudo@kirin-box': 'ELSEWHERE' },
            projects: { ferretry: { 'sudo@kirin-box': 'ELSEWHERE' } },
          },
        }),
      },
    });
    await savedOnce(h);
    await h.directory.put(
      'SUDO_ADMIN',
      PutLoginEntryRequestSchema.parse({ label: 'admin', match: ['sudo@kirin-box'], password: 'admin-UNIQUE-pw' }),
    );
    await h.directory.put(
      'ELSEWHERE',
      PutLoginEntryRequestSchema.parse({ label: 'elsewhere', match: ['sudo@other-box'], password: 'else-UNIQUE-pw' }),
    );
    const { request } = await raised(h);

    should(request.saved?.offers.filter(offer => offer.primary === true || offer.why !== undefined)).deepEqual([]);
  });

  it('should still draw the card when the choice cannot be read', async () => {
    const h = harness({
      choice: {
        of: async () => {
          throw new Error('no store');
        },
      },
    });
    await savedOnce(h);
    const { request } = await raised(h);

    should(request.saved?.offers.map(offer => [offer.id, offer.primary === true, offer.why])).deepEqual([
      ['SUDO_KIRIN_BOX', true, 'only'],
    ]);
  });

  it('should offer no primary when two accounts sign in at this terminal and nothing chose one (invariant 11)', async () => {
    const h = harness();
    await savedOnce(h);
    await h.directory.put(
      'SUDO_ADMIN',
      PutLoginEntryRequestSchema.parse({ label: 'admin', match: ['sudo@kirin-box'], password: 'admin-UNIQUE-pw' }),
    );
    const { request } = await raised(h);

    should(request.saved?.offers.map(offer => [offer.id, offer.matched, offer.primary === true])).deepEqual([
      ['SUDO_ADMIN', true, false],
      ['SUDO_KIRIN_BOX', true, false],
    ]);
    should(request.saved).not.have.property('suggest');
  });

  it('should never offer a 2FA code by hand from an account that does not sign in here', async () => {
    const h = harness();
    await h.directory.put('GITHUB', PutLoginEntryRequestSchema.parse({ label: 'GitHub' }));
    await plantSeed(h.directory.accounts, 'GITHUB', SEED);
    const { request } = await raised(h, { ...RAISE, sensitivity: 'private' });
    should(request.saved?.offers).deepEqual([]);
  });

  it('should type the username of a saved login into a plain prompt', async () => {
    const h = harness();
    await h.directory.put('GITHUB', PutLoginEntryRequestSchema.parse({ label: 'GitHub', username: 'kirinnee' }));
    const { request } = await raised(h, { ...RAISE, sensitivity: 'plain' });
    should(request.saved?.offers.map(offer => offer.fills)).deepEqual(['username']);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'GITHUB'), HOST);
    should(h.writes).deepEqual(['kirinnee']);
  });

  it('should make the 2FA code inside the daemon and type it, with the seed and the code in no other sink', async () => {
    const h = harness();
    await h.directory.put('GITHUB', PutLoginEntryRequestSchema.parse({ label: 'GitHub', match: ['sudo@kirin-box'] }));
    await plantSeed(h.directory.accounts, 'GITHUB', SEED);
    const { request } = await raised(h, { ...RAISE, sensitivity: 'private' });
    should(request.saved?.offers.map(offer => offer.fills)).deepEqual(['totp']);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'GITHUB'), HOST);
    const code = totpCode(SEED, { algorithm: 'SHA1', digits: 6, period: 30 }, NOW) as string;

    should(h.writes).deepEqual([code]);
    const sunk = await h.everything();
    should(sunk).not.containEql(SEED);
    should(sunk).not.containEql(code);
  });

  it('should never RETURN a code it made for a `code` card: in no result, route or sink, and masked from text reads', async () => {
    // Arrange — the approved pick: a daemon-made TOTP code is typed only into the observed field, never returned.
    const h = harness({ facts: otpFacts() });
    await h.directory.put('GITHUB', PutLoginEntryRequestSchema.parse({ label: 'GitHub', match: ['ssh@bastion'] }));
    await plantSeed(h.directory.accounts, 'GITHUB', SEED);
    const { request, view } = await raised(h, { ...RAISE, prompt: 'GitHub wants the 2FA code', sensitivity: 'code' });
    should(request.saved?.offers.map(offer => offer.fills)).deepEqual(['totp']);

    // Act
    const result = await h.service.deliver(
      SESSION,
      request.id,
      saved(request.observedDigest as string, 'GITHUB'),
      HOST,
    );
    const waited = await h.service.agentView(SESSION, view.id, 0);
    const code = totpCode(SEED, { algorithm: 'SHA1', digits: 6, period: 30 }, NOW) as string;

    // Assert — typed once, into the target; nowhere else, and a read of the screen shows it masked.
    should(h.writes).deepEqual([code]);
    should(h.values.scrub(SESSION, `Enter code: ${code}`)).equal(`Enter code: [redacted:input ${view.id}]`);
    for (const out of [result, waited, await h.everything()]) {
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      should(text).not.containEql(code);
      should(text).not.containEql(SEED);
    }
  });

  it('should leave a code the OWNER typed unmasked: it is not secret', async () => {
    // Arrange
    const h = harness({ facts: otpFacts() });
    const { request } = await raised(h, { ...RAISE, prompt: 'GitHub wants the 2FA code', sensitivity: 'code' });

    // Act
    await h.service.deliver(SESSION, request.id, typed(request.observedDigest as string, '481516'), HOST);

    // Assert
    should(h.writes).deepEqual(['481516']);
    should(h.values.scrub(SESSION, 'Enter code: 481516')).equal('Enter code: 481516');
  });
  it('should offer nothing and still let the owner type when the saved logins cannot be read', async () => {
    const h = harness({
      logins: port => ({
        ...port,
        entries: async () => {
          throw new Error('damaged');
        },
      }),
    });
    const { request } = await raised(h);
    should(request.saved?.offers).deepEqual([]);
    await h.service.deliver(SESSION, request.id, typed(request.observedDigest as string, PASSWORD), HOST);
    should(h.writes).deepEqual([PASSWORD]);
  });
});

describe('the refusals around saved logins, each with nothing typed', () => {
  it('should refuse "Save as" on a daemon that keeps no saved logins', async () => {
    const h = harness({ none: true });
    const { request } = await raised(h);
    should(request.saved).be.undefined();
    const refused = await refusal(
      h.service.deliver(
        SESSION,
        request.id,
        typed(request.observedDigest as string, PASSWORD, { save: { entry: 'X', label: 'x' } }),
        HOST,
      ),
    );
    should(refused.message).containEql('no saved logins');
    should(h.writes).deepEqual([]);
  });

  it('should refuse to keep a plain value that cannot be a username', async () => {
    const h = harness();
    const { request } = await raised(h, { ...RAISE, sensitivity: 'plain' });
    const refused = await refusal(
      h.service.deliver(
        SESSION,
        request.id,
        typed(request.observedDigest as string, 'kirin\tnee', { save: { entry: 'X', label: 'x' } }),
        HOST,
      ),
    );
    should(refused.message).containEql('username');
    should(h.writes).deepEqual([]);
  });

  it('should answer a store that cannot be opened as unavailable, without what it said', async () => {
    const h = harness({
      logins: port => ({
        ...port,
        fill: async () => {
          throw new Error(`the key file near ${PASSWORD} is gone`);
        },
      }),
    });
    await h.directory.put(
      'ANY',
      PutLoginEntryRequestSchema.parse({ label: 'any', match: ['sudo@kirin-box'], password: PASSWORD }),
    );
    const { request } = await raised(h);
    const refused = await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'ANY'), HOST),
    );
    should(refused.code).equal('unavailable');
    should(refused.message).not.containEql(PASSWORD);
    should(h.writes).deepEqual([]);
  });

  it("should refuse by the vault's own words when the account changed between the check and the fill", async () => {
    for (const [error, code] of [
      [new LoginEntryError('unknown_login', 'there is no saved login ANY'), 'not_found'],
      [new LoginEntryError('no_such_field', 'ANY keeps no password'), 'bad_request'],
    ] as const) {
      const h = harness({ logins: port => ({ ...port, fill: async () => await Promise.reject(error) }) });
      await h.directory.put(
        'ANY',
        PutLoginEntryRequestSchema.parse({ label: 'any', match: ['sudo@kirin-box'], password: PASSWORD }),
      );
      const { request } = await raised(h);
      const refused = await refusal(
        h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'ANY'), HOST),
      );
      should(refused.code).equal(code);
      should(refused.message).equal(`${error.message}; nothing was typed`);
      should(h.writes).deepEqual([]);
    }
  });

  it('should refuse a saved value that would press keys, without saying what it was', async () => {
    const h = harness({ logins: port => ({ ...port, fill: async () => 'line-one\nline-two' }) });
    await h.directory.put(
      'ANY',
      PutLoginEntryRequestSchema.parse({ label: 'any', match: ['sudo@kirin-box'], password: PASSWORD }),
    );
    const { request } = await raised(h);
    const refused = await refusal(
      h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'ANY'), HOST),
    );
    should(refused.code).equal('bad_request');
    should(refused.message).not.containEql('line-one');
    should(h.writes).deepEqual([]);
  });
});

describe('what the daemon saw is kept on the saved login', () => {
  it('should hand a one-tap delivery to the observer with the login, its hosts and the value for its own look', async () => {
    const told: LoginDelivery[] = [];
    const h = harness({
      observer: () => ({ delivered: async delivery => void told.push(delivery), tainted: () => false }),
    });
    await h.directory.put(
      'SUDO_KIRIN_BOX',
      PutLoginEntryRequestSchema.parse({ label: 'sudo', match: ['sudo@kirin-box'], password: PASSWORD }),
    );
    const { request } = await raised(h);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_KIRIN_BOX'), HOST);
    await Bun.sleep(0);

    should(told).have.length(1);
    should(told[0]).containDeep({
      sessionId: SESSION,
      login: 'SUDO_KIRIN_BOX',
      signIn: await signInOf(h, 'SUDO_KIRIN_BOX'),
      domains: [],
      target: { kind: 'terminal', key: 'dev' },
      secrets: [PASSWORD],
      submitted: true,
      matchKey: 'sudo@kirin-box',
    });
  });

  it('should keep the facts of the write on the login, never the value', async () => {
    const h = harness({
      observer: directory =>
        new LoginObserver({
          sink: directory.accounts,
          probe: { shows: async () => false, where: async () => undefined },
          now: () => NOW,
          sleep: async () => undefined,
        }),
    });
    const { request } = await raised(h);
    await h.service.deliver(
      SESSION,
      request.id,
      typed(request.observedDigest as string, PASSWORD, { save: { entry: 'SUDO_KIRIN_BOX', label: 'sudo' } }),
      HOST,
    );
    await Bun.sleep(5);

    const [signIn] = (await h.directory.accounts.list()).signIns;
    should(signIn?.observed?.[0]).containDeep({
      at: 'sudo@kirin-box',
      surface: 'terminal',
      masked: { value: true, count: 1 },
      noEchoAfterSubmit: { value: true, count: 1 },
    });
    should(await h.everything()).not.containEql(PASSWORD);
  });

  it('should tell the observer about a typed value no login holds, so a code can follow a password', async () => {
    const told: LoginDelivery[] = [];
    const h = harness({
      observer: () => ({ delivered: async delivery => void told.push(delivery), tainted: () => false }),
    });
    const { request } = await raised(h);
    await h.service.deliver(SESSION, request.id, typed(request.observedDigest as string, PASSWORD), HOST);
    await Bun.sleep(0);
    should(told).have.length(1);
    should(told[0]).not.have.property('login');
    should(told[0]).not.have.property('signIn');
  });

  it('should file the facts on the sign-in the owner tapped, and none for an account picked by hand elsewhere (invariant 14)', async () => {
    const told: LoginDelivery[] = [];
    const h = harness({
      observer: () => ({ delivered: async delivery => void told.push(delivery), tainted: () => false }),
    });
    await h.directory.put(
      'SUDO_LAPTOP',
      PutLoginEntryRequestSchema.parse({ label: 'laptop', match: ['sudo@laptop'], password: PASSWORD }),
    );
    const { request } = await raised(h);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_LAPTOP'), HOST);
    await Bun.sleep(0);
    should(told[0]).containDeep({ login: 'SUDO_LAPTOP' });
    should(told[0]).not.have.property('signIn');
  });

  it('should keep two accounts on one terminal apart: each one’s facts on its own sign-in (invariant 14)', async () => {
    const h = harness({
      observer: directory =>
        new LoginObserver({
          sink: directory.accounts,
          probe: { shows: async () => false, where: async () => undefined },
          now: () => NOW,
          sleep: async () => undefined,
        }),
    });
    for (const [id, label, password] of [
      ['SUDO_KIRIN_BOX', 'kirin', PASSWORD],
      ['SUDO_ADMIN', 'admin', 'admin-UNIQUE-pw'],
    ] as const)
      await h.directory.put(id, PutLoginEntryRequestSchema.parse({ label, match: ['sudo@kirin-box'], password }));
    const factsOf = async (account: string) =>
      (await h.directory.accounts.list()).signIns.find(signIn => signIn.account === account)?.observed;
    // The owner taps the account that sorts LAST ("kirin" after "admin"), naming its sign-in.
    const first = await raised(h);
    await h.service.deliver(
      SESSION,
      first.request.id,
      saved(first.request.observedDigest as string, 'SUDO_KIRIN_BOX', await signInOf(h, 'SUDO_KIRIN_BOX')),
      HOST,
    );
    await Bun.sleep(5);
    should(await factsOf('SUDO_KIRIN_BOX')).have.length(1);
    should(await factsOf('SUDO_ADMIN')).be.undefined();

    // An older app names no sign-in: the facts go to that account's sign-in matched here, never another's.
    const second = await raised(h);
    await h.service.deliver(
      SESSION,
      second.request.id,
      saved(second.request.observedDigest as string, 'SUDO_ADMIN'),
      HOST,
    );
    await Bun.sleep(5);
    should(await factsOf('SUDO_ADMIN')).have.length(1);
    should((await factsOf('SUDO_KIRIN_BOX'))?.[0]?.masked?.count).equal(1);
  });
});

describe('a login observer that fails', () => {
  it('should never fail or hold up the delivery', async () => {
    const h = harness({
      observer: () => ({ delivered: async () => await Promise.reject(new Error('store gone')), tainted: () => false }),
    });
    const { request } = await raised(h);
    const result = await h.service.deliver(
      SESSION,
      request.id,
      typed(request.observedDigest as string, PASSWORD),
      HOST,
    );
    await Bun.sleep(0);
    should(result.state).equal('delivered');
  });
});

describe('a 2FA key set up from an open card', () => {
  it('should say where the daemon saw the open card’s target, and nothing for one that is closed or unknown', async () => {
    // Arrange
    const h = harness();
    const { request } = await raised(h);

    // Act
    const open = h.service.cardTarget(request.id);
    await h.service.cancel(SESSION, request.id, HOST);
    const closed = h.service.cardTarget(request.id);

    // Assert — the match key is the daemon's (`sudo@<host>`), never the ferret's words
    should(open).match({ matchKey: /^sudo@/u });
    should(closed).be.undefined();
    should(h.service.cardTarget('f'.repeat(32))).be.undefined();
  });
});
