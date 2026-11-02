import { describe, expect, it } from 'bun:test';
import { QuickAddAnswerSchema } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  publishDestination,
  addedSentence,
  alreadySentence,
  defaultCatalogName,
  defaultCatalogOf,
  listedLive,
  ownerRefusal,
  quickAddOutcome,
  reviewSentence,
  roleLabel,
  undoneSentence,
} from '../../../../src/features/catalogs/catalogs-model.ts';
import { sharedItemFor } from '../../../../src/features/catalogs/catalog-row-model.ts';
import { addedAnswer, CATALOG, ITEM, itemPreview, ownedCatalog, sharedItem } from '../../../support/catalog-views.ts';

const SECOND = `cat_${'d'.repeat(22)}`;
const SKILL = '/home/k/.claude/skills/pdf-tools/SKILL.md';

describe('the default catalog', () => {
  it('labels only the default, by its role or by the id the list names', () => {
    expect(roleLabel(ownedCatalog({ role: 'default' }))).toBe('default');
    expect(roleLabel(ownedCatalog(), CATALOG)).toBe('default');
    expect(roleLabel(ownedCatalog(), SECOND)).toBeNull();
    expect(roleLabel(ownedCatalog())).toBeNull();
  });

  it('finds the default by the id first, then by role', () => {
    const first = ownedCatalog();
    const second = ownedCatalog({ id: SECOND, name: 'Other', role: 'default' });
    expect(defaultCatalogOf([first, second], CATALOG)).toBe(first);
    expect(defaultCatalogOf([first, second], undefined)).toBe(second);
    expect(defaultCatalogOf([first], undefined)).toBeUndefined();
  });

  it('names the catalog one tap would make after the machine, and falls back when it has no name', () => {
    expect(defaultCatalogName('kirin-box')).toBe('kirin-box’s skills');
    expect(defaultCatalogName('  ')).toBe('My skills');
    expect(defaultCatalogName(undefined)).toBe('My skills');
    expect(defaultCatalogName('x'.repeat(100))).toBe(`${'x'.repeat(71)}’s skills`);
  });

  it('says where Add goes, and never claims a catalog that is not made yet', () => {
    expect(publishDestination(ownedCatalog(), 'kirin-box')).toBe('Publish in Team skills');
    expect(publishDestination(undefined, 'kirin-box')).toBe('Publish in a new catalog, kirin-box’s skills');
  });
});

describe('quickAddOutcome', () => {
  it('maps an add to the catalog name and the Undo token', () => {
    const answer = QuickAddAnswerSchema.parse(addedAnswer());
    expect(quickAddOutcome(answer, [])).toEqual({
      kind: 'added',
      catalogName: 'Team skills',
      token: answer.outcome === 'added' ? answer.undo.token : '',
    });
  });

  it('names the catalog an "already" only gave an id for, or says "your default catalog"', () => {
    const answer = QuickAddAnswerSchema.parse({ outcome: 'already', catalogId: CATALOG, itemId: ITEM, itemVersion: 2 });
    expect(quickAddOutcome(answer, [ownedCatalog()])).toEqual({ kind: 'already', catalogName: 'Team skills' });
    expect(quickAddOutcome(answer, [])).toEqual({ kind: 'already', catalogName: 'your default catalog' });
  });

  it('carries the review and its reasons, with or without a preview', () => {
    const { catalogId: _drop, ...preview } = itemPreview();
    const withPreview = QuickAddAnswerSchema.parse({ outcome: 'review', reasons: ['warnings'], preview });
    const outcome = quickAddOutcome(withPreview, []);
    expect(outcome.kind).toBe('review');
    expect(outcome.kind === 'review' && outcome.preview?.name).toBe('pdf-tools');
    const without = QuickAddAnswerSchema.parse({ outcome: 'review', reasons: ['needs-summary'] });
    expect(quickAddOutcome(without, [])).toEqual({ kind: 'review', preview: undefined, reasons: ['needs-summary'] });
  });
});

describe('the sentences', () => {
  it('says why a tap stopped, one sentence per reason', () => {
    expect(reviewSentence(['warnings'])).toContain('something to read');
    expect(reviewSentence(['problems', 'needs-summary'])).toContain('left out');
    expect(reviewSentence(['problems', 'needs-summary'])).toContain('summary');
    expect(reviewSentence([])).toBe('');
    expect(reviewSentence(['mystery'])).toBe('');
  });

  it('says what was added, what was already there, and what Undo did', () => {
    expect(addedSentence('Team skills')).toBe('Published in Team skills');
    expect(alreadySentence('Team skills')).toBe('Already in Team skills');
    const base = { catalogId: CATALOG, itemId: ITEM, revision: 5, itemRemoved: false } as const;
    expect(undoneSentence({ ...base, mode: 'retracted' }, 'Team skills')).toBe(
      'Taken back. It was never in Team skills for anyone.',
    );
    expect(undoneSentence({ ...base, mode: 'withdrawn' }, 'Team skills')).toContain('Withdrawn from Team skills.');
  });

  it('has a sentence for every new refusal, and offers Preview again for a moved item', () => {
    const refusal = (code: string) => ownerRefusal(new FyHttpError('x', 409, code));
    expect(refusal('catalogs_full').sentence).toContain('256');
    expect(refusal('items_full').sentence).toContain('shared items');
    expect(refusal('item_listed').sentence).toBe('That is already in this catalog.');
    expect(refusal('current_changed')).toMatchObject({ previewAgain: true });
    expect(refusal('changed_since_preview')).toMatchObject({ previewAgain: true });
    expect(refusal('undo_expired').sentence).toContain('Undo ran out of time');
    expect(refusal('undo_expired').previewAgain).toBe(false);
    expect(refusal('source_ambiguous').sentence).toContain('Pick a catalog');
  });
});

describe('shared items', () => {
  it('lists the catalogs that still list an item live', () => {
    const item = sharedItem({
      catalogs: [
        { catalogId: CATALOG, state: 'live' },
        { catalogId: SECOND, state: 'withdrawn', withdrawnAt: '2026-10-31T09:00:00.000Z' },
      ],
    });
    expect(listedLive(item)).toEqual([CATALOG]);
  });

  it('matches a row to its item by path, by skill name, or by MCP id', () => {
    const skill = sharedItem();
    const mcp = sharedItem({
      itemId: `itm_${'m'.repeat(22)}`,
      kind: 'mcp',
      name: 'acme-mcp',
      source: { kind: 'mcp', id: 'acme', name: 'acme' },
    });
    const items = [skill, mcp];
    expect(sharedItemFor(items, { kind: 'skill', skill: SKILL })).toBe(skill);
    expect(sharedItemFor(items, { kind: 'skill', skill: 'pdf-tools' })).toBe(skill);
    expect(sharedItemFor(items, { kind: 'skill', skill: '/elsewhere/SKILL.md' })).toBeUndefined();
    expect(sharedItemFor(items, { kind: 'mcp', mcp: 'acme' })).toBe(mcp);
    expect(sharedItemFor(items, { kind: 'mcp', mcp: 'other' })).toBeUndefined();
  });
});
