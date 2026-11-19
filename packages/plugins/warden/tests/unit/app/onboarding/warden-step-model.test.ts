import { describe, expect, it } from 'bun:test';
import {
  choiceOf,
  patchFor,
  keyStillOpen,
  WARDEN_CHOICES,
  wardenFileExists,
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

describe('whether warden.yaml is already on the machine', () => {
  it('counts any file that exists, whatever it says (even enabled: false), so it is never written over', () => {
    expect(wardenFileExists({ exists: true })).toBe(true);
  });

  it('does not count a file that is not there', () => {
    expect(wardenFileExists({ exists: false })).toBe(false);
  });
});

describe('whether an answer leaves the Jev key to settle', () => {
  it('holds only for a Jev answer whose key is stored but not named, or not stored', () => {
    expect(keyStillOpen('jev', 'not_named')).toBe(true);
    expect(keyStillOpen('llm', 'missing')).toBe(true);
    expect(keyStillOpen('jev', 'set')).toBe(false);
    expect(keyStillOpen('jev', 'off')).toBe(false);
    expect(keyStillOpen('jev', 'unknown')).toBe(false);
    expect(keyStillOpen('rules', 'not_named')).toBe(false);
  });
});
