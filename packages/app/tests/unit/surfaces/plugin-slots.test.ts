import { describe, expect, test } from 'bun:test';
import {
  ACTIONS_ROW_SLOT,
  FERRET_ACCOUNT_SLOTS,
  FERRET_SLOTS,
  FILES_SEARCH_SLOT,
} from '../../../../core/ferrets/contract/slots.ts';
import { AGENDA_CONVERSATION_SLOT as AGENDA_OFFERS } from '../../../../plugins/agenda/contract/slots.ts';
import {
  AGENDA_CONVERSATION_SLOT,
  CONVERSATION_ABOVE_COMPOSER_SLOT,
  CONVERSATION_SLOTS,
} from '../../../../plugins/conversation/contract/slots.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { viewsOf } from '../../../src/layout/engine.ts';
import { isSlotName } from '../../../src/layout/slots.ts';

/**
 * Slots a plugin screen offers (§5.2) are an agreement by name: Ferrets' contract names its two account slots and the
 * props they carry, Runtimes contributes the panels, and neither half imports the other. Proved against the real
 * compiled manifests, so renaming either side fails here instead of drawing an empty field.
 */

const entries = generated.surfaces;
const entryOf = (id: string) => entries.find(entry => entry.id === id);

describe('the slots Ferrets offers', () => {
  test('each is a plugin slot name owned by Ferrets, and Runtimes contributes a panel to each', () => {
    const views = viewsOf(entries);
    for (const slot of FERRET_ACCOUNT_SLOTS) {
      expect(isSlotName(slot)).toBe(true);
      expect(slot.startsWith('ferrets.')).toBe(true);
      const panels = views.panels.get(slot) ?? [];
      expect(panels.map(panel => `${panel.plugin}.${panel.id}`)).toEqual([
        `runtimes.${slot === 'ferrets.new-ferret-account' ? 'new-ferret-account' : 'move-account'}`,
      ]);
    }
  });

  test('every panel contributed to a Ferrets slot is one of the slots its contract names', () => {
    const named: readonly string[] = FERRET_SLOTS;
    const contributed = entries.flatMap(entry =>
      (entry.manifest.ui?.panels ?? []).map(panel => panel.slot as string).filter(slot => slot.startsWith('ferrets.')),
    );
    // Runtimes' two account pickers, the Warden's, Conversation's and MCP's (Add MCP server) rows in the Actions ▾ menu, and Conversation's file search.
    expect([...contributed].sort()).toEqual(
      [...FERRET_ACCOUNT_SLOTS, ACTIONS_ROW_SLOT, ACTIONS_ROW_SLOT, ACTIONS_ROW_SLOT, FILES_SEARCH_SLOT].sort(),
    );
    for (const slot of contributed) expect(named).toContain(slot);
  });

  test('Ferrets imports nothing of Runtimes: the offer is its contract, the contribution is Runtimes’ manifest', () => {
    expect(entryOf('ferrets')?.consumes).not.toContain('runtimes');
    const own = (entryOf('ferrets')?.manifest.ui?.panels ?? []).map(panel => panel.slot as string);
    expect(own.filter(slot => slot.startsWith('ferrets.'))).toEqual([]);
  });
});

describe('the plugin graph with Runtimes using Usage', () => {
  // The DEPENDENCY graph: each manifest's `needs` and `uses`. Not `consumes`, which is the §9.6 hash-folding set and
  // runs the other way for an offered hook such as Vault's `input.targets` (the offerer re-hashes when a taker
  // changes), so it may hold cycles the generator folds as one component.
  const dependsOn = (id: string): readonly string[] => {
    const manifest = entryOf(id)?.manifest;
    return [...Object.keys(manifest?.needs ?? {}), ...Object.keys(manifest?.uses ?? {})];
  };
  const reach = (from: string): ReadonlySet<string> => {
    const seen = new Set<string>();
    const walk = (id: string): void => {
      for (const next of dependsOn(id)) {
        if (seen.has(next)) continue;
        seen.add(next);
        walk(next);
      }
    };
    walk(from);
    return seen;
  };

  test('Runtimes uses Usage, optionally: declared in `uses`, not `needs`', () => {
    const manifest = entryOf('runtimes')?.manifest;
    expect(Object.keys(manifest?.uses ?? {})).toEqual(['usage']);
    expect(Object.keys(manifest?.needs ?? {})).not.toContain('usage');
    expect(reach('runtimes')).toContain('usage');
  });

  test('Usage does not reach Runtimes, directly or through anything it consumes', () => {
    expect(reach('usage')).not.toContain('runtimes');
  });

  test('no plugin reaches itself (core pieces consume each other through hooks and are ordered by the kernel)', () => {
    for (const entry of entries.filter(candidate => !candidate.core)) expect(reach(entry.id)).not.toContain(entry.id);
  });
});

describe('the slot Agenda offers and Conversation fills', () => {
  test('Conversation writes the name Agenda owns, and contributes the ferret’s conversation to it', () => {
    expect(AGENDA_CONVERSATION_SLOT).toBe(AGENDA_OFFERS);
    const contributors = (viewsOf(entries).panels.get(AGENDA_OFFERS) ?? []).map(panel => `${panel.plugin}.${panel.id}`);
    expect(contributors).toEqual(['conversation.agenda-conversation']);
  });
});

describe('the slot Conversation offers above its composer and Claude Code fills', () => {
  test('Claude Code writes the name Conversation owns, and puts its two cards there in order', () => {
    const contributors = (viewsOf(entries).panels.get(CONVERSATION_ABOVE_COMPOSER_SLOT) ?? []).map(
      panel => `${panel.plugin}.${panel.id}`,
    );
    expect(contributors).toEqual(['claude-code.permission-request', 'claude-code.harness-dialog']);
    expect(CONVERSATION_ABOVE_COMPOSER_SLOT).toBe('conversation.above-composer');
    expect(isSlotName(CONVERSATION_ABOVE_COMPOSER_SLOT)).toBe(true);
  });

  test('every panel contributed to a conversation.* slot is one of the slots Conversation’s contract names', () => {
    const named: readonly string[] = CONVERSATION_SLOTS;
    const contributed = entries.flatMap(entry =>
      (entry.manifest.ui?.panels ?? [])
        .map(panel => panel.slot as string)
        .filter(slot => slot.startsWith('conversation.')),
    );
    for (const slot of contributed) expect(named).toContain(slot);
  });

  test('Claude Code imports nothing of Conversation: the two agree by name, and this test is the pairing', () => {
    expect(entryOf('claude-code')?.consumes).not.toContain('conversation');
    expect(Object.keys(entryOf('claude-code')?.manifest.needs ?? {})).toEqual(['ferrets']);
  });
});
