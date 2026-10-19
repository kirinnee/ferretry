import { describe, expect, it } from 'bun:test';
import { type GuideUseCase, MAX_GUIDE_CANDIDATES, MAX_GUIDE_USE_CASES } from '@ferretry/protocol';
import {
  BLANK_CANDIDATE,
  blankUseCase,
  canAddCandidate,
  canAddUseCase,
  candidateWithModel,
  guideChanged,
  keywordsText,
  moveItem,
  parseKeywords,
  removeItem,
  replaceItem,
} from '../../../src/lib/pack/guide-draft.ts';
import { ASTRA, FLEET_MODELS, OPUS, PACK_VIEW } from '../../support/pack.ts';

const GUIDE = PACK_VIEW.guide.useCases;

describe('guide draft steps', () => {
  it('moves an item one place, and leaves the list alone at its ends', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    const list = ['a', 'b'];
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 1, 1)).toBe(list);
    expect(moveItem(list, 5, -1)).toBe(list);
    expect(moveItem(list, -1, 1)).toBe(list);
  });

  it('replaces and removes by place', () => {
    expect(replaceItem(['a', 'b'], 1, 'z')).toEqual(['a', 'z']);
    expect(removeItem(['a', 'b'], 0)).toEqual(['b']);
  });

  it('adds a blank use case with an id nobody has, up to the limits', () => {
    const taken = [{ ...(GUIDE[0] as GuideUseCase), id: 'use-case-2' }, GUIDE[1] as GuideUseCase];
    expect(blankUseCase(taken)).toEqual({ id: 'use-case-3', title: 'New use case', description: '', candidates: [] });
    expect(canAddUseCase(GUIDE)).toBe(true);
    expect(canAddUseCase(Array.from({ length: MAX_GUIDE_USE_CASES }, () => GUIDE[0] as GuideUseCase))).toBe(false);
    expect(canAddCandidate(GUIDE[0] as GuideUseCase)).toBe(true);
    expect(
      canAddCandidate({ ...(GUIDE[0] as GuideUseCase), candidates: Array(MAX_GUIDE_CANDIDATES).fill(BLANK_CANDIDATE) }),
    ).toBe(false);
  });

  it('turns keywords into one line and back, dropping blanks', () => {
    expect(keywordsText(['plan', 'review'])).toBe('plan, review');
    expect(keywordsText(undefined)).toBe('');
    expect(parseKeywords(' plan, ,review, ')).toEqual(['plan', 'review']);
  });

  it('fills the provider from a chosen model, names the CLI only when both list it, and drops a foreign effort', () => {
    expect(candidateWithModel({ provider: '', model: 'x', effort: 'high', why: 'w' }, OPUS, FLEET_MODELS)).toEqual({
      provider: 'anthropic',
      model: OPUS.id,
      effort: 'high',
      why: 'w',
    });
    expect(
      candidateWithModel({ provider: '', model: '', effort: 'max', harness: 'claude', why: '' }, ASTRA, FLEET_MODELS),
    ).toEqual({
      provider: 'openai',
      model: ASTRA.id,
      why: '',
    });
    const both = [...FLEET_MODELS, { ...ASTRA, harness: 'claude' as const }];
    expect(candidateWithModel(BLANK_CANDIDATE, ASTRA, both).harness).toBe('codex');
  });

  it('knows when the draft differs from the guide in effect', () => {
    expect(guideChanged(GUIDE, [...GUIDE])).toBe(false);
    expect(guideChanged(GUIDE.slice(1), GUIDE)).toBe(true);
  });
});
