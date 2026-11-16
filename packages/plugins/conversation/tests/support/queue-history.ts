import type { Instant } from '@ferretry/std';
import type { QueueEvent } from '../../daemon/queue/lib/model.ts';
import type { QueuedMessage, QueuedMessageState } from '../../daemon/seams/protocol.ts';

/** A small seeded generator, so a failing history can be replayed by its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
/** Work goes on at the oldest few open messages, as a real queue's does: the open set stays small. */
const WINDOW = 6;

/**
 * `count` events of a busy queue, deterministic for a `seed`: messages are accepted, held for a reason, typed,
 * delivered, read, edited, cancelled and failed; some are retried (`enqueued` again for an id already held), some events
 * are illegal where the message stands (the fold must ignore them), and a few messages are abandoned open for good, as
 * a message delivered and never read is — so every rotation has something to carry.
 */
export function queueHistory(seed: number, count: number): readonly QueueEvent[] {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const events: QueueEvent[] = [];
  const known = new Map<string, { state: QueuedMessageState; revision: number }>();
  let live: string[] = [];
  let made = 0;
  const at = (): Instant => new Date(T0 + events.length * 1_000).toISOString() as Instant;
  const message = (id: string): QueuedMessage => ({
    v: 1,
    id,
    sender: 'human',
    text: `${id} text`,
    attachmentIds: [],
    enqueuedAt: at(),
    state: 'queued',
    stateAt: at(),
    revision: 1,
  });
  const move = (id: string, state: QueuedMessageState): void => {
    events.push({ v: 1, kind: 'moved', at: at(), id, state });
    const entry = known.get(id);
    if (entry !== undefined) entry.state = state;
  };
  while (events.length < count) {
    const roll = random();
    if (live.length === 0 || roll < 0.12) {
      const id = `m${made++}`;
      known.set(id, { state: 'queued', revision: 1 });
      events.push({ v: 1, kind: 'enqueued', at: at(), message: message(id) });
      live.push(id);
      continue;
    }
    if (roll < 0.15) {
      const id = `m${Math.floor(random() * made)}`;
      events.push({ v: 1, kind: 'enqueued', at: at(), message: message(id) });
      continue;
    }
    if (roll < 0.17) {
      // Illegal for where the message stands, or for a message that was never accepted.
      const id = random() < 0.5 ? 'ghost' : pick(live.slice(0, WINDOW));
      events.push({ v: 1, kind: 'moved', at: at(), id, state: 'read' });
      continue;
    }
    const id = pick(live.slice(0, WINDOW));
    const entry = known.get(id) as { state: QueuedMessageState; revision: number };
    if (random() < 0.0005) {
      live = live.filter(other => other !== id);
      continue;
    }
    switch (entry.state) {
      case 'queued': {
        const step = random();
        if (step < 0.35)
          events.push({
            v: 1,
            kind: 'waiting',
            at: at(),
            id,
            ...(random() < 0.5 ? { reason: pick(['draft', 'unreadable'] as const) } : {}),
          });
        else if (step < 0.4) {
          entry.revision += 1;
          events.push({
            v: 1,
            kind: 'edited',
            at: at(),
            id,
            text: `${id} text r${entry.revision}`,
            revision: entry.revision,
          });
        } else if (step < 0.45) move(id, 'cancelled');
        else if (step < 0.46) move(id, 'failed');
        else move(id, 'typing');
        break;
      }
      case 'typing':
        move(id, pick(['delivered', 'delivered', 'delivered', 'unconfirmed', 'queued', 'failed'] as const));
        break;
      case 'unconfirmed':
        move(id, pick(['delivered', 'read'] as const));
        break;
      case 'delivered':
        move(id, 'read');
        break;
      default:
        live = live.filter(other => other !== id);
    }
  }
  return events;
}
