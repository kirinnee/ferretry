import { describe, expect, it } from 'bun:test';
import {
  acceptRequest,
  allTicks,
  anyTicked,
  isPartial,
  noteSubject,
  reviewOf,
  suggestedLine,
  ticked,
} from '../../../src/lib/pack/guide-review.ts';
import { SUGGESTION } from '../../support/pack.ts';

const review = reviewOf(SUGGESTION);

describe('reviewOf', () => {
  it('lays the draft against the guide in effect, and finds what can be ticked', () => {
    expect(review.rows.map(row => [row.id, row.status])).toEqual([
      ['hard', 'same'],
      ['bulk', 'changed'],
      ['docs', 'added'],
      ['legacy', 'removed'],
    ]);
    expect(review.changing).toEqual(['bulk', 'docs', 'legacy']);
    expect(review.routingDiffers).toBe(true);
  });

  it('sees an unchanged routing as no change', () => {
    expect(reviewOf({ ...SUGGESTION, routing: SUGGESTION.current.routing as never }).routingDiffers).toBe(false);
  });
});

describe('ticks', () => {
  it('opens with every change ticked, which leaves nothing out', () => {
    const ticks = allTicks(review);
    expect([...ticks.accepted]).toEqual(['bulk', 'docs', 'legacy']);
    expect(ticks.routing).toBe(true);
    expect(anyTicked(review, ticks)).toBe(true);
    expect(isPartial(review, ticks)).toBe(false);
  });

  it('is partial when a row or the routing is left out, and has nothing to accept when none is ticked', () => {
    expect(isPartial(review, { accepted: new Set(['bulk', 'docs']), routing: true })).toBe(true);
    expect(isPartial(review, { accepted: new Set(['bulk', 'docs', 'legacy']), routing: false })).toBe(true);
    expect(anyTicked(review, { accepted: new Set(), routing: false })).toBe(false);
    expect(anyTicked(review, { accepted: new Set(), routing: true })).toBe(true);
    expect(anyTicked(review, { accepted: new Set(['bulk']), routing: false })).toBe(true);
  });
});

describe('what the ticks mean', () => {
  it('Accept all is the draft itself, its routing included, and not partial', () => {
    const request = acceptRequest(SUGGESTION, review, allTicks(review));
    expect(request.useCases).toEqual([...SUGGESTION.useCases]);
    expect(request.routing).toEqual(SUGGESTION.routing);
    expect(request.partial).toBeUndefined();
    expect(request.suggested).toEqual(SUGGESTION.suggested);
  });

  it('a selection merges only the ticked rows into the current guide and marks it partial', () => {
    const request = acceptRequest(SUGGESTION, review, { accepted: new Set(['docs', 'legacy']), routing: false });
    expect(request.useCases.map(useCase => useCase.id)).toEqual(['hard', 'bulk', 'docs']);
    expect(request.useCases[1]).toEqual(SUGGESTION.current.useCases[1] as never);
    expect(request.routing).toBeUndefined();
    expect(request.partial).toBe(true);
  });

  it('ticked() is what Edit loads', () => {
    expect(ticked(SUGGESTION, review, { accepted: new Set(), routing: true }).routing).toEqual(SUGGESTION.routing);
    expect(ticked(SUGGESTION, review, { accepted: new Set(), routing: false }).routing).toBeUndefined();
  });
});

describe('words', () => {
  it('says who drafted it, on what and when', () => {
    expect(suggestedLine(SUGGESTION.suggested, '2026-10-22 14:30:00')).toBe(
      'Suggested by gpt-6-astra on codex-main, 2026-10-22 14:30:00',
    );
  });

  it('leads a note with what it is about', () => {
    expect(noteSubject({ useCase: 'docs', provider: 'zai', model: 'glm-9', message: 'm' })).toBe(
      'Use case docs · zai/glm-9',
    );
    expect(noteSubject({ model: 'glm-9', message: 'm' })).toBe('glm-9');
    expect(noteSubject({ useCase: 'docs', message: 'm' })).toBe('Use case docs');
    expect(noteSubject({ message: 'm' })).toBe('');
  });
});
