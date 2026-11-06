import { describe, expect, it } from 'bun:test';
import {
  MAX_IDEA_CHARS,
  MAX_ROUGH_PROMPT_CHARS,
  MAX_ROUTING_PROMPT_CHARS,
  PACK_QUOTA_STATES,
} from '@ferretry/protocol';
import {
  cleanUpProblem,
  ideaCounter,
  ideaFill,
  ordinal,
  QUOTA_CHIP,
  routingCounter,
  routingSaveProblem,
  routingSourceWords,
  writeProblem,
} from '../../../src/lib/pack/routing-prompt.ts';

const date = (instant: string): string => `<${instant}>`;

describe('routingSourceWords', () => {
  it('names the owner’s words, an accepted clean-up and the catalogs’ default', () => {
    expect(routingSourceWords({ text: 'x', source: 'file' }, date)).toBe('Your words');
    expect(routingSourceWords({ text: 'x', source: 'default' }, date)).toBe('Default — built from the model catalogs');
    expect(
      routingSourceWords(
        {
          text: 'x',
          source: 'file',
          suggested: {
            by: 'gpt-6-astra',
            via: 'codex-main',
            at: '2026-10-22T14:30:00Z',
            acceptedAt: '2026-10-22T15:00:00Z',
          },
        },
        date,
      ),
    ).toBe('Cleaned up by gpt-6-astra via codex-main, accepted <2026-10-22T15:00:00Z>');
  });
});

describe('Write it for me', () => {
  it('says a prompt was written, not cleaned up, when the builder wrote it', () => {
    const suggested = {
      by: 'gpt-6-astra',
      via: 'codex-main',
      at: '2026-10-22T14:30:00Z',
      acceptedAt: '2026-10-22T15:00:00Z',
      mode: 'generate',
    } as const;
    expect(routingSourceWords({ text: 'x', source: 'file', suggested }, date)).toBe(
      'Written by gpt-6-astra via codex-main, accepted <2026-10-22T15:00:00Z>',
    );
  });

  it('starts when a runtime is ready and nothing is running, and says why not otherwise', () => {
    expect(writeProblem({ available: true, runtimes: ['claude-main'] }, false)).toBeNull();
    expect(writeProblem({ available: true, runtimes: ['claude-main'] }, true)).toBe(
      'A prompt is already being written.',
    );
    expect(writeProblem({ available: false, runtimes: [], reason: 'No runtime is ready.' }, false)).toBe(
      'No runtime is ready.',
    );
    expect(writeProblem({ available: false, runtimes: [] }, false)).toContain('cannot write');
  });
});

describe('saving and cleaning up', () => {
  const ready = { available: true, runtimes: ['claude-main'] } as const;

  it('counts trimmed characters against the saved limit', () => {
    expect(routingCounter('  abc  ')).toBe(`3 / ${MAX_ROUTING_PROMPT_CHARS.toLocaleString('en-US')}`);
  });

  it('counts the idea as typed, line breaks and edges included, against its own limit', () => {
    expect(ideaCounter('')).toBe('0 / 4,000');
    expect(ideaCounter(' a\nb ')).toBe('5 / 4,000');
    expect(ideaCounter('x'.repeat(MAX_IDEA_CHARS))).toBe('4,000 / 4,000');
  });

  it('warns from nine tenths of the idea limit and calls it full at the limit', () => {
    expect(ideaFill('x'.repeat(MAX_IDEA_CHARS * 0.9 - 1))).toBe('ok');
    expect(ideaFill('x'.repeat(MAX_IDEA_CHARS * 0.9))).toBe('near');
    expect(ideaFill('x'.repeat(MAX_IDEA_CHARS - 1))).toBe('near');
    expect(ideaFill('x'.repeat(MAX_IDEA_CHARS))).toBe('full');
  });

  it('allows a blank or full-length prompt and says why a longer one cannot be saved', () => {
    expect(routingSaveProblem('')).toBeNull();
    expect(routingSaveProblem('x'.repeat(MAX_ROUTING_PROMPT_CHARS))).toBeNull();
    const problem = routingSaveProblem('x'.repeat(MAX_ROUTING_PROMPT_CHARS + 1)) ?? '';
    expect(problem).toContain('Too long to save: 1,201 characters');
    expect(problem).toContain('Clean up');
  });

  it('says why Clean up cannot run: the daemon’s reason, a run already going, or too much text', () => {
    expect(cleanUpProblem('rough', ready, false)).toBeNull();
    expect(cleanUpProblem('x'.repeat(MAX_ROUGH_PROMPT_CHARS), ready, false)).toBeNull();
    expect(cleanUpProblem('rough', { available: false, runtimes: [], reason: 'No runtime is ready.' }, false)).toBe(
      'No runtime is ready.',
    );
    expect(cleanUpProblem('rough', { available: false, runtimes: [] }, false)).toContain('cannot clean up');
    expect(cleanUpProblem('rough', ready, true)).toBe('A clean-up is already running.');
    expect(cleanUpProblem('x'.repeat(MAX_ROUGH_PROMPT_CHARS + 1), ready, false)).toContain('at most 6,000');
  });
});

describe('the available-now words', () => {
  it('writes English ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '103rd',
      '111th',
    ]);
  });

  it('gives every quota band its own word, so colour is not the only signal', () => {
    const labels = PACK_QUOTA_STATES.map(state => QUOTA_CHIP[state].label);
    expect(new Set(labels).size).toBe(PACK_QUOTA_STATES.length);
  });
});
