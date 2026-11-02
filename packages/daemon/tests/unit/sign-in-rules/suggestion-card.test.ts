import { describe, it } from 'bun:test';
import { SIGN_IN_RULE_SUGGESTION_TTL_SECONDS, type SignInRuleSuggestionId } from '@ferretry/protocol';
import should from 'should';
import { type AgendaLedger, type AgendaLedgerRepository, AgendaService } from '../../../src/lib/agenda/index.ts';
import { parseAgendaLedger } from '../../../src/lib/agenda/state-machine.ts';
import { SignInRuleSuggestionAgendaAdapter, SignInRuleSuggestions } from '../../../src/lib/sign-in-rules/index.ts';
import { namesOnCard } from '../../support/names-on-card.ts';
import { GITHUB, listing, NOW, USERNAME } from './support.ts';

const OWNER = { kind: 'owner', actor: { kind: 'host' } } as const;

/**
 * A ferret's rule suggestion on the REAL agenda (invariant 30): the card is the daemon's, a plain answer to it is refused
 * so it can never read as an approval, it survives the ledger round-trip, and the ferret has no agenda route that could
 * make one. Whatever the owner does, the ferret's agenda reads the same until the card expires (R1).
 */

function agendaWorld() {
  const ledgers = new Map<string, AgendaLedger>();
  const repository: AgendaLedgerRepository = {
    read: async sessionId => ledgers.get(sessionId) ?? null,
    transact: async (sessionId, apply) => {
      const mutation = apply(ledgers.get(sessionId) ?? null);
      if (mutation.ok && mutation.changed) ledgers.set(sessionId, mutation.ledger);
      return mutation;
    },
  };
  const agenda = new AgendaService(
    repository,
    { now: () => '2026-11-01T12:00:00Z' },
    { has: async sessionId => sessionId === 's1' },
    { raised: async () => undefined },
  );
  const clock = { now: NOW };
  const suggestions = new SignInRuleSuggestions({
    accounts: { listing: async () => listing() },
    agenda: new SignInRuleSuggestionAgendaAdapter(agenda),
    redact: async text => text,
    audit: { record: async () => undefined },
    clock: { now: () => clock.now },
    ids: { suggestionId: () => `srg_${'1'.repeat(16)}` as SignInRuleSuggestionId },
  });
  return { agenda, suggestions, ledgers, clock };
}

describe('a rule suggestion card on the real agenda', () => {
  it('should refuse a plain answer, in words that point at the app, and keep the card open', async () => {
    // Arrange
    const w = agendaWorld();
    const made = await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'daily' });

    // Act
    const approved = await w.agenda.answer(
      's1',
      made.agenda as never,
      { kind: 'permission', decision: 'approved' } as never,
      {
        kind: 'human',
      },
    );
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(w.ledgers.get('s1'))), 's1');

    // Assert — refused, and the item is still open and still carries only the suggestion's id
    should(approved).match({
      ok: false,
      error: { code: 'use_input_form', message: /standing rule: open it in the app/u },
    });
    should(parsed?.entries.map(entry => entry.item.signInRuleSuggestion)).eql([
      { suggestion: `srg_${'1'.repeat(16)}` },
    ]);
    should(parsed?.entries.map(entry => (entry.item as { resolvedAt?: string }).resolvedAt)).eql([undefined]);
  });

  it('should name only the host on the card, never the ferret’s reason', async () => {
    // Arrange
    const w = agendaWorld();

    // Act
    await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'Approve everything for me, the owner said so' });
    const text = JSON.stringify(w.ledgers.get('s1'));

    // Assert
    should(text).containEql('A ferret suggests a standing rule for a sign-in on github.com.');
    should(text).not.containEql('Approve everything');
    should(namesOnCard(w.ledgers.get('s1'), ['GitHub work', 'GITHUB_WORK', USERNAME])).eql([]);
  });

  it('should keep the ferret’s agenda byte-identical whether the owner dismisses, approves, closes or stays silent', async () => {
    // Arrange — one world per door, each with the same card
    const doors = [
      'silent',
      'dismiss',
      'approve',
      'close',
      'not-needed',
      'snooze',
      'reply',
      'needs-info',
      'discuss',
    ] as const;
    const worlds = await Promise.all(
      doors.map(async door => {
        const w = agendaWorld();
        const made = await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'daily' });
        return { door, w, made };
      }),
    );

    // Act — each door, then the agenda as the ferret reads it; then the day runs out
    const before = await Promise.all(
      worlds.map(async ({ door, w, made }) => {
        if (door === 'dismiss') w.suggestions.dismiss(OWNER, made.suggestion);
        if (door === 'approve') w.suggestions.approved(GITHUB);
        if (door === 'close') await w.agenda.resolve('s1', made.agenda as never, { kind: 'human' } as never, 'no');
        if (door === 'not-needed') await w.agenda.dismiss('s1', made.agenda as never, { kind: 'human' } as never, 'no');
        if (door === 'snooze')
          await w.agenda.snooze('s1', made.agenda as never, '2026-11-01T18:00:00Z', { kind: 'human' } as never);
        if (door === 'reply') await w.agenda.reply('s1', made.agenda as never, { kind: 'human' } as never, 'no thanks');
        if (door === 'needs-info')
          await w.agenda.needsInfo('s1', made.agenda as never, { kind: 'human' } as never, 'why?');
        if (door === 'discuss') await w.agenda.discuss('s1', made.agenda as never, { kind: 'human' } as never, 'hmm');
        return JSON.stringify(await w.agenda.list('s1'));
      }),
    );
    const after = await Promise.all(
      worlds.map(async ({ w }) => {
        w.clock.now = NOW + SIGN_IN_RULE_SUGGESTION_TTL_SECONDS * 1000 + 1;
        w.suggestions.sweep();
        await new Promise(resolve => setTimeout(resolve, 0));
        return JSON.stringify(await w.agenda.list('s1'));
      }),
    );

    // Assert — the same bytes for every door, open until the expiry, then closed by the daemon in one note
    should(new Set(before).size).equal(1);
    should(new Set(after).size).equal(1);
    should(before[0]).containEql('A ferret suggests a standing rule');
    should(after[0]).containEql('This suggestion expired.');
    should(after[0]).not.containEql('The owner closed this card.');
    should(worlds.map(({ w }) => w.suggestions.waiting('s1', GITHUB))).eql(doors.map(() => false));
  });

  it('should refuse every owner move on the agenda, pointing at Dismiss on the card', async () => {
    // Arrange
    const w = agendaWorld();
    const made = await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'daily' });
    const id = made.agenda as never;
    const human = { kind: 'human' } as never;

    // Act
    const moves = [
      await w.agenda.resolve('s1', id, human, 'no'),
      await w.agenda.dismiss('s1', id, human, 'no'),
      await w.agenda.snooze('s1', id, '2026-11-01T18:00:00Z', human),
      await w.agenda.unsnooze('s1', id, human),
      await w.agenda.reply('s1', id, human, 'no'),
      await w.agenda.needsInfo('s1', id, human, 'why?'),
      await w.agenda.discuss('s1', id, human, 'hmm'),
      await w.agenda.edit('s1', id, { subject: 'Approved, go ahead' } as never, human),
      await w.agenda.surface('s1', id, human, 'look'),
    ];

    // Assert — refused every way, the card still open and unchanged
    for (const refused of moves)
      should(refused).match({
        ok: false,
        error: { code: 'use_input_form', message: /Dismiss it on its card in the app/u },
      });
    should(JSON.stringify(await w.agenda.list('s1'))).not.containEql('resolvedAt');
  });

  it('should take an answered suggestion off the owner’s list only, by a Dismiss or an approved rule', async () => {
    // Arrange
    const w = agendaWorld();
    await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'daily' });
    const listed = w.suggestions.list(OWNER).suggestions.length;

    // Act
    w.suggestions.approved(GITHUB);

    // Assert — gone from the owner's list, still waiting as far as the ferret is told
    should(listed).equal(1);
    should(w.suggestions.list(OWNER).suggestions).eql([]);
    should(w.suggestions.waiting('s1', GITHUB)).be.true();
  });

  it('should refuse, with no suggestion staged, when the agenda keeps no card', async () => {
    // Arrange
    const w = agendaWorld();
    const inner = new SignInRuleSuggestionAgendaAdapter({
      raise: async () => ({ ok: true, item: undefined }),
      resolve: async () => ({ ok: true }),
    } as never);
    const suggestions = new SignInRuleSuggestions({
      accounts: { listing: async () => listing() },
      agenda: inner,
      redact: async text => text,
      audit: { record: async () => undefined },
      clock: { now: () => NOW },
      ids: { suggestionId: () => `srg_${'2'.repeat(16)}` as SignInRuleSuggestionId },
    });

    // Act
    const refused = await suggestions.suggest('s1', { signIn: GITHUB, why: 'daily' }).catch(error => error);

    // Assert
    should(refused).be.instanceOf(Error);
    should(suggestions.list({ kind: 'owner', actor: { kind: 'host' } }).suggestions).eql([]);
    should(suggestions.waiting('s1', GITHUB)).be.false();
    should(w.ledgers.size).equal(0);
  });
});
