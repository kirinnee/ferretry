import { AgendaItemSchema, AgendaSnapshotSchema, ResolvedAgendaItemSchema } from '../../lib/protocol/agenda.ts';
import { z } from 'zod';
import type { AgendaFileStore } from '../../lib/agenda/agenda-files.ts';
import type { AgendaBoardChange, AgendaChangeObserver } from '../../lib/agenda/service.ts';
import { DAEMON_AGENDA_CAUSES } from '../../lib/agenda/state-machine.ts';

export const AGENDA_CHANGE_OUTBOX = 'agenda-changes.pending.json';
export const AGENDA_CHANGE_MAX_ATTEMPTS = 5;
export const AGENDA_CHANGE_RETRY_MS = 1_000;
// A mapped type makes a new domain change a compile error here until its persisted spelling is supported.
const CHANGE_KINDS: Record<AgendaBoardChange['change'], null> = {
  created: null,
  refreshed: null,
  progressed: null,
  'needs-info': null,
  discussing: null,
  replied: null,
  surfaced: null,
  'info-added': null,
  reopened: null,
  parked: null,
  unparked: null,
  woke: null,
  rested: null,
  nudged: null,
  answered: null,
  logged: null,
  merged: null,
  split: null,
  resolved: null,
  dismissed: null,
};
export const AgendaChangeEffectSchema = z.strictObject({
  id: z.string().min(1),
  event: z.strictObject({
    change: z.enum(Object.keys(CHANGE_KINDS) as AgendaBoardChange['change'][]),
    actor: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('human') }),
      z.strictObject({
        kind: z.literal('agent'),
        sessionId: z.string(),
        name: z.string().nullable(),
        overSubFerret: z.literal(true).optional(),
      }),
      z.strictObject({ kind: z.literal('daemon'), cause: z.enum(DAEMON_AGENDA_CAUSES) }),
    ]),
    via: z.enum(['board', 'conversation']),
    snapshot: AgendaSnapshotSchema,
    item: AgendaItemSchema.optional(),
    addressed: ResolvedAgendaItemSchema.optional(),
  }),
  retry: z
    .strictObject({
      attempts: z.number().int().min(1).max(AGENDA_CHANGE_MAX_ATTEMPTS),
      nextAttemptAt: z.number().finite(),
      error: z.string(),
    })
    .optional(),
});
export type AgendaChangeEffect = z.infer<typeof AgendaChangeEffectSchema>;
const EffectsSchema = z.array(AgendaChangeEffectSchema);

export interface AgendaChangeOutboxRuntime {
  now(): number;
  warn(message: string): void;
}

/** Original events survive a recovered commit. Only file operations use the repository queue; observers may reenter it. */
export class FileAgendaChangeOutbox {
  private readonly flushing = new Set<string>();

  constructor(
    private readonly files: AgendaFileStore,
    private readonly serial: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>,
    private readonly runtime: AgendaChangeOutboxRuntime,
  ) {}

  /** Called under the ledger queue after hot commit, before retiring its durable intent. Idempotent on recovery. */
  async append(sessionId: string, effect: AgendaChangeEffect): Promise<void> {
    const effects = await this.load(sessionId);
    if (effects.some(each => each.id === effect.id)) return;
    await this.files.writeAtomic(sessionId, AGENDA_CHANGE_OUTBOX, JSON.stringify([...effects, effect]));
  }

  async flush(sessionId: string, observer: AgendaChangeObserver): Promise<void> {
    // A projection reads this board, and an observer may mutate it. The outer drain will pick up new events.
    if (this.flushing.has(sessionId)) return;
    this.flushing.add(sessionId);
    try {
      const attempted = new Set<string>();
      const warned = new Set<string>();
      for (;;) {
        const effect = await this.serial(sessionId, async () =>
          this.next(sessionId, await this.load(sessionId), attempted, warned),
        );
        if (effect === undefined) return;
        attempted.add(effect.id);
        try {
          await observer.changed(sessionId, effect.event);
        } catch (error) {
          const attempts = (effect.retry?.attempts ?? 0) + 1;
          const retry = {
            attempts,
            nextAttemptAt: this.runtime.now() + AGENDA_CHANGE_RETRY_MS * 2 ** (attempts - 1),
            error: String(error),
          };
          await this.serial(sessionId, async () => {
            const effects = (await this.load(sessionId)).map(each =>
              each.id === effect.id ? { ...each, retry } : each,
            );
            await this.files.writeAtomic(sessionId, AGENDA_CHANGE_OUTBOX, JSON.stringify(effects));
          });
          this.runtime.warn(
            `Agenda change ${sessionId}/${effect.id}: ${retry.error}; attempt ${attempts}/${AGENDA_CHANGE_MAX_ATTEMPTS}; ` +
              (attempts === AGENDA_CHANGE_MAX_ATTEMPTS
                ? `parked in ${AGENDA_CHANGE_OUTBOX}; repair delivery and remove its retry field to retry`
                : `kept in ${AGENDA_CHANGE_OUTBOX}; retry on a drain after ${retry.nextAttemptAt}`),
          );
          continue;
        }
        await this.serial(sessionId, async () => {
          const remaining = (await this.load(sessionId)).filter(each => each.id !== effect.id);
          // Persist the acknowledgement even for an empty outbox. A repeated ack after a crash is harmless.
          await this.files.writeAtomic(sessionId, AGENDA_CHANGE_OUTBOX, JSON.stringify(remaining));
        });
      }
    } finally {
      this.flushing.delete(sessionId);
    }
  }

  /** A retained event reserves its thread even during backoff or parking. Split children remain independent. */
  private next(
    sessionId: string,
    effects: readonly AgendaChangeEffect[],
    attempted: ReadonlySet<string>,
    warned: Set<string>,
  ): AgendaChangeEffect | undefined {
    // Use all retained snapshots: a merge can join two older pending instructions before either is accepted.
    const parents = new Map<string, string>();
    const thread = (id: string): string => {
      const parent = parents.get(id);
      return parent === undefined ? id : thread(parent);
    };
    for (const { event } of effects) {
      for (const item of [...event.snapshot.items, ...event.snapshot.resolved]) {
        const relatives = [
          ...(item.mergedFrom ?? []),
          ...('mergedInto' in item && item.mergedInto !== undefined ? [item.mergedInto] : []),
        ];
        for (const relative of relatives) {
          const root = thread(relative);
          const survivor = thread(item.id);
          if (root !== survivor) parents.set(root, survivor);
        }
      }
    }
    const barriers = new Map<string, AgendaChangeEffect>();
    for (const effect of effects) {
      const items = [effect.event.item, effect.event.addressed].flatMap(item =>
        item === undefined ? [] : [thread(item.id)],
      );
      const barrier = items.map(id => barriers.get(id)).find(each => each !== undefined);
      for (const id of items) barriers.set(id, barrier ?? effect);
      if (barrier !== undefined) {
        if (barrier.retry?.attempts === AGENDA_CHANGE_MAX_ATTEMPTS && !warned.has(effect.id)) {
          warned.add(effect.id);
          this.runtime.warn(
            `Agenda change ${sessionId}/${effect.id}: blocked behind parked change ${barrier.id} for ${items.join(', ')} ` +
              `in ${AGENDA_CHANGE_OUTBOX}; repair delivery and remove the parked change's retry field to retry`,
          );
        }
        continue;
      }
      if (
        !attempted.has(effect.id) &&
        (effect.retry === undefined ||
          (effect.retry.attempts < AGENDA_CHANGE_MAX_ATTEMPTS && effect.retry.nextAttemptAt <= this.runtime.now()))
      )
        return effect;
    }
    return undefined;
  }

  private async load(sessionId: string): Promise<AgendaChangeEffect[]> {
    const text = await this.files.read(sessionId, AGENDA_CHANGE_OUTBOX);
    return text === undefined ? [] : EffectsSchema.parse(JSON.parse(text));
  }
}
