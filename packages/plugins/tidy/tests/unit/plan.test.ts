import { describe, expect, test } from 'bun:test';
import { planTidy, type TidyAskFact, type TidyCardFact, type TidyFacts } from '../../daemon/lib/plan.ts';

const ME = 'lead-1';
const OTHER = 'helper-2';

const card = (id: string, extra: Partial<TidyCardFact> = {}): TidyCardFact => ({
  id,
  title: `Card ${id}`,
  project: 'proj',
  owner: ME,
  assignee: null,
  askedBy: 'agent',
  ...extra,
});

const ask = (id: string, extra: Partial<TidyAskFact> = {}): TidyAskFact => ({
  id,
  subject: `Ask ${id}`,
  kind: 'task',
  source: 'ferret',
  raisedBy: { kind: 'ferret', ferret: ME },
  state: 'open',
  ...extra,
});

const facts = (extra: Partial<TidyFacts> = {}): TidyFacts => ({
  ferret: ME,
  helper: false,
  cards: [],
  boardsOn: new Set(),
  liveFerrets: new Set(),
  gateCards: new Set(),
  asks: [],
  ...extra,
});

const dropped = (plan: ReturnType<typeof planTidy>) => plan.drop.map(each => String(each.id));
const closed = (plan: ReturnType<typeof planTidy>) => plan.close.map(each => String(each.id));
const kept = (plan: ReturnType<typeof planTidy>) => plan.keep.map(each => `${each.id}:${each.code}`);

describe('planTidy: cards', () => {
  test('drops the ferret’s own open agent-asked card on a board that is off', () => {
    const plan = planTidy(facts({ cards: [card('F1')] }));
    expect(dropped(plan)).toEqual(['F1']);
    expect(plan.keep).toEqual([]);
    expect(String(plan.ferret)).toBe(ME);
  });
  test('drops a card the ferret is assigned though another ferret owns it', () => {
    expect(dropped(planTidy(facts({ cards: [card('F1', { owner: OTHER, assignee: ME })] })))).toEqual(['F1']);
  });
  test('leaves a card some other ferret owns and does', () => {
    const plan = planTidy(facts({ cards: [card('F1', { owner: OTHER, assignee: OTHER })] }));
    expect([plan.drop, plan.keep]).toEqual([[], []]);
  });
  test('keeps a card the owner asked for', () => {
    expect(kept(planTidy(facts({ cards: [card('F1', { askedBy: 'person' })] })))).toEqual(['F1:owner-asked']);
  });
  test('keeps a card on a board that is on', () => {
    expect(kept(planTidy(facts({ cards: [card('F1')], boardsOn: new Set(['proj']) })))).toEqual(['F1:board-on']);
  });
  test('keeps a card another live ferret is assigned to, and drops it once that ferret is gone', () => {
    const handed = card('F1', { assignee: OTHER });
    expect(kept(planTidy(facts({ cards: [handed], liveFerrets: new Set([OTHER]) })))).toEqual([
      'F1:assigned-to-live-ferret',
    ]);
    expect(dropped(planTidy(facts({ cards: [handed] })))).toEqual(['F1']);
  });
  test('does not count the ferret itself as another live ferret', () => {
    expect(dropped(planTidy(facts({ cards: [card('F1')], liveFerrets: new Set([ME]) })))).toEqual(['F1']);
  });
  test('keeps a card waiting at a gate on the owner', () => {
    expect(kept(planTidy(facts({ cards: [card('F1')], gateCards: new Set(['F1']) })))).toEqual(['F1:waiting-at-gate']);
  });
  test('puts no card in a helper’s plan, because the board refuses its drops', () => {
    const plan = planTidy(facts({ helper: true, cards: [card('F1')] }));
    expect([plan.helper, plan.drop, plan.keep]).toEqual([true, [], []]);
  });
});

describe('planTidy: asks', () => {
  test('closes a notice', () => {
    const plan = planTidy(facts({ asks: [ask('A1', { kind: 'notice' })] }));
    expect(plan.close.map(each => [String(each.id), each.subject, each.code, each.why])).toEqual([
      ['A1', 'Ask A1', 'notice', 'it only informs; nothing to decide'],
    ]);
  });
  test('closes a "do this" ask that asks no question, as status only', () => {
    expect(planTidy(facts({ asks: [ask('A1')] })).close[0]?.code).toBe('status-only');
  });
  test('keeps every ask that wants the owner to decide', () => {
    for (const kind of ['yesno', 'permission', 'choice', 'review', 'reply', 'form', 'input'] as const) {
      const plan = planTidy(facts({ asks: [ask('A1', { kind })] }));
      expect([kind, kept(plan)]).toEqual([kind, ['A1:needs-owner']]);
    }
  });
  test('keeps a card-gate ask and a daemon-raised ask', () => {
    const plan = planTidy(
      facts({
        asks: [ask('A1', { source: 'card' }), ask('A2', { raisedBy: { kind: 'daemon' } })],
      }),
    );
    expect(kept(plan)).toEqual(['A1:gate', 'A2:gate']);
  });
  test('keeps an ask the owner or another ferret raised', () => {
    const plan = planTidy(
      facts({
        asks: [ask('A1', { raisedBy: { kind: 'owner' } }), ask('A2', { raisedBy: { kind: 'ferret', ferret: OTHER } })],
      }),
    );
    expect(kept(plan)).toEqual(['A1:not-yours', 'A2:not-yours']);
  });
  test('keeps an ask the owner has answered and the ferret has not been told of', () => {
    expect(kept(planTidy(facts({ asks: [ask('A1', { kind: 'notice', state: 'answered' })] })))).toEqual([
      'A1:owner-replying',
    ]);
  });
  test('still closes a helper’s own tracking asks', () => {
    expect(closed(planTidy(facts({ helper: true, asks: [ask('A1')] })))).toEqual(['A1']);
  });
  test('plans nothing for a ferret with nothing', () => {
    expect(planTidy(facts())).toEqual({ ferret: ME as never, helper: false, drop: [], close: [], keep: [] });
  });
});
