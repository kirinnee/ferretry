import { describe, expect, it } from 'bun:test';
import { AgendaRollupStore } from '../../../app/lib/agenda-rollup.ts';
import { AgendaFerretStore } from '../../../app/lib/ferret-store.ts';
import { daemonConnection } from '../../../app/shell.ts';
import { listClock } from '../../support/app/list-clock.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';
import { callFromFetch } from '../../support/app/call-from-fetch.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a' });
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const flush = async (): Promise<void> => {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
};

/** A store over a scripted Ferrets list and roll-up; `reads` counts each. */
const build = (answer: { list: () => Response; open: () => Response }) => {
  const reads = { list: 0, open: 0 };
  const client = callFromFetch(async input => {
    if (new URL(input).pathname === '/v1/ferrets') {
      reads.list += 1;
      return answer.list();
    }
    reads.open += 1;
    return answer.open();
  });
  const clock = listClock();
  const rollup = new AgendaRollupStore(client);
  const store = new AgendaFerretStore(client, daemon, rollup, clock.environment);
  return { store, rollup, clock, reads };
};

const open = (...ids: string[]) => json({ sessions: ids.map(sessionId => ({ sessionId, items: [agendaItem('A1')] })) });

describe('AgendaFerretStore', () => {
  it('knows no ferrets until the list is read, then draws them with the roll-up’s summary', async () => {
    const { store, clock } = build({
      list: () => json([{ id: 'f1', title: 'Fix it', state: 'idle' }]),
      open: () => open('f1'),
    });
    expect(store.getSnapshot().daemons.get(daemon.daemonId)?.sessions).toBeNull();

    let heard = 0;
    const stop = store.subscribe(() => (heard += 1));
    await clock.advance(0);
    const sessions = store.getSnapshot().daemons.get(daemon.daemonId)?.sessions;
    expect(sessions?.map(each => each.config.id)).toEqual(['f1']);
    expect(sessions?.[0]?.state.agenda?.open).toBe(1);
    expect(heard).toBeGreaterThan(0);

    const before = heard;
    stop();
    store.ferretChanged();
    await clock.advance(5_000);
    expect(heard).toBe(before);
  });

  it('does not read again for a second subscriber once the list is held', async () => {
    const { store, clock, reads } = build({ list: () => json([]), open: () => open() });
    store.subscribe(() => undefined);
    await clock.advance(0);
    const listReads = reads.list;
    store.subscribe(() => undefined);
    await clock.advance(0);
    expect(reads.list).toBe(listReads);
  });

  it('reads the list again when a ferret changed, and the roll-up again when an ask changed', async () => {
    const { store, clock, reads } = build({ list: () => json([{ id: 'f1' }]), open: () => open('f1') });
    await store.refresh();
    await clock.advance(0);
    const { list, open: rolled } = reads;

    store.ferretChanged();
    await clock.advance(2_000);
    expect(reads.list).toBe(list + 1);
    expect(reads.open).toBe(rolled);

    store.askChanged();
    await clock.advance(2_000);
    expect(reads.open).toBe(rolled + 1);
  });

  it('keeps the ferrets it has, and shows none at the first failure, when the list cannot be read', async () => {
    let failing = true;
    const { store, clock } = build({
      list: () => (failing ? json({}, 500) : json([{ id: 'f1' }])),
      open: () => open(),
    });
    store.subscribe(() => undefined);
    await clock.advance(0);
    expect(store.getSnapshot().daemons.get(daemon.daemonId)?.sessions).toEqual([]);

    failing = false;
    store.ferretChanged();
    await clock.advance(2_000);
    expect(
      store
        .getSnapshot()
        .daemons.get(daemon.daemonId)
        ?.sessions?.map(each => each.config.id),
    ).toEqual(['f1']);

    failing = true;
    store.ferretChanged();
    await clock.advance(2_000);
    expect(
      store
        .getSnapshot()
        .daemons.get(daemon.daemonId)
        ?.sessions?.map(each => each.config.id),
    ).toEqual(['f1']);
  });

  it('stops reading when it is stopped', async () => {
    const { store, clock, reads } = build({ list: () => json([]), open: () => open() });
    await store.refresh();
    await clock.advance(0);
    store.stop();
    const before = { ...reads };
    store.ferretChanged();
    store.askChanged();
    await flush();
    await clock.advance(5_000);
    expect(reads).toEqual(before);
  });
});
