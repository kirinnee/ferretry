import { describe, it } from 'bun:test';
import {
  type AgendaId,
  type InputDeliverBody,
  type InputRaise,
  type InputTargetFacts,
  PutLoginEntryRequestSchema,
  padInputValue,
  type TwoFactorId,
} from '@ferretry/protocol';
import should from 'should';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { InputLoginAdapter } from '../../../src/lib/input-requests/login-adapter.ts';
import type { CodeDelivery } from '../../../src/lib/input-requests/login-observer.ts';
import type { InputCaller, InputCard, InputLoginPort } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import {
  LoginDirectory,
  LoginVault,
  lateSeedCards,
  TwoFactorSeedStages,
  totpCode,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments, plantSeed } from '../runtime/mounts/support.ts';

/**
 * R2-3, CODE CARDS through the REAL input service and the REAL account store (fake cipher, memory files): a code card
 * is titled by the owner's 2FA key, offers one "Use code from Ferretry" per seeded key of the MATCHED account only, and
 * the daemon types a code it made only where the sign-in signs in — never returned, never hand-picked, never into a
 * field that turned out to be a password. A code that did not go through opens the card again for a typed one.
 */

const SESSION = 'mvv6b4qw-49d0158d';
const SEED_A = 'JBSWY3DPEHPK3PXP';
const SEED_B = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
const SIX = { algorithm: 'SHA1', digits: 6, period: 30 } as const;
const codeOf = (seed: string): string => totpCode(seed, SIX, NOW) as string;

type PageFacts = Extract<InputTargetFacts, { readonly kind: 'browser' }>;
type PageField = PageFacts['fields'][number];

const codeField = (over: Partial<PageField> = {}): PageField => ({
  fieldId: 'code',
  frameOrigin: 'https://github.com',
  frameId: 'main',
  backendNodeId: 31,
  field: { tag: 'input', type: 'text', autocomplete: 'one-time-code' },
  box: { x: 10, y: 10, w: 200, h: 40 },
  visible: true,
  ...over,
});

const page = (origin = 'https://github.com', field: Partial<PageField> = {}, secure = true): PageFacts => ({
  kind: 'browser',
  pageId: 'page-1',
  origin,
  secure,
  navigationId: 'loader-1',
  fields: [codeField({ frameOrigin: origin, ...field })],
});

/** A one-time code prompt with echo off: it stays a code only while a code program Ferretry proved reads it. */
const otpPrompt = (dest = 'bastion'): InputTargetFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'ssh', argv: `ssh ${dest}` },
  echo: 'off',
  cursorRow: 1,
  promptLine: 'Verification code:',
  promptLineDigest: 'a'.repeat(64),
  program: 'ssh',
  canonical: true,
  recognisedConsumer: true,
});

const PAGE_CODE: InputRaise = {
  target: { kind: 'browser', key: 'app' },
  prompt: 'GitHub wants the 2FA code',
  fields: [{ id: 'code', sensitivity: 'code', element: { kind: 'ref', ref: 'e3' } }],
  submit: 'owner-default',
};

const TERMINAL_CODE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'the bastion wants the 2FA code',
  sensitivity: 'code',
  submit: 'owner-default',
};

interface Options {
  facts?: InputTargetFacts;
  codeProgram?: boolean;
  /** What the login observer says a code Ferretry made came to. Absent: no observer. */
  verdict?: boolean | undefined;
  /** Runs inside the observer's check, before its verdict; a throw is the check failing. */
  beforeVerdict?: (service: InputRequestService) => Promise<void>;
  /** The page is pictured (every raise and redraw). */
  pictured?: true;
}

function harness(options: Options = {}) {
  const writes: string[] = [];
  const sinks: string[] = [];
  const cards: InputCard[] = [];
  const fills: string[] = [];
  const checks: CodeDelivery[] = [];
  let facts = options.facts ?? page();
  let codeProgram = options.codeProgram === true;
  let card = 1;
  let id = 1;
  const clock = { now: () => NOW };
  const values = new EphemeralValues(clock);
  const index = new MemoryLoginIndex();
  const sealed = new MemorySecretDocuments();
  const cipher = new FakeSecretCipher();
  const directory = new LoginDirectory(index, sealed, cipher, { now: () => new Date(NOW).toISOString() });
  const real = new InputLoginAdapter(directory, new LoginVault(index, sealed, cipher));
  const logins: InputLoginPort = {
    listing: async () => await real.listing(),
    fill: async (entry, role, at, more) => {
      fills.push(`${entry}:${role}${more?.factor === undefined ? '' : `:${more.factor}`}`);
      return await real.fill(entry, role, at, more);
    },
    save: async (...args) => await real.save(...args),
  };
  const service: InputRequestService = new InputRequestService({
    target: {
      observe: async () => ({ ok: true, facts, ...(codeProgram ? { codeProgram: true as const } : {}) }),
      type: async (_session, _target, typed) => {
        writes.push(...typed.map(value => value.text));
        return 'typed';
      },
      ...(options.pictured === true
        ? { shoot: async () => ({ pngBase64: 'iVBORw0KGgo=', clip: { x: 0, y: 0, w: 1, h: 1 } }) }
        : {}),
    },
    agenda: {
      raise: async (_session, raised) => {
        cards.push(raised);
        sinks.push(JSON.stringify(raised));
        return { ok: true, id: `A${card++}` as AgendaId };
      },
      close: async (_session, _id, note) => void sinks.push(note),
      promptOf: async () => undefined,
    },
    notifier: { tell: async (_session, at, message) => void sinks.push(`${at}: ${message}`) },
    journal: {
      publish: async (_session, event) => void sinks.push(JSON.stringify(event)),
      history: async () => [],
      quarantine: async (_session, event) => void sinks.push(JSON.stringify(event)),
      quarantines: async () => [],
    },
    audit: {
      record: async entry => void sinks.push(JSON.stringify(entry)),
      stored: async () => undefined,
      saved: async entry => void sinks.push(JSON.stringify(entry)),
    },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    sessions: { ended: async candidate => candidate !== SESSION, all: async () => [SESSION] },
    values,
    quarantine: new QuarantineRegistry(clock),
    redact: async text => values.scrubAll(text),
    logins,
    hostName: 'kirin-box',
    ...(!('verdict' in options)
      ? {}
      : {
          observer: {
            delivered: async () => undefined,
            tainted: () => false,
            codeTyped: async (typed: CodeDelivery) => {
              checks.push(typed);
              await options.beforeVerdict?.(service);
              if (typed.facts.kind === 'browser') facts = typed.facts;
              return options.verdict;
            },
          },
        }),
  });
  const everything = async (): Promise<string> =>
    [...sinks, JSON.stringify(await service.list(HOST)), JSON.stringify(index.document)].join('\n');
  return {
    service,
    writes,
    sinks,
    cards,
    fills,
    checks,
    directory,
    everything,
    setFacts: (next: InputTargetFacts) => {
      facts = next;
    },
    setCodeProgram: (next: boolean) => {
      codeProgram = next;
    },
  };
}

type Harness = ReturnType<typeof harness>;

async function raised(h: Harness, raise: InputRaise = PAGE_CODE) {
  const view = await h.service.raise(SESSION, raise);
  const request = (await h.service.list(HOST)).find(candidate => candidate.agendaItemId === view.id);
  if (request === undefined) throw new Error('not raised');
  return { view, request };
}

const useCode = (digest: string, entry: string, extra: Partial<InputDeliverBody> = {}): InputDeliverBody => ({
  deliveryId: crypto.randomUUID(),
  observedDigest: digest,
  entry,
  submit: true,
  ...extra,
});

const refusal = async (promise: Promise<unknown>): Promise<{ code: string; message: string }> =>
  (await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  )) as { code: string; message: string };

/** Lets the checks that run after a Send (not awaited by it) finish. */
const settled = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 10));

/** GitHub · kirinnee, signing in at github.com (and the bastion), with the 2FA keys `keys` adds. */
async function github(h: Harness, match: readonly string[] = ['github.com']): Promise<void> {
  await h.directory.put(
    'GITHUB',
    PutLoginEntryRequestSchema.parse({ label: 'GitHub', username: 'kirinnee', match: [...match] }),
  );
}

const keysOf = async (h: Harness, account = 'GITHUB') =>
  (await h.directory.accounts.list()).accounts.find(each => each.id === account)?.factors ?? [];

const keyId = async (h: Harness, label: string, account = 'GITHUB'): Promise<TwoFactorId> =>
  (await keysOf(h, account)).find(key => key.label === label)?.id as TwoFactorId;

describe('a code card is titled by the owner’s 2FA key, never by the ferret', () => {
  it('should title a card "Code sent to ••42 (SMS)" from the matched account’s one code key', async () => {
    const h = harness();
    await github(h);
    await h.directory.accounts.addFactor('GITHUB', { kind: 'sms', label: 'Phone', endsWith: '42' });
    await raised(h);
    should(h.cards[0]?.title).equal('Code sent to ••42 (SMS)');
  });

  it('should list every code key, and name only the one the ferret’s factor picks', async () => {
    const h = harness();
    await github(h);
    await h.directory.accounts.addFactor('GITHUB', { kind: 'sms', label: 'Phone', endsWith: '42' });
    await h.directory.accounts.addFactor('GITHUB', { kind: 'totp', label: 'Authenticator app' });
    await raised(h);
    should(h.cards[0]?.title).equal('One-time code: SMS ••42 or Authenticator app');

    const sms = await keyId(h, 'Phone');
    await h.service.cancel(SESSION, (await h.service.list(HOST))[0]?.id as string, HOST);
    await raised(h, { ...PAGE_CODE, factor: sms });
    should(h.cards[1]?.title).equal('Code sent to ••42 (SMS)');
  });

  it('should ignore a factor of an account that does not sign in here, saying nothing about it', async () => {
    const h = harness();
    await github(h);
    await h.directory.accounts.addFactor('GITHUB', { kind: 'sms', label: 'Phone', endsWith: '42' });
    await h.directory.put('GITLAB', PutLoginEntryRequestSchema.parse({ label: 'GitLab', match: ['gitlab.com'] }));
    await h.directory.accounts.addFactor('GITLAB', { kind: 'email', label: 'Work mail', to: 'k@corp.example' });
    const other = await keyId(h, 'Work mail', 'GITLAB');

    const { view } = await raised(h, { ...PAGE_CODE, factor: other });

    should(h.cards[0]?.title).equal('Code sent to ••42 (SMS)');
    should(JSON.stringify(view)).not.containEql('k@corp.example');
  });

  it('should read the same whether Ferretry holds the TOTP key’s seed or the owner does', async () => {
    const held = harness();
    await github(held);
    await plantSeed(held.directory.accounts, 'GITHUB', SEED_A, 'Authenticator app');
    await raised(held);
    const own = harness();
    await github(own);
    await own.directory.accounts.addFactor('GITHUB', { kind: 'totp', label: 'Authenticator app' });
    await raised(own);
    should(held.cards[0]?.title).equal('Code from Authenticator app');
    should(own.cards[0]).deepEqual(held.cards[0]);
  });

  it('should title a card with no code key by the place, never the account’s label or username', async () => {
    // The title is agenda text, which every ferret reads (secrev-1261 L4): the app names the account itself.
    const h = harness();
    await github(h);
    await h.directory.accounts.addFactor('GITHUB', { kind: 'push', label: 'GitHub Mobile' });
    await raised(h);
    should(h.cards[0]?.title).equal('One-time code for github.com');
    should(JSON.stringify(h.cards[0])).not.containEql('kirinnee');
  });

  it('should keep the plain title where no sign-in matches, and cut a long one to what a card holds', async () => {
    const h = harness({ facts: page('https://example.org') });
    await raised(h);
    should(h.cards[0]?.title).equal('Needs a code');

    const long = harness();
    await github(long);
    await long.directory.accounts.addFactor('GITHUB', { kind: 'totp', label: 'A'.repeat(60) });
    await raised(long);
    should(long.cards[0]?.title.length).equal(60);
    should(long.cards[0]?.title.endsWith('…')).be.true();
  });
});

describe('"Use code from Ferretry": one button per seeded key of the MATCHED account', () => {
  it('should offer each seeded key by its label, a key that worked first, and no key Ferretry holds no seed for', async () => {
    // Arrange
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_B, 'Authy backup');
    await h.directory.accounts.addFactor('GITHUB', { kind: 'sms', label: 'Phone', endsWith: '42' });
    await h.directory.accounts.checkedByUse('GITHUB', await keyId(h, 'Authy backup'), true);

    // Act
    const { request } = await raised(h);

    // Assert
    const [offer] = request.saved?.offers ?? [];
    should(request.saved?.offers.length).equal(1);
    should(offer).containDeep({ id: 'GITHUB', fills: 'totp', matched: true });
    should(offer?.codes?.map(code => [code.label, code.checked])).deepEqual([
      ['Authy backup', 'worked'],
      ['Authy', undefined],
    ]);
  });

  it('should type the code of the key the owner tapped, made inside the daemon', async () => {
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_B, 'Authy backup');
    const backup = await keyId(h, 'Authy backup');
    const { request } = await raised(h);

    await h.service.deliver(
      SESSION,
      request.id,
      useCode(request.observedDigest as string, 'GITHUB', { factor: backup }),
      HOST,
    );

    should(h.writes).deepEqual([codeOf(SEED_B)]);
    should(h.fills).deepEqual([`GITHUB:totp:${backup}`]);
  });

  it('should use the first button’s key when the tap names none', async () => {
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_B, 'Authy backup');
    await h.directory.accounts.checkedByUse('GITHUB', await keyId(h, 'Authy'), false);
    const { request } = await raised(h);

    await h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST);

    should(h.writes).deepEqual([codeOf(SEED_B)]);
  });

  it('should refuse, typing nothing, a key that is another account’s, holds no seed, or is not a key at all', async () => {
    // Arrange
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    await h.directory.accounts.addFactor('GITHUB', { kind: 'sms', label: 'Phone', endsWith: '42' });
    await h.directory.accounts.addFactor('GITHUB', { kind: 'totp', label: 'My phone app' });
    await h.directory.put('GITLAB', PutLoginEntryRequestSchema.parse({ label: 'GitLab', match: ['gitlab.com'] }));
    await plantSeed(h.directory.accounts, 'GITLAB', SEED_B, 'GitLab app');
    const { request } = await raised(h);
    const digest = request.observedDigest as string;

    // Act + Assert
    for (const factor of [
      await keyId(h, 'GitLab app', 'GITLAB'),
      await keyId(h, 'Phone'),
      await keyId(h, 'My phone app'),
      'tf_000000000000' as TwoFactorId,
    ]) {
      const refused = await refusal(
        h.service.deliver(SESSION, request.id, useCode(digest, 'GITHUB', { factor }), HOST),
      );
      should(refused.code).equal('bad_request');
    }
    should(h.writes).deepEqual([]);
    should(h.fills).deepEqual([]);
  });

  it('should never hand-pick a code: an account that does not sign in here is not offered, and its tap is refused', async () => {
    const h = harness();
    await github(h);
    await h.directory.put('GITLAB', PutLoginEntryRequestSchema.parse({ label: 'GitLab', match: ['gitlab.com'] }));
    await plantSeed(h.directory.accounts, 'GITLAB', SEED_B, 'GitLab app');
    const { request } = await raised(h);
    should(request.saved?.offers).deepEqual([]);

    const factor = await keyId(h, 'GitLab app', 'GITLAB');
    const refused = await refusal(
      h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITLAB', { factor }), HOST),
    );

    should(refused.code).equal('bad_request');
    should(h.writes).deepEqual([]);
  });

  it('should offer and type no code on a look-alike origin, a subdomain, another program or another ssh host', async () => {
    for (const facts of [
      page('https://github.com.evil.example'),
      page('https://gist.github.com'),
      page('https://github.com:8443'),
      { ...otpPrompt('evil-bastion') },
      { ...otpPrompt(), program: 'mosh' } as InputTargetFacts,
    ]) {
      const h = harness({ facts, codeProgram: true });
      await github(h, ['github.com', 'ssh@bastion']);
      await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
      const { request } = await raised(h, facts.kind === 'browser' ? PAGE_CODE : TERMINAL_CODE);
      should(request.saved?.offers).deepEqual([]);
      const refused = await refusal(
        h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST),
      );
      should(refused.code).equal('bad_request');
      should(h.writes).deepEqual([]);
    }
  });

  it('should type the code at the exact sign-in, on a page and at an ssh prompt', async () => {
    for (const [facts, raise] of [
      [page(), PAGE_CODE],
      [otpPrompt(), TERMINAL_CODE],
    ] as const) {
      const h = harness({ facts, codeProgram: true });
      await github(h, ['github.com', 'ssh@bastion']);
      await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
      const { request } = await raised(h, raise);
      should(request.saved?.offers.map(offer => offer.codes?.length)).deepEqual([1]);
      await h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST);
      should(h.writes).deepEqual([codeOf(SEED_A)]);
    }
  });

  it('should offer and type no code on http, into a covered or unseen field, or into a frame from another site', async () => {
    for (const facts of [
      page('https://github.com', {}, false),
      page('https://github.com', { covered: true }),
      page('https://github.com', { visible: false }),
      page('https://github.com', { frameOrigin: 'https://ads.example' }),
    ]) {
      const h = harness({ facts });
      await github(h);
      await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
      const { request } = await raised(h);
      should(request.saved?.offers).deepEqual([]);
      const refused = await refusal(
        h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST),
      );
      should(refused.code).equal('bad_request');
      should(h.writes).deepEqual([]);
      should(h.fills).deepEqual([]);
    }
  });

  it('should never type a code it made into a field that turned out to be a password: it is a secret now', async () => {
    // Arrange — a code prompt read by a proved code program at the raise; at Send, nothing proves it any more.
    const h = harness({ facts: otpPrompt(), codeProgram: true });
    await github(h, ['ssh@bastion']);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h, TERMINAL_CODE);
    should(request.fields[0]?.sensitivity).equal('code');
    h.setCodeProgram(false);

    // Act
    const refused = await refusal(
      h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST),
    );

    // Assert — nothing opened, nothing typed; the card now asks for a secret and offers no code.
    should(refused.code).equal('bad_request');
    should(refused.message).containEql('password');
    should(h.writes).deepEqual([]);
    should(h.fills).deepEqual([]);
    const now = (await h.service.list(HOST))[0];
    should(now?.fields[0]?.sensitivity).equal('secret');
    should(now?.saved?.offers.some(offer => offer.fills === 'totp')).be.false();
  });

  it('should refuse a factor on a card with no code field', async () => {
    const h = harness({ facts: page('https://github.com', { field: { tag: 'input', type: 'password' } }) });
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h, {
      ...PAGE_CODE,
      fields: [{ id: 'code', sensitivity: 'secret', element: { kind: 'ref', ref: 'e3' } }],
    });
    const refused = await refusal(
      h.service.deliver(
        SESSION,
        request.id,
        useCode(request.observedDigest as string, 'GITHUB', { factor: await keyId(h, 'Authy') }),
        HOST,
      ),
    );
    should(refused.code).equal('bad_request');
    should(h.writes).deepEqual([]);
  });

  it('should return the code it made in nothing: not the result, the wait, the audit, the journal or the card', async () => {
    // Arrange
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const factor = await keyId(h, 'Authy');
    const { request, view } = await raised(h);

    // Act
    const result = await h.service.deliver(
      SESSION,
      request.id,
      useCode(request.observedDigest as string, 'GITHUB', { factor }),
      HOST,
    );
    const waited = await h.service.agentView(SESSION, view.id, 0);

    // Assert — the one write holds it; the audit names the key by id.
    const code = codeOf(SEED_A);
    should(h.writes).deepEqual([code]);
    for (const out of [JSON.stringify(result), JSON.stringify(waited), await h.everything()]) {
      should(out).not.containEql(code);
      should(out).not.containEql(SEED_A);
    }
    const delivered = h.sinks.map(line => line).find(line => line.includes('"input.delivered"'));
    should(delivered).containEql(`"factor":"${factor}"`);
  });
});

describe('checked by use: a code Ferretry made that did not go through opens the card again', () => {
  it('should open the request again on a new card for a typed code, and the ferret may wait on either', async () => {
    // Arrange
    const h = harness({ verdict: false });
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request, view } = await raised(h);

    // Act
    await h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST);
    await settled();

    // Assert — one check, about the key used; a new card that says so; the old id still waits.
    should(h.checks.map(check => check.factor)).deepEqual([await keyId(h, 'Authy')]);
    should(h.cards.length).equal(2);
    should(h.cards[1]?.ask).startWith("The saved key's code didn't go through: type the code.");
    should(h.cards[1]?.title).equal(h.cards[0]?.title);
    const [open] = await h.service.list(HOST);
    should(open).containDeep({ id: request.id, state: 'pending', agendaItemId: 'A2' });
    should((await h.service.agentView(SESSION, view.id, 0)).state).equal('pending');
    should(h.sinks.some(line => line.includes('did not go through') && line.includes('A2'))).be.true();

    // The owner types it on the new card.
    await h.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: open?.observedDigest as string,
        padded: padInputValue('481516'),
        submit: true,
      },
      HOST,
    );
    should(h.writes).deepEqual([codeOf(SEED_A), '481516']);
    should(h.checks.length).equal(1);
  });

  it('should open nothing again for a code that went through, one it could not judge, or one never submitted', async () => {
    for (const [verdict, submit] of [
      [true, true],
      [undefined, true],
      [false, false],
    ] as const) {
      const h = harness({ verdict });
      await github(h);
      await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
      const { request } = await raised(h);
      await h.service.deliver(
        SESSION,
        request.id,
        useCode(request.observedDigest as string, 'GITHUB', { submit }),
        HOST,
      );
      await settled();
      should(h.cards.length).equal(1);
      should(await h.service.list(HOST)).deepEqual([]);
      should(h.checks.length).equal(submit ? 1 : 0);
    }
  });

  it('should check nothing for a code the owner typed', async () => {
    const h = harness({ verdict: false });
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h);
    await h.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest as string,
        padded: padInputValue('481516'),
        submit: true,
      },
      HOST,
    );
    await settled();
    should(h.checks).deepEqual([]);
  });

  it('should keep the verdict on the key, and only on a key with a seed', async () => {
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    await h.directory.accounts.addFactor('GITHUB', { kind: 'sms', label: 'Phone', endsWith: '42' });
    await h.directory.accounts.checkedByUse('GITHUB', await keyId(h, 'Authy'), false);
    await h.directory.accounts.checkedByUse('GITHUB', await keyId(h, 'Phone'), true);
    await h.directory.accounts.checkedByUse('GITLAB', await keyId(h, 'Authy'), true);
    const keys = await keysOf(h);
    should(keys.find(key => key.label === 'Authy')).containDeep({ verified: { worked: false } });
    should(keys.find(key => key.label === 'Phone')).not.have.property('verified');
  });
});

describe('use it now: the code of a key just saved from this card', () => {
  it('should type the new key’s code into the open card the owner saw, as the owner who saved it', async () => {
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h);

    const typed = await h.service.useNow(request.id, {
      account: 'GITHUB',
      factor: await keyId(h, 'Authy'),
      observedDigest: request.observedDigest as string,
      actor: { kind: 'device', deviceId: 'phone' },
    });

    should(typed).be.true();
    should(h.writes).deepEqual([codeOf(SEED_A)]);
    should(h.sinks.find(line => line.includes('"input.delivered"'))).containEql('"deviceId":"phone"');
  });

  it('should type nothing for a card that is not all codes, one that is closed, or under a refused check', async () => {
    const h = harness({ facts: page('https://github.com', {}, false) });
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const factor = await keyId(h, 'Authy');
    const { request } = await raised(h);
    const use = {
      account: 'GITHUB',
      factor,
      observedDigest: request.observedDigest as string,
      actor: { kind: 'host' },
    } as const;
    should(await h.service.useNow(request.id, use)).be.false();
    should(await h.service.useNow('f'.repeat(32), use)).be.false();
    h.setFacts(page('https://github.com', { field: { tag: 'input', type: 'password' } }));
    await h.service.cancel(SESSION, request.id, HOST);
    const secret = await raised(h, {
      ...PAGE_CODE,
      fields: [{ id: 'code', sensitivity: 'secret', element: { kind: 'ref', ref: 'e3' } }],
    });
    should(await h.service.useNow(secret.request.id, use)).be.false();
    should(h.writes).deepEqual([]);
  });

  it('should type nothing into a card redrawn since the owner staged the key, as a tap on it would', async () => {
    // Arrange — the owner stages from the card as drawn; the page then loads a new document of the same site.
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h);
    const seen = h.service.cardTarget(request.id)?.observedDigest as string;
    h.setFacts({ ...page(), navigationId: 'loader-2' });
    // A Send on the card as it was finds the page moved: the card is redrawn, nothing typed.
    await refusal(h.service.deliver(SESSION, request.id, useCode(seen, 'GITHUB'), HOST));
    should(h.writes).deepEqual([]);

    // Act
    const typed = await h.service.useNow(request.id, {
      account: 'GITHUB',
      factor: await keyId(h, 'Authy'),
      observedDigest: seen,
      actor: { kind: 'device', deviceId: 'phone' },
    });

    // Assert
    should(typed).be.false();
    should(h.writes).deepEqual([]);
    should((await h.service.list(HOST))[0]?.observedDigest).not.equal(seen);
  });
});

describe('a page that moves between the card and the Send', () => {
  it('should type no code it made: the card is redrawn onto the new document and the owner checks it again', async () => {
    // Arrange
    const h = harness();
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h);
    h.setFacts({ ...page(), navigationId: 'loader-2' });

    // Act
    const refused = await refusal(
      h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST),
    );

    // Assert — nothing opened or typed; the redrawn card says it is a new document.
    should(refused.code).equal('conflict');
    should(h.writes).deepEqual([]);
    should(h.fills).deepEqual([]);
    const [redrawn] = await h.service.list(HOST);
    should(redrawn?.observedDigest).not.equal(request.observedDigest);
    should(redrawn?.fields[0]?.risk?.reason).containEql('new document');
  });
});

describe('use it now, wired as the daemon wires it', () => {
  it('should type the first code of a seed a paired device saved from the card, through the real stages and service', async () => {
    // Arrange — the REAL seed stages over the REAL account store, handed the input service the way fyd.ts does.
    const h = harness();
    await github(h);
    let cards: InputRequestService | undefined;
    const stages = new TwoFactorSeedStages({
      accounts: h.directory.accounts,
      cipher: new FakeSecretCipher(),
      clock: { nowMs: () => NOW },
      anyPasskey: async () => true,
      hostName: 'kirin-box',
      cards: lateSeedCards(() => cards),
    });
    const { request } = await raised(h);
    cards = h.service;
    const device = { key: 'device:phone', device: true } as const;
    const staged = await stages.stage(
      'GITHUB',
      { padded: padInputValue(SEED_B), totpAcknowledged: true, request: request.id },
      device,
    );

    // Act
    const saved = await stages.commit('GITHUB', staged.stage, () => true, { kind: 'device', deviceId: 'phone' });

    // Assert — the new key's code, typed once into the card; the answer says so and holds no code.
    should(saved.typed).be.true();
    should(h.writes).deepEqual([codeOf(SEED_B)]);
    should(JSON.stringify(saved)).not.containEql(codeOf(SEED_B));
    should(await h.service.list(HOST)).deepEqual([]);
  });

  it('should type nothing before the input service exists', async () => {
    const port = lateSeedCards(() => undefined);
    should(port.cardTarget('a'.repeat(32))).be.undefined();
    should(
      await port.useNow?.('a'.repeat(32), {
        account: 'GITHUB',
        factor: 'tf_0123456789ab' as TwoFactorId,
        observedDigest: 'x',
        actor: { kind: 'host' },
      }),
    ).be.false();
  });
});

describe('a request opened again is on its new card only', () => {
  it('should not cancel it when the card it was on before is closed, and cancel it from the new one', async () => {
    const h = harness({ verdict: false });
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h);
    await h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST);
    await settled();

    await h.service.cardDismissed(SESSION, 'A1' as AgendaId);
    should((await h.service.list(HOST)).map(open => open.agendaItemId)).deepEqual(['A2']);
    await h.service.cardDismissed(SESSION, 'A2' as AgendaId);
    should(await h.service.list(HOST)).deepEqual([]);
  });
});

describe('opening a request again, at its edges', () => {
  it('should open a terminal’s code card again, and picture a page’s new card again', async () => {
    const term = harness({ facts: otpPrompt(), codeProgram: true, verdict: false });
    await github(term, ['ssh@bastion']);
    await plantSeed(term.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const t = await raised(term, TERMINAL_CODE);
    await term.service.deliver(SESSION, t.request.id, useCode(t.request.observedDigest as string, 'GITHUB'), HOST);
    await settled();
    should((await term.service.list(HOST)).map(open => [open.agendaItemId, open.pictured])).deepEqual([
      ['A2', undefined],
    ]);

    const shown = harness({ verdict: false, pictured: true });
    await github(shown);
    await plantSeed(shown.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const p = await raised(shown);
    await shown.service.deliver(SESSION, p.request.id, useCode(p.request.observedDigest as string, 'GITHUB'), HOST);
    await settled();
    const [again] = await shown.service.list(HOST);
    should(again).containDeep({ agendaItemId: 'A2', pictured: true });
    should(shown.service.shot(HOST, SESSION, p.request.id).pngBase64).equal('iVBORw0KGgo=');
  });

  it('should raise nothing when another request already waits on that target, and tell the ferret', async () => {
    const h = harness({
      verdict: false,
      beforeVerdict: async service => {
        await service.raise(SESSION, { ...PAGE_CODE, prompt: 'the ferret asks again' });
      },
    });
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h);
    await h.service.deliver(SESSION, request.id, useCode(request.observedDigest as string, 'GITHUB'), HOST);
    await settled();
    should((await h.service.list(HOST)).map(open => open.prompt)).deepEqual(['the ferret asks again']);
    should(h.cards.length).equal(2);
    should(
      h.sinks.some(line => line.startsWith('A1: ') && line.includes('raise a fresh browser_request_input')),
    ).be.true();
  });

  it('should open nothing again when the check itself fails: the code was typed either way', async () => {
    const h = harness({
      verdict: false,
      beforeVerdict: async () => {
        throw new Error('the page went away');
      },
    });
    await github(h);
    await plantSeed(h.directory.accounts, 'GITHUB', SEED_A, 'Authy');
    const { request } = await raised(h);
    const result = await h.service.deliver(
      SESSION,
      request.id,
      useCode(request.observedDigest as string, 'GITHUB'),
      HOST,
    );
    await settled();
    should(result.state).equal('delivered');
    should(h.cards.length).equal(1);
    should(await h.service.list(HOST)).deepEqual([]);
  });
});
