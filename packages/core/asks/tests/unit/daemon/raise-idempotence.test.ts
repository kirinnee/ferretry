import { expect, it } from 'bun:test';
import type { AskDraft } from '../../../contract/index.ts';
import { asksPort } from '../../../daemon/adapters/asks-port.ts';
import { agendaLedgerDocument, parseAgendaLedger } from '../../../daemon/lib/agenda/index.ts';
import { agendaService, FakeLedgerRepository } from './routes/support.ts';

const draft: AskDraft = {
  source: 'daemon',
  entry: 'release1',
  ref: {},
  kind: 'yesno',
  subject: 'Release?',
  why: 'Ready',
  raisedBy: { kind: 'daemon' },
  ferret: 's1',
};
const boards = { ferrets: async () => ['s1', 'ferret-own'] };

it('returns the same source obligation after answer or close', async () => {
  const service = agendaService();
  const api = asksPort(service, boards, () => 'unavailable');
  const first = await api.raise(draft);
  await api.close(first, 'withdrawn');
  expect(await api.raise(draft)).toEqual(first);
  expect(await api.notify({ ...draft, ferret: 'ferret-own' })).toEqual(first);
});

it('keeps the obligation index when closed history is pruned and the service restarts', async () => {
  const repository = new FakeLedgerRepository();
  const api = asksPort(agendaService(repository), boards, () => 'unavailable');
  const first = await api.raise(draft);
  await api.close(first, 'answered');
  const ledger = await repository.read();
  if (ledger === null) throw new Error('missing fixture ledger');
  const stored = parseAgendaLedger(JSON.parse(agendaLedgerDocument({ ...ledger, entries: [] })), 's1');
  const restarted = asksPort(agendaService(new FakeLedgerRepository(stored)), boards, () => 'unavailable');
  expect(await restarted.raise(draft)).toEqual(first);
});

it('names the home a redirected raise landed on, now and on every repeat', async () => {
  const inner = agendaService();
  // The engine puts a daemon raise about a sub-ferret on its lineage's home, not on the board the draft named.
  const redirected = {
    list: (id: string) => inner.list(id),
    raise: (_ferret: string, request: Parameters<typeof inner.raise>[1], actor: Parameters<typeof inner.raise>[2]) =>
      inner.raise('ferret-own', request, actor),
    resolve: inner.resolve.bind(inner),
    dismiss: inner.dismiss.bind(inner),
    snooze: inner.snooze.bind(inner),
    unsnooze: inner.unsnooze.bind(inner),
    cardAsk: inner.cardAsk.bind(inner),
    raisedObligation: inner.raisedObligation.bind(inner),
    raisedObligations: inner.raisedObligations.bind(inner),
  };
  const api = asksPort(redirected, boards, () => 'unavailable');
  const first = await api.raise(draft);
  expect(first.ferret).toBe('ferret-own');
  expect(await api.raise(draft)).toEqual(first);
});

it('coalesces concurrent raises across boards by source and entry', async () => {
  const api = asksPort(agendaService(), boards, () => 'unavailable');
  const refs = await Promise.all([api.raise(draft), api.raise({ ...draft, ferret: 'ferret-own' })]);
  expect(refs[1]).toEqual(refs[0]);
});
