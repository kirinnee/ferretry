import { describe, expect, it } from 'bun:test';
import { tellFerret, tellKeyOf } from '../../../../daemon/adapters/agenda/tell-ferret.ts';
import {
  AGENDA_REPLY_SETTLE_MS,
  type AgendaOutbox,
  type AgendaOutboxRepository,
  AgendaReplyBatcher,
  type AgendaReplyTimers,
  itemOfKey,
} from '../../../../daemon/lib/agenda/index.ts';

const FERRET = 'mvv6b4qw-49d0158d';
const AT = '2026-11-07T10:00:00.000Z';

class Outboxes implements AgendaOutboxRepository {
  readonly files = new Map<string, AgendaOutbox>();
  async read(sessionId: string) {
    return this.files.get(sessionId) ?? null;
  }
  async write(outbox: AgendaOutbox) {
    this.files.set(outbox.sessionId, structuredClone(outbox));
  }
}
class Timers implements AgendaReplyTimers {
  readonly tasks = new Map<string, number>();
  schedule(key: string, delayMs: number) {
    this.tasks.set(key, delayMs);
  }
  cancel(key: string) {
    this.tasks.delete(key);
  }
}

function world() {
  const outboxes = new Outboxes();
  const timers = new Timers();
  const sent: { message: string; sendId: string }[] = [];
  const time = { ms: Date.parse(AT) };
  const batcher = new AgendaReplyBatcher(
    outboxes,
    {
      send: async (_ferret, message, sendId) => {
        sent.push({ message, sendId });
      },
    },
    timers,
    { run: async (_key, task) => await task() },
    { now: () => new Date(time.ms).toISOString() },
  );
  return { batcher, sent, time, tell: tellFerret(batcher) };
}

describe('a tell joins the ferret’s reply batch', () => {
  it('goes out with an answer for the same ferret as ONE send, joined by a blank line as today', async () => {
    const { batcher, sent, time, tell } = world();
    await batcher.add(FERRET, 'A1', '[answer to !A1 «ok?»] yes');
    expect(await tell(FERRET, 'A3 ended without a value.', 'input-ended-f-A3')).toBe('queued');
    time.ms += AGENDA_REPLY_SETTLE_MS;
    await batcher.flush(FERRET);
    expect(sent.length).toBe(1);
    expect(sent[0]?.message).toBe('[answer to !A1 «ok?»] yes\n\nA3 ended without a value.');
  });

  it('is told once per send id, and a different ferret’s same id is a different tell', async () => {
    const { tell } = world();
    expect(await tell(FERRET, 'one', 'id')).toBe('queued');
    expect(await tell(FERRET, 'one', 'id')).toBe('known');
    expect(await tell('other-ferret-1', 'one', 'id')).toBe('queued');
    expect(tellKeyOf(`${FERRET}\nid`)).not.toBe(tellKeyOf(`other-ferret-1\nid`));
  });

  it('is keyed to no item, so a tell that never arrives can never become an owner’s card', () => {
    expect(itemOfKey(tellKeyOf('anything'))).toBeUndefined();
    expect(tellKeyOf('anything')).toMatch(/^tell~[0-9a-f]{14}$/u);
  });

  it('carries only the text it is given: nothing else is added to what is typed', async () => {
    const { batcher, sent, time, tell } = world();
    await tell(FERRET, 'A3 was answered and typed into %terminal:dev.', 'input-ended-f-A3');
    time.ms += AGENDA_REPLY_SETTLE_MS;
    await batcher.flush(FERRET);
    expect(sent.map(each => each.message)).toEqual(['A3 was answered and typed into %terminal:dev.']);
  });
});
