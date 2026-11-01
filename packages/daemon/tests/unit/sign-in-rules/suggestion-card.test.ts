import { describe, it } from 'bun:test';
import type { SignInRuleSuggestionId } from '@ferretry/protocol';
import should from 'should';
import { type AgendaLedger, type AgendaLedgerRepository, AgendaService } from '../../../src/lib/agenda/index.ts';
import { parseAgendaLedger } from '../../../src/lib/agenda/state-machine.ts';
import { SignInRuleSuggestionAgendaAdapter, SignInRuleSuggestions } from '../../../src/lib/sign-in-rules/index.ts';
import { GITHUB, listing, NOW } from './support.ts';

/**
 * A ferret's rule suggestion on the REAL agenda (invariant 30): the card is the daemon's, a plain answer to it is refused
 * so it can never read as an approval, it survives the ledger round-trip, and the ferret has no agenda route that could
 * make one.
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
  const suggestions = new SignInRuleSuggestions({
    accounts: { listing: async () => listing() },
    agenda: new SignInRuleSuggestionAgendaAdapter(agenda),
    redact: async text => text,
    audit: { record: async () => undefined },
    clock: { now: () => NOW },
    ids: { suggestionId: () => `srg_${'1'.repeat(16)}` as SignInRuleSuggestionId },
  });
  return { agenda, suggestions, ledgers };
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
    should(text).not.containEql('GitHub work');
  });

  it('should close the card when the owner turns the suggestion down', async () => {
    // Arrange
    const w = agendaWorld();
    const made = await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'daily' });

    // Act
    await w.suggestions.dismiss({ kind: 'owner', actor: { kind: 'host' } }, made.suggestion);
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(w.ledgers.get('s1'))), 's1');

    // Assert
    should(parsed?.entries.map(entry => (entry.item as { resolutionNote?: string }).resolutionNote)).eql([
      'The owner closed this card.',
    ]);
  });

  it('should see a card the owner resolved on the agenda as closed, and an open one as open', async () => {
    // Arrange
    const w = agendaWorld();
    const made = await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'daily' });
    const adapter = new SignInRuleSuggestionAgendaAdapter(w.agenda);
    const id = made.agenda as string;

    // Act
    const before = await adapter.isOpen('s1', id);
    await w.agenda.resolve('s1', made.agenda as never, { kind: 'human' } as never, 'done');
    const after = await adapter.isOpen('s1', id);
    const missing = await adapter.isOpen('no-such-session', id);

    // Assert — an unreadable agenda must never end a suggestion
    should(before).be.true();
    should(after).be.false();
    should(missing).be.true();
  });

  it('should end the suggestion when the owner closes its card on the agenda, and keep the ferret blocked', async () => {
    // Arrange
    const w = agendaWorld();
    const made = await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'daily' });
    await w.agenda.resolve('s1', made.agenda as never, { kind: 'human' } as never, 'done');

    // Act
    await w.suggestions.reconcile();
    const retry = await w.suggestions.suggest('s1', { signIn: GITHUB, why: 'again' }).catch(error => error);

    // Assert
    should(w.suggestions.list({ kind: 'owner', actor: { kind: 'host' } }).suggestions).eql([]);
    should(retry).match({ code: 'capacity' });
    should(w.suggestions.waiting('s1', GITHUB)).be.true();
  });

  it('should refuse, with no suggestion staged, when the agenda keeps no card', async () => {
    // Arrange
    const w = agendaWorld();
    const inner = new SignInRuleSuggestionAgendaAdapter({
      raise: async () => ({ ok: true, item: undefined }),
      resolve: async () => ({ ok: true }),
      list: async () => ({ ok: true, value: { items: [] } }),
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
