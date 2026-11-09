import { expect, it } from 'bun:test';
import type { AskDraft } from '../../../contract/index.ts';
import { asksPort } from '../../../daemon/adapters/asks-port.ts';
import { agendaService } from './routes/support.ts';

const LEDGERS = 300;
const names = Array.from({ length: LEDGERS }, (_, i) => `b${i}`);
const boards = { ferrets: async () => names };

/** The real agenda service with every ledger read counted by the verb that made it. */
function counted() {
  const inner = agendaService();
  const reads = { list: 0, raisedObligation: 0, raisedObligations: 0 };
  const agenda = {
    list: (id: string) => {
      reads.list += 1;
      return inner.list(id);
    },
    raisedObligation: (id: string, ref: string) => {
      reads.raisedObligation += 1;
      return inner.raisedObligation(id, ref);
    },
    raisedObligations: (id: string) => {
      reads.raisedObligations += 1;
      return inner.raisedObligations(id);
    },
    raise: inner.raise.bind(inner),
    resolve: inner.resolve.bind(inner),
    dismiss: inner.dismiss.bind(inner),
    snooze: inner.snooze.bind(inner),
    unsnooze: inner.unsnooze.bind(inner),
  };
  return { agenda, reads };
}

const draft = (entry: string): AskDraft => ({
  source: 'daemon',
  entry,
  ref: {},
  kind: 'yesno',
  subject: 'Release?',
  why: 'Ready',
  raisedBy: { kind: 'daemon' },
  ferret: 's1',
});

it('open({ ferret }) reads only the named ferret board, not all 300', async () => {
  const { agenda, reads } = counted();
  const api = asksPort(agenda, boards, () => 'unavailable');
  await api.open({ ferret: 'b7' });
  expect(reads.list).toBe(1);
});

it('open without a ferret still reads every board once', async () => {
  const { agenda, reads } = counted();
  const api = asksPort(agenda, boards, () => 'unavailable');
  await api.open({});
  expect(reads.list).toBe(LEDGERS);
});

it('a second raise reads one board, not every board (the obligation index)', async () => {
  const { agenda, reads } = counted();
  const api = asksPort(agenda, boards, () => 'unavailable');
  await api.raise(draft('e1'));
  const afterFirst = reads.raisedObligation + reads.raisedObligations;
  await api.raise(draft('e2'));
  const second = reads.raisedObligation + reads.raisedObligations - afterFirst;
  expect(second).toBeLessThanOrEqual(3);
  expect(afterFirst).toBeLessThanOrEqual(LEDGERS + 3);
});

it('a raise held on another board is returned from the index without a rescan', async () => {
  const { agenda, reads } = counted();
  const api = asksPort(agenda, boards, () => 'unavailable');
  const first = await api.raise(draft('e1'));
  const before = reads.raisedObligations;
  expect(await api.raise(draft('e1'))).toEqual(first);
  expect(reads.raisedObligations).toBe(before);
});
