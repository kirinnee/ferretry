import type { ClearJob, ClearOutcome, InputRaise, InputTargetFacts } from '../../../../contract/index.ts';
import type {
  AccountId,
  AccountKey,
  AccountList,
  CopyMeta,
  LoginFieldRole,
  SignInId,
} from '../../../../daemon/lib/inputs/borrowed.ts';
import {
  type GrantReservation,
  type SignInGrant,
  SignInGrantLedger,
  type SignInGrantSource,
} from '../../../../daemon/lib/inputs/borrowed-grants.ts';
import { EphemeralValues } from '../../../../daemon/lib/inputs/ephemeral-values.ts';
import type {
  InputAuditEntry,
  InputCaller,
  InputCard,
  InputLoginPort,
  InputStoreAuditEntry,
  ObserveResult,
  TypeOptions,
  TypeResult,
} from '../../../../daemon/lib/inputs/ports.ts';
import { QuarantineRegistry } from '../../../../daemon/lib/inputs/quarantine.ts';
import { InputRequestService, type InputRequestServiceDependencies } from '../../../../daemon/lib/inputs/service.ts';
import type { AgendaId, InputDeliverBody, InputEvent, InputRequest } from '../../../../daemon/lib/inputs/wire.ts';
import { account, grant, KEY, NOW, SESSION, SIGN_IN, site, terminal } from './grant-fixtures.ts';

/**
 * THE INPUT REQUEST SERVICE WITH EVERY SEAM A TEST MAY NEED, over fakes that record what crosses them: the page or the
 * terminal it types into, the agenda, the journal, the audit, the secure copies, the paste rules, the grants (over the
 * real ledger), the saved logins and the login observer. One owner, one session, a clock the test moves.
 */

export const OWNER: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
export const AGENT: InputCaller = { kind: 'agent', sessionId: SESSION };

export const PASSWORD = 'hunter2-UNIQUE-pw';
export const USERNAME = 'kirinnee';
export const COPY_VALUE = 'vcp_PASTE-NEVER-LEAKS-41f2';

/** A page login: a username box and a password box, as the ferret raises them. */
export const PAGE_LOGIN: InputRaise = {
  target: { kind: 'page', key: 'app' },
  prompt: 'GitHub login for the deploy console',
  fields: [
    { id: 'user', label: 'Username', sensitivity: 'plain', element: { kind: 'selector', selector: '#login_field' } },
    { id: 'pass', label: 'Password', sensitivity: 'secret', element: { kind: 'selector', selector: '#password' } },
  ],
  submit: 'offer-owner',
};

/** A sudo prompt in a terminal. */
export const SUDO_RAISE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo wants your password',
  sensitivity: 'secret',
  submit: 'owner-default',
};

/** A paste of the secure copy `vercel` into a terminal. */
export const PASTE_RAISE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'the new Vercel token for production',
  sensitivity: 'plain',
  submit: 'owner-default',
  source: { kind: 'sealed', name: 'vercel' },
};

const copyMeta = (over: Partial<CopyMeta> = {}): CopyMeta => ({
  handle: 'sealed:vercel',
  name: 'vercel',
  from: { kind: 'command', program: 'vercel', path: '/usr/bin/vercel' },
  length: COPY_VALUE.length,
  lines: 1,
  capturedAt: '2026-11-01T11:00:00.000Z',
  expiresAt: '2026-11-01T13:00:00.000Z',
  state: 'live',
  exposure: { transcript: 'clean' },
  uses: 0,
  ...over,
});

export interface WorldOptions {
  /** What the target shows; the default is a sudo prompt. A function is asked at every look. */
  readonly facts?: InputTargetFacts | (() => InputTargetFacts);
  readonly observe?: () => ObserveResult;
  readonly accounts?: Pick<AccountList, 'accounts' | 'signIns'>;
  /** The grants the source reports; read at every call, so a test may change them mid-flight. */
  readonly grants?: SignInGrant[];
  readonly grantsEnabled?: boolean;
  /** Whether the ferret ran a page script / acted since (the login observer's `tainted`); never by default. */
  readonly tainted?: boolean;
  readonly history?: readonly InputEvent[];
  readonly sessions?: readonly string[];
  readonly withObserver?: boolean;
  readonly withSealed?: boolean;
  readonly withRules?: boolean;
  readonly withLogins?: boolean;
  readonly clear?: boolean;
}

/** The service and everything it recorded. */
export function world(options: WorldOptions = {}) {
  const clock = { ms: NOW };
  const clockPort = { now: () => clock.ms };
  const values = new EphemeralValues(clockPort);
  const quarantine = new QuarantineRegistry(clockPort);
  const state = {
    facts: options.facts ?? terminalSudo(),
    observe: options.observe,
    typed: 'typed' as TypeResult,
    typedQueue: [] as TypeResult[],
    clearOutcome: 'moved' as ClearOutcome,
    tainted: options.tainted ?? false,
    codeProgram: false,
    listingFails: false,
    fillFails: undefined as Error | undefined,
    fillValue: undefined as ((role: LoginFieldRole) => string) | undefined,
    saveFails: undefined as Error | undefined,
    verify: { ok: true } as { ok: true } | { ok: false; reason?: string },
    holds: true,
    ruleId: undefined as string | undefined,
    journalFails: false,
    agendaFails: false,
    sessionEnded: false,
    /** Runs inside the target's write, before it answers: a line revoked while the write waited its turn. */
    onType: undefined as (() => void) | undefined,
    /** What the observer says of a code Ferretry made: it went through, did not, could not be told, or the look failed. */
    codeWorked: undefined as boolean | undefined | Error,
    /** Held until the test lets go: the observer's look at a code takes as long as the test says. */
    codeGate: undefined as Promise<void> | undefined,
  };
  const writes: { values: string[]; submit: boolean; options: TypeOptions | undefined }[] = [];
  const cleared: ClearJob[] = [];
  const cards: InputCard[] = [];
  const closed: string[] = [];
  const notes: string[] = [];
  const events: InputEvent[] = [];
  const audits: InputAuditEntry[] = [];
  const stores: InputStoreAuditEntry[] = [];
  const told: string[] = [];
  const delivered: unknown[] = [];
  const rebuzzed: string[] = [];
  const codesChecked: unknown[] = [];
  const saves: unknown[] = [];
  const fills: { id: string; role: LoginFieldRole; factor?: string }[] = [];
  const timers: { ms: number; fire: () => void }[] = [];
  const used: { copy: string }[] = [];
  const ruleLog: { reserved: unknown[][]; released: string[]; spent: string[] } = {
    reserved: [],
    released: [],
    spent: [],
  };
  const grantLog: { used: string[]; stopped: { id: string; because: string }[]; reservations: GrantReservation[] } = {
    used: [],
    stopped: [],
    reservations: [],
  };
  const copies = new Map<string, { meta: CopyMeta; value: string }>();
  let card = 1;
  let id = 1;
  const grants = options.grants ?? [];
  const ledger = new SignInGrantLedger();

  const grantSource: SignInGrantSource = {
    enabled: () => options.grantsEnabled ?? true,
    of: () => grants,
    keyOf: async (_accountId: AccountId): Promise<AccountKey | undefined> => KEY,
    ledger,
    used: (each, _at, sessionId) => void grantLog.used.push(`${each.id}@${sessionId}`),
    stopped: async (each, because) => void grantLog.stopped.push({ id: each.id, because }),
    verify: async () => state.verify as never,
    holds: () => state.holds,
    projectOf: async () => 'ferretry',
    scriptedOrigins: () => ({ hosts: new Map() }),
  };

  const logins: InputLoginPort = {
    listing: async () => {
      if (state.listingFails) throw new Error('the store could not be read');
      return options.accounts ?? { accounts: [account()], signIns: [site()] };
    },
    fill: async (entry, role, _now, fillOptions) => {
      fills.push({ id: entry, role, ...(fillOptions?.factor === undefined ? {} : { factor: fillOptions.factor }) });
      if (state.fillFails !== undefined) throw state.fillFails;
      return state.fillValue?.(role) ?? (role === 'username' ? USERNAME : role === 'totp' ? '123456' : PASSWORD);
    },
    save: async (...args) => {
      saves.push(args);
      if (state.saveFails !== undefined) throw state.saveFails;
    },
  };

  const target: InputRequestServiceDependencies['target'] = {
    observe: async () => {
      if (state.observe !== undefined) return state.observe();
      const facts = typeof state.facts === 'function' ? state.facts() : state.facts;
      return {
        ok: true,
        facts,
        names: facts.kind === 'page' ? ['page-1'] : ['dev'],
        ...(state.codeProgram ? { codeProgram: true as const } : {}),
      };
    },
    type: async (_session, _target, typedValues, submit, _expected, typeOptions) => {
      writes.push({ values: typedValues.map(each => each.text), submit, options: typeOptions });
      state.onType?.();
      if (typeOptions?.armClear === 'try') typeOptions.armed?.(true);
      return state.typedQueue.shift() ?? state.typed;
    },
    ...(options.clear === false
      ? {}
      : {
          clear: async (_session: string, _target: unknown, job: ClearJob) => {
            cleared.push(job);
            return state.clearOutcome;
          },
        }),
  };

  const service = new InputRequestService({
    target,
    agenda: {
      raise: async (_session, raised) => {
        if (state.agendaFails) return { ok: false, message: 'the agenda is full' };
        cards.push(raised);
        return { ok: true, id: `A${card++}` as AgendaId };
      },
      close: async (_session, closedId, note) => void closed.push(`${closedId}: ${note}`),
      promptOf: async () => 'GitHub login for the deploy console',
      note: async (_session, _id, _card, line) => void notes.push(line),
    },
    notifier: { tell: async (_session, _agenda, message) => void told.push(message) },
    journal: {
      publish: async (_session, event) => {
        if (state.journalFails) throw new Error('the journal is not writable');
        events.push(event);
      },
      history: async () => options.history ?? [],
      quarantine: async () => undefined,
      quarantines: async () => [],
    },
    audit: {
      record: async entry => void audits.push(entry),
      saved: async () => undefined,
      stored: async entry => void stores.push(entry),
    },
    clock: clockPort,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: {
      after: async ms =>
        await new Promise<void>(resolve => {
          timers.push({ ms, fire: resolve });
        }),
    },
    sessions: {
      ended: async candidate => state.sessionEnded || !(options.sessions ?? [SESSION]).includes(candidate),
      all: async () => options.sessions ?? [SESSION],
    },
    values,
    quarantine,
    redact: async text => values.scrubAll(text),
    hostName: 'kirin-box',
    ...((options.withLogins ?? true) ? { logins } : {}),
    ...(options.grants === undefined ? {} : { grants: grantSource }),
    ...(options.withSealed === true
      ? {
          sealed: {
            describe: (_session: string, name: string) => copies.get(name)?.meta,
            open: (_session: string, name: string) => copies.get(name)?.value,
            used: (_session: string, name: string) => void used.push({ copy: name }),
          },
        }
      : {}),
    ...(options.withRules === true
      ? {
          rules: {
            reserve: (...args: unknown[]) => {
              ruleLog.reserved.push(args);
              return state.ruleId;
            },
            release: (ruleId: string) => void ruleLog.released.push(ruleId),
            spent: (ruleId: string) => void ruleLog.spent.push(ruleId),
          },
        }
      : {}),
    ...(options.withObserver === false
      ? {}
      : {
          observer: {
            delivered: async (delivery: unknown) => void delivered.push(delivery),
            tainted: () => state.tainted,
            codeTyped: async (typed: unknown) => {
              codesChecked.push(typed);
              await state.codeGate;
              if (state.codeWorked instanceof Error) throw state.codeWorked;
              return state.codeWorked;
            },
          },
        }),
    rebuzz: async sessionId => void rebuzzed.push(sessionId),
  });

  const pending = async (): Promise<InputRequest> => {
    const [request] = await service.list(OWNER, SESSION);
    if (request === undefined) throw new Error('no pending request');
    return request;
  };
  const send = (request: InputRequest, over: Partial<InputDeliverBody> = {}): InputDeliverBody => ({
    deliveryId: crypto.randomUUID(),
    observedDigest: request.observedDigest ?? '',
    submit: true,
    ...over,
  });

  return {
    service,
    state,
    clock,
    writes,
    cleared,
    cards,
    closed,
    notes,
    events,
    audits,
    stores,
    told,
    delivered,
    rebuzzed,
    codesChecked,
    saves,
    fills,
    timers,
    used,
    ruleLog,
    grantLog,
    copies,
    ledger,
    grantSource,
    values,
    quarantine,
    pending,
    send,
    /** Live copy `vercel` in the session. */
    copy: (over: Partial<CopyMeta> = {}, value = COPY_VALUE) => {
      const meta = copyMeta(over);
      copies.set(meta.name, { meta, value });
      return meta;
    },
  };
}

const terminalSudo = (): InputTargetFacts => terminal();

/** A sign-in grant for the page login above: a plan line in force that covers username and password. */
export const planLine = (over: Partial<SignInGrant> = {}): SignInGrant =>
  grant({ signIn: SIGN_IN as SignInId, ...over });

/** The refusal an operation threw, or a failure. */
export async function refusal(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error === undefined) throw new Error('expected a refusal');
  return error as Error & { code?: string };
}
