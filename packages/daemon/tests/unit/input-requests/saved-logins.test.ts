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
import type { InputCaller, InputLoginPort } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { LoginDirectory, LoginVault, totpCode } from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';

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
  recognisedConsumer: true,
});

const RAISE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo wants your password',
  sensitivity: 'secret',
  submit: 'owner-default',
};

function harness(options: { facts?: InputTargetFacts; logins?: (port: InputLoginPort) => InputLoginPort } = {}) {
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
    entries: async () => await real.entries(),
    fill: async (entry, role, at) => {
      fills.push(`${entry}:${role}`);
      return await real.fill(entry, role, at);
    },
    save: async (...args) => await real.save(...args),
  };
  const service = new InputRequestService({
    target: {
      observe: async () => ({ ok: true, facts }),
      type: async (_session, _target, text) => {
        writes.push(text);
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
    logins: options.logins?.(spied) ?? spied,
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

const saved = (digest: string, entry: string): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  entry,
  submit: true,
});

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
      typed(request.observedDigest as string, PASSWORD, { save: { entry: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' } }),
      HOST,
    );

    should(result.saved).deepEqual({ entry: 'SUDO_KIRIN_BOX', ok: true });
    should(h.writes).deepEqual([PASSWORD]);
    should(await h.directory.list()).match([
      { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box', match: ['sudo@kirin-box'], fields: { password: true } },
    ]);
    should(h.saves).deepEqual([
      { sessionId: SESSION, requestId: request.id, actor: { kind: 'host' }, entry: 'SUDO_KIRIN_BOX', field: 'password' },
    ]);
    should(await h.everything()).not.containEql(PASSWORD);
  });

  it('should save to an existing entry, keeping its label and adding this target to what it matches', async () => {
    const h = harness();
    await h.directory.put('SUDO_LAPTOP', PutLoginEntryRequestSchema.parse({ label: 'my sudo', match: ['sudo@laptop'] }));
    const { request } = await raised(h);
    await h.service.deliver(
      SESSION,
      request.id,
      typed(request.observedDigest as string, PASSWORD, { save: { entry: 'SUDO_LAPTOP', label: 'ignored' } }),
      HOST,
    );

    should(await h.directory.list()).match([{ id: 'SUDO_LAPTOP', label: 'my sudo', match: ['sudo@laptop', 'sudo@kirin-box'] }]);
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
      { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box', fills: 'password', matched: true },
    ]);
    should(request.saved?.suggest).deepEqual({ id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' });
  });

  it('should type the saved password through the same guarded write, and tell the agent only "saved"', async () => {
    const h = harness();
    await savedOnce(h);
    const { request, view } = await raised(h);
    const result = await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_KIRIN_BOX'), HOST);
    const agent = await h.service.agentView(SESSION, view.id, 0);

    should(result).match({ state: 'delivered', submitted: true });
    should(h.writes).deepEqual([PASSWORD]);
    should(agent).match({ state: 'delivered', source: 'saved' });
    should(JSON.stringify(agent)).not.containEql('SUDO_KIRIN_BOX');
    should(h.sinks.some(line => line.includes('"source":"saved"') && line.includes('"entry":"SUDO_KIRIN_BOX"'))).be.true();
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

    should(request.saved?.offers).deepEqual([{ id: 'SUDO_LAPTOP', label: 'sudo on laptop', fills: 'password', matched: false }]);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'SUDO_LAPTOP'), HOST);
    should(h.writes).deepEqual([PASSWORD]);
  });

  it('should not match a look-alike program on the same host', async () => {
    const h = harness({ facts: sudoFacts('sudo-fake', 'sudo-fake') });
    await savedOnce(h);
    const { request } = await raised(h);
    should(request.saved?.offers.map(offer => offer.matched)).deepEqual([false]);
  });

  it('should mark the ferret’s hint without ever making it the one-tap choice, and tell the ferret nothing either way', async () => {
    const h = harness();
    await h.directory.put('SUDO_LAPTOP', PutLoginEntryRequestSchema.parse({ label: 'laptop', match: ['sudo@laptop'], password: PASSWORD }));
    const hinted = await raised(h, { ...RAISE, secretHint: 'SUDO_LAPTOP' });
    const unknown = await raised(h, { ...RAISE, target: { kind: 'terminal', key: 'two' }, secretHint: 'NO_SUCH_LOGIN' });

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
    const unknown = await refusal(h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'NOPE'), HOST));
    const empty = await refusal(h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'BARE'), HOST));

    should(unknown.code).equal('not_found');
    should(empty.code).equal('bad_request');
    should(h.writes).deepEqual([]);
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
    await h.directory.put(
      'GITHUB',
      PutLoginEntryRequestSchema.parse({ label: 'GitHub', totp: { seed: SEED }, totpAcknowledged: true }),
    );
    const { request } = await raised(h, { ...RAISE, sensitivity: 'private' });
    should(request.saved?.offers.map(offer => offer.fills)).deepEqual(['totp']);
    await h.service.deliver(SESSION, request.id, saved(request.observedDigest as string, 'GITHUB'), HOST);
    const code = totpCode(SEED, { algorithm: 'SHA1', digits: 6, period: 30 }, NOW) as string;

    should(h.writes).deepEqual([code]);
    const sunk = await h.everything();
    should(sunk).not.containEql(SEED);
    should(sunk).not.containEql(code);
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
