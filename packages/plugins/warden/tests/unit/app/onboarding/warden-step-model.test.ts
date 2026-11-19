import { describe, expect, it } from 'bun:test';
import {
  choiceOf,
  patchFor,
  WARDEN_CHOICES,
  wardenFileWritten,
} from '../../../../app/features/onboarding/warden-step-model.ts';

describe('the Warden step answers', () => {
  it('offers the three cards in the order they cost', () => {
    expect(WARDEN_CHOICES.map(choice => choice.title)).toEqual(['Rules only', '+ Jev', '+ LLM investigation']);
  });

  it('writes only the Warden switch and the two layers, even when they equal the defaults', () => {
    expect(patchFor('rules')).toEqual({ enabled: true, layers: { jev: false, llm: false } });
    expect(patchFor('jev')).toEqual({ enabled: true, layers: { jev: true, llm: false } });
    expect(patchFor('llm')).toEqual({ enabled: true, layers: { jev: true, llm: true } });
  });

  it('reads the highest layer that is on as the answer', () => {
    expect(choiceOf({ layers: { jev: false, llm: false } })).toBe('rules');
    expect(choiceOf({ layers: { jev: true, llm: false } })).toBe('jev');
    expect(choiceOf({ layers: { jev: false, llm: true } })).toBe('llm');
    expect(choiceOf({ layers: { jev: true, llm: true } })).toBe('llm');
  });
});

describe('whether the person wrote warden.yaml', () => {
  it('counts a file that exists and says something', () => {
    expect(wardenFileWritten({ exists: true, written: { layers: { jev: true } } })).toBe(true);
  });

  it('does not count a missing, empty or unreadable one', () => {
    expect(wardenFileWritten({ exists: false })).toBe(false);
    expect(wardenFileWritten({ exists: true })).toBe(false);
    expect(wardenFileWritten({ exists: true, written: {} })).toBe(false);
    expect(wardenFileWritten({ exists: true, written: 'enabled: true' })).toBe(false);
    expect(wardenFileWritten({ exists: true, written: null })).toBe(false);
  });
});
