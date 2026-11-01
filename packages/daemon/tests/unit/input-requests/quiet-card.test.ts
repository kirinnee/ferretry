import { describe, it } from 'bun:test';
import type { AccountId, AccountKey, AgendaItem, InputRaise, InputTargetFacts, SignInId } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../src/lib/agenda/index.ts';
import {
  EphemeralValues,
  InputAgendaAdapter,
  InputRequestService,
  type InputLoginPort,
  PasteRuleService,
  QuarantineRegistry,
  SecureCopyService,
} from '../../../src/lib/index.ts';
import { AgendaBuzz, type BuzzSink } from '../../../src/lib/notifications/buzz.ts';
import { SignInGrantLedger } from '../../../src/lib/sign-in-grants/ledger.ts';
import { NO_SCRIPTED_ORIGINS, type SignInGrant } from '../../../src/lib/sign-in-grants/matcher.ts';
import type { SignInGrantSource } from '../../../src/lib/sign-in-grants/plans.ts';
import { FACTS, SESSION } from './support.ts';

/**
 * R3a-4, THE QUIET CARD, through the REAL agenda and the REAL buzz: a card filled in advance (under a task-plan line or
 * a paste rule) is raised and closed at once, and must not buzz the owner's phone. An input card's deadline push fires
 * the moment it is raised, so before this fix every rule paste buzzed. A card that is NOT filled after all pushes once,
 * as any input card does.
 */

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const TOKEN = 'vcp_QUIET-NEVER-LEAKS-77';
const PASSWORD = 'correct-horse-battery-staple';

class Boards implements AgendaLedgerRepository {
  ledger: AgendaLedger | null = null;
  async read(): Promise<AgendaLedger | null> {
    return this.ledger;
  }
  async transact(_sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok && mutation.changed) this.ledger = mutation.ledger;
    return mutation;
  }
}

class Sink implements BuzzSink {
  readonly deadlines: string[] = [];
  readonly stops: string[] = [];
  async stopped(_session: string, at: string): Promise<void> {
    this.stops.push(at);
  }
  async deadline(_session: string, item: AgendaItem): Promise<void> {
    this.deadlines.push(item.id);
  }
  async raised(): Promise<void> {}
  async woke(): Promise<void> {}
}

/** The input service on a real board, whose raises and edits reach the real buzz as the daemon wires it. */
function board() {
  const boards = new Boards();
  const sink = new Sink();
  let service: InputRequestService | undefined;
  const buzz = new AgendaBuzz(
    boards,
    { current: async () => undefined },
    sink,
    { now: () => new Date(NOW).toISOString() },
    3,
    // Asked only when the service has it, so on a daemon without quiet cards this proves the push, not a thrown call.
    (sessionId, requestId) =>
      typeof service?.quietCard === 'function' ? service.quietCard(sessionId, requestId) : false,
  );
  const agenda = new AgendaService(
    boards,
    { now: () => new Date(NOW).toISOString() },
    { has: async () => true },
    buzz,
    buzz,
  );
  return {
    boards,
    sink,
    agenda: new InputAgendaAdapter(agenda),
    bind: (next: InputRequestService) => {
      service = next;
    },
    open: (): readonly AgendaItem[] =>
      (boards.ledger?.entries ?? []).filter(entry => entry.lifecycle === 'active').map(entry => entry.item),
  };
}

const common = (clock: { now(): number }, values: EphemeralValues) => ({
  notifier: { tell: async () => undefined },
  journal: {
    publish: async () => undefined,
    history: async () => [],
    quarantine: async () => undefined,
    quarantines: async () => [],
  },
  audit: { record: async () => undefined, saved: async () => undefined, stored: async () => undefined },
  clock,
  ids: { requestId: () => crypto.randomUUID().replaceAll('-', '') },
  timers: { after: async () => await new Promise<void>(() => undefined) },
  sessions: { ended: async (candidate: string) => candidate !== SESSION, all: async () => [SESSION] },
  values,
  quarantine: new QuarantineRegistry(clock),
  redact: async (text: string) => values.scrubAll(text),
});

describe('a paste a rule fills is raised quiet', () => {
  const VERCEL: InputTargetFacts = {
    ...FACTS,
    foreground: { pid: 5100, pgid: 5100, comm: 'vercel', argv: 'vercel env add TOKEN production' },
    program: 'vercel',
    promptLine: '? What’s the value of TOKEN?',
    recognisedConsumer: false,
  };
  const PASTE: InputRaise = {
    target: { kind: 'terminal', key: 'dev' },
    prompt: 'the new Vercel token for production',
    sensitivity: 'plain',
    submit: 'owner-default',
    source: { kind: 'sealed', name: 'vercel' },
  };

  async function world(written: 'typed' | 'target_changed' = 'typed') {
    const clock = { now: () => NOW };
    const values = new EphemeralValues(clock);
    const b = board();
    const copies = new SecureCopyService({
      clock,
      runner: {
        run: async () => ({
          outcome: 'exited',
          exitCode: 0,
          stdout: `${TOKEN}\n`,
          stderr: '',
          truncated: false,
          program: '/usr/bin/vercel',
        }),
      },
      folders: { folderOf: async () => '/work' },
      exposure: { transcriptHolds: async () => 'clean' },
      masking: values,
      redact: async text => text,
    });
    const rules = new PasteRuleService({
      store: { read: async () => undefined, write: async () => undefined },
      clock,
      ids: { ruleId: () => 'f'.repeat(32) },
      warn: () => undefined,
    });
    await rules.load();
    await rules.create(
      { kind: 'owner', actor: { kind: 'host' } },
      { from: { kind: 'command', program: 'vercel' }, to: { kind: 'terminal', program: 'vercel' }, count: 2 },
    );
    await copies.capture(SESSION, {
      name: 'vercel',
      source: { kind: 'command', argv: ['vercel', 'tokens', 'create'] },
    });
    const service = new InputRequestService({
      ...common(clock, values),
      target: { observe: async () => ({ ok: true, facts: VERCEL }), type: async () => written },
      agenda: b.agenda,
      sealed: copies,
      rules,
    });
    b.bind(service);
    return { ...b, service };
  }

  it('should not buzz the phone for a paste the rule fills at once', async () => {
    const w = await world();
    const view = await w.service.raise(SESSION, PASTE);
    should(view.state).equal('delivered');
    should(w.sink.deadlines).deepEqual([]);
  });

  it('should buzz once when the rule did not fill it after all, and the card is the owner’s', async () => {
    const w = await world('target_changed');
    const view = await w.service.raise(SESSION, PASTE).catch(() => undefined);
    should(view?.state ?? 'pending').equal('pending');
    should(w.open()).have.length(1);
    should(w.sink.deadlines).have.length(1);
  });
});

let grantWorld: (
  facts: InputTargetFacts,
  source?: Partial<SignInGrantSource>,
  pins?: Partial<SignInGrant>,
) => ReturnType<typeof board> & { service: InputRequestService; writes: string[] };

describe('a sign-in a task-plan line fills is raised quiet', () => {
  const KEY = `L${'c'.repeat(31)}` as AccountKey;
  const SIGN_IN = 'si_0123456789abcdef01234567' as SignInId;
  const AT = '2026-10-01T00:00:00.000Z';
  const SUDO: InputRaise = {
    target: { kind: 'terminal', key: 'dev' },
    prompt: 'sudo wants your password',
    sensitivity: 'secret',
    submit: 'owner-default',
  };

  function world(facts: InputTargetFacts, source: Partial<SignInGrantSource> = {}, pins: Partial<SignInGrant> = {}) {
    const writes: string[] = [];
    const clock = { now: () => NOW };
    const values = new EphemeralValues(clock);
    const b = board();
    const logins: InputLoginPort = {
      listing: async () => ({
        accounts: [
          {
            id: 'KIRIN' as AccountId,
            label: 'Kirin',
            fields: { password: true, totp: false },
            factors: [],
            signIns: [SIGN_IN],
            createdAt: AT,
            updatedAt: AT,
          },
        ],
        signIns: [
          {
            id: SIGN_IN,
            account: 'KIRIN' as AccountId,
            place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
            method: { kind: 'password' },
            createdAt: AT,
            updatedAt: AT,
          },
        ],
      }),
      fill: async () => PASSWORD,
      save: async () => undefined,
    };
    const grant: SignInGrant = {
      id: `plan:${'ab'.repeat(16)}:0`,
      source: 'plan',
      plan: { id: 'ab'.repeat(16), line: 0 },
      sessionId: SESSION,
      surface: 'terminal',
      signIn: SIGN_IN,
      accountKey: KEY,
      fields: new Set(['password']),
      pins: { placeKeys: ['sudo@kirin-box'], recipeVersion: undefined, identities: undefined },
      expiresAt: NOW + 3_600_000,
      state: 'in-force',
      remaining: 1,
      ...pins,
    };
    const grants: SignInGrantSource = {
      enabled: () => true,
      of: () => [grant],
      keyOf: async () => KEY,
      ledger: new SignInGrantLedger(),
      used: () => undefined,
      stopped: async () => undefined,
      verify: async () => ({ ok: true }),
      holds: () => true,
      projectOf: async () => undefined,
      scriptedOrigins: () => NO_SCRIPTED_ORIGINS,
      ...source,
    };
    const service = new InputRequestService({
      ...common(clock, values),
      target: {
        observe: async () => ({ ok: true, facts }),
        type: async (_session, _target, typed) => {
          writes.push(...typed.map(value => value.text));
          return 'typed';
        },
      },
      agenda: b.agenda,
      logins,
      grants,
      hostName: 'kirin-box',
      observer: { delivered: async () => undefined, tainted: () => false },
    });
    b.bind(service);
    return { ...b, service, writes };
  }
  grantWorld = world;

  it('should not buzz the phone for a sign-in the line fills at once', async () => {
    const w = world({ ...FACTS, trustedProgram: true });
    const view = await w.service.raise(SESSION, SUDO);
    should(view.state).equal('delivered');
    should(w.sink.deadlines).deepEqual([]);
  });

  it('should buzz exactly once when the line did not apply, and say so on the card in words that never give the reason', async () => {
    // Not running setuid root: `not-system`, which the ferret must never learn.
    const w = world(FACTS);
    const view = await w.service.raise(SESSION, SUDO);
    should(view.state).equal('pending');
    should(w.sink.deadlines).have.length(1);
    const [card] = w.open();
    should(card?.context).startWith("A task plan line didn't apply here, so you're asked as usual.");
    should(card?.context).endWith('The agent says: sudo wants your password');
    should(JSON.stringify(card)).not.containEql('not-system');
    should(JSON.stringify(card)).not.containEql('setuid');
  });
});

describe('a sign-in fill that cannot even be tried is the usual card', () => {
  const KEY = `L${'c'.repeat(31)}` as AccountKey;
  const SUDO: InputRaise = {
    target: { kind: 'terminal', key: 'dev' },
    prompt: 'sudo wants your password',
    sensitivity: 'secret',
    submit: 'owner-default',
  };
  // The grant world above, reused through its own describe: the same account, sign-in and grant.
  const sudo = { ...FACTS, trustedProgram: true as const };

  it('should type nothing and hand the card back when the account keys cannot be read', async () => {
    const w = grantWorld(sudo, {
      keyOf: async () => {
        throw new Error('the account store fell over');
      },
    });
    const view = await w.service.raise(SESSION, SUDO);
    should(w.writes).deepEqual([]);
    should(view.state).equal('pending');
    should(w.sink.deadlines).have.length(1);
    should(w.open()[0]?.context).startWith("A task plan line didn't apply here, so you're asked as usual.");
  });

  it('should type nothing and hand the card back when stopping a changed line fails', async () => {
    // The recipe moved since approval (`recipe-changed` stops the line), and recording the stop throws.
    const w = grantWorld(
      sudo,
      {
        stopped: async () => {
          throw new Error('the plan service fell over');
        },
      },
      { pins: { placeKeys: ['sudo@kirin-box'], recipeVersion: 3, identities: undefined }, accountKey: KEY },
    );
    const view = await w.service.raise(SESSION, SUDO);
    should(w.writes).deepEqual([]);
    should(view.state).equal('pending');
    const listed = await w.service.list({ kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' });
    should(listed[0]?.preapproval).match({ outcome: 'did-not-apply' });
    should(w.sink.deadlines).have.length(1);
  });
});
