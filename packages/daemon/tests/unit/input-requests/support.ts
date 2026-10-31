import type { AgendaId, InputEvent, InputRaise, InputTargetFacts } from '@ferretry/protocol';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { QuarantineRegistry } from '../../../src/lib/input-requests/quarantine.ts';
import { InputRequestService } from '../../../src/lib/input-requests/service.ts';

export const SESSION = 'mvv6b4qw-49d0158d';

export const FACTS: Extract<InputTargetFacts, { readonly kind: 'terminal' }> = {
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 1,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'a'.repeat(64),
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
    /** What the terminal shows; the default is a sudo prompt. */
    readonly facts?: InputTargetFacts;
    /** Every other way the terminal is known besides its key. */
    readonly names?: readonly string[];
    /** The one live session; the default is {@link SESSION}. */
    readonly session?: string;
  } = {},
) {
  const live = options.session ?? SESSION;
  const writes: string[] = [];
  const events: InputEvent[] = [];
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
          facts: options.facts ?? FACTS,
          ...(options.names === undefined ? {} : { names: options.names }),
        };
      },
      type: async (_session, _target, values) => {
        writes.push(...values.map(value => value.text));
        return 'typed';
      },
    },
    agenda: {
      raise: async () => ({ ok: true, id: `A${card++}` as AgendaId }),
      close: async () => undefined,
      promptOf: async () => 'sudo wants your password',
    },
    notifier: { tell: async () => undefined },
    journal: {
      publish: async (_session, event) => void events.push(event),
      history: async () => [],
      quarantine: async () => undefined,
      quarantines: async () => [],
    },
    audit: { record: async () => undefined, saved: async () => undefined },
    clock,
    ids: { requestId: () => (id++).toString(16).padStart(32, '0') },
    timers: { after: async () => await new Promise<void>(() => undefined) },
    sessions: { ended: async candidate => candidate !== live, all: async () => [live] },
    values,
    quarantine,
    redact: async text => values.scrubAll(text),
  });
  return { service, writes, events, quarantine };
}
