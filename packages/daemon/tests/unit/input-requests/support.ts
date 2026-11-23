import type {
  AgendaId,
  InputEvent,
  InputQuarantineEvent,
  InputRaise,
  InputShot,
  InputTargetFacts,
} from '@ferretry/protocol';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import type { InputAgendaPort, InputLoginPort } from '../../../src/lib/input-requests/ports.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService, type InputRequestServiceDependencies } from '../../../src/lib/input-requests/service.ts';
import type { ScriptedOriginsView } from '../../../src/lib/sign-in-grants/matcher.ts';
import type { SignInGrantSource } from '../../../src/lib/sign-in-grants/plans.ts';

export const SESSION = 'mvv6b4qw-49d0158d';

export const FACTS: Extract<InputTargetFacts, { readonly kind: 'terminal' }> = {
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
};

export const RAISE: InputRaise = {
  target: { kind: 'terminal', key: 'dev' },
  prompt: 'sudo wants your password',
  sensitivity: 'secret',
  submit: 'owner-default',
};

/** The real service over a terminal that always shows `FACTS`, a board that takes every card and an empty journal. */
export function inputRequestService(
  options: {
    readonly crash?: () => boolean;
    /** What the terminal shows; the default is a sudo prompt. A function is asked at every look. */
    readonly facts?: InputTargetFacts | (() => InputTargetFacts);
    /** Every other way the terminal is known besides its key. */
    readonly names?: readonly string[];
    /** The one live session; the default is {@link SESSION}. */
    readonly session?: string;
    /** The picture a page target answers with; none by default. */
    readonly shot?: InputShot;
    /** The dummy probe a page target answers with (lock.ts); absent: the target cannot probe. */
    readonly probe?: (fieldIds: readonly string[]) => Promise<'hidden' | 'shown' | 'aborted'>;
    /** Saved logins, for the facts the lock may read; none by default. */
    readonly logins?: InputLoginPort;
    /** Whether the ferret steered a page (the login observer); absent: no observer, so every page counts as steered. */
    readonly steered?: (since: number) => boolean;
    /** A whole login observer (the real one, say), in place of `steered`. */
    readonly observer?: InputRequestServiceDependencies['observer'];
    /** Where page scripts ran across the machine, as the standing rules keep it; with no grant that ever fills. */
    readonly scriptedOrigins?: () => ScriptedOriginsView;
    /** The agenda the cards are raised on; absent: a board that takes every card and says nothing. */
    readonly agenda?: InputAgendaPort;
    /** Whether the page target arms a pagehide clear it is asked to try (`armClear: 'try'`); absent: it never can. */
    readonly arms?: boolean;
    /** Called each time the journal is written (a request or a hold), before it answers. */
    readonly journalled?: (event: unknown) => void;
    /** Awaited inside each journal write, before it is stored: a slow journal. */
    readonly journalGate?: (event: InputEvent) => Promise<void>;
    /** What the journal replays on start. */
    readonly history?: readonly InputEvent[];
    /** Called for every audit record; may be slow. */
    readonly audited?: (entry: { readonly event: string }) => Promise<void> | void;
    /** What the journal's quarantine log holds when the daemon starts (a previous run's). */
    readonly quarantineHistory?: readonly InputQuarantineEvent[];
    /** Called for every notice told to the agent. */
    readonly told?: (message: string) => Promise<void> | void;
  } = {},
) {
  const live = options.session ?? SESSION;
  const writes: string[] = [];
  /** The outcomes and requests journalled; the `settled` marks of finished follow-up work are in `settled`. */
  const events: InputEvent[] = [];
  const settled: InputEvent[] = [];
  const holds: InputQuarantineEvent[] = [];
  let card = 1;
  let id = 1;
  const clock = { now: () => Date.parse('2026-10-30T12:00:00.000Z') };
  const quarantine = new QuarantineRegistry(clock);
  const values = new EphemeralValues(clock);
  const service = new InputRequestService({
    target: {
      observe: async () => {
        if (options.crash?.() === true) throw new Error('the terminal subsystem fell over');
        return {
          ok: true,
          facts: typeof options.facts === 'function' ? options.facts() : (options.facts ?? FACTS),
          ...(options.names === undefined ? {} : { names: options.names }),
        };
      },
      ...(options.shot === undefined ? {} : { shoot: async () => options.shot }),
      ...(options.probe === undefined
        ? {}
        : {
            probe: async (_session, _target, _facts, fieldIds) =>
              await (options.probe as NonNullable<typeof options.probe>)(fieldIds),
          }),
      type: async (_session, _target, values, _submit, _expected, typeOptions) => {
        if (typeOptions?.armClear === 'try') typeOptions.armed?.(options.arms === true);
        writes.push(...values.map(value => value.text));
        return 'typed';
      },
    },
    agenda: options.agenda ?? {
      raise: async () => ({ ok: true, id: `A${card++}` as AgendaId }),
      close: async () => undefined,
      promptOf: async () => 'sudo wants your password',
    },
    notifier: { tell: async (_session, _card, message) => void (await options.told?.(message)) },
    journal: {
      publish: async (_session, event) => {
        await options.journalGate?.(event);
        (event.type === 'surface.input_settled' ? settled : events).push(event);
        options.journalled?.(event);
      },
      history: async () => options.history ?? [],
      quarantine: async (_session, event) => {
        holds.push(event);
        options.journalled?.(event);
      },
      quarantines: async () => [...(options.quarantineHistory ?? []), ...holds],
    },
    audit: {
      record: async entry => void (await options.audited?.(entry)),
      saved: async () => undefined,
      stored: async () => undefined,
    },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    sessions: { ended: async candidate => candidate !== live, all: async () => [live] },
    values,
    quarantine,
    redact: async text => values.scrubAll(text),
    ...(options.logins === undefined ? {} : { logins: options.logins }),
    ...(options.scriptedOrigins === undefined
      ? {}
      : {
          grants: {
            enabled: () => false,
            of: () => [],
            scriptedOrigins: options.scriptedOrigins,
          } as unknown as SignInGrantSource,
        }),
    ...(options.observer !== undefined
      ? { observer: options.observer }
      : options.steered === undefined
        ? {}
        : {
            observer: {
              delivered: async () => undefined,
              tainted: (_session: string, _kind: string, since: number) =>
                (options.steered as NonNullable<typeof options.steered>)(since),
            },
          }),
  });
  return { service, writes, events, settled, holds, quarantine };
}
