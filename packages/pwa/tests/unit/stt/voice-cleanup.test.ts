import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_VOICE_CLEANUP,
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  MAX_VOICE_PROMPT_CHARS,
  promptFor,
  readVoiceCleanup,
  withVoiceCleanup,
} from '../../../src/lib/stt/voice-cleanup.ts';

const FILE =
  '# yaml-language-server: $schema=./.schema/voice.json\n# mine\ndefaultEngine: parakeet\npostProcessing:\n  provider: groq # keep\n';

describe('readVoiceCleanup', () => {
  it('reads the defaults from an empty file and from a file naming none', () => {
    expect(readVoiceCleanup('')).toEqual(DEFAULT_VOICE_CLEANUP);
    expect(readVoiceCleanup(FILE)).toEqual(DEFAULT_VOICE_CLEANUP);
  });

  it('reads every cleanup field', () => {
    const text =
      'postProcessing:\n  style: polish\n  prompts:\n    polish: Be brief\n  useConversation: true\n  conversationMessages: 5\n';
    expect(readVoiceCleanup(text)).toEqual({
      style: 'polish',
      prompts: { polish: 'Be brief' },
      useConversation: true,
      conversationMessages: 5,
    });
  });

  it('is null for a file that does not parse or does not check', () => {
    expect(readVoiceCleanup('a: [')).toBeNull();
    expect(readVoiceCleanup('postProcessing:\n  style: shout\n')).toBeNull();
    expect(readVoiceCleanup('postProcessing:\n  conversationMessages: 11\n')).toBeNull();
  });

  it('treats a file whose top level is not a mapping as the defaults it fails to be', () => {
    expect(readVoiceCleanup('- a\n')).toBeNull();
  });
});

describe('promptFor', () => {
  it('runs the person’s prompt, else the shipped default', () => {
    expect(promptFor(DEFAULT_VOICE_CLEANUP, 'fix')).toBe(DEFAULT_VOICE_CLEANUP_PROMPTS.fix);
    expect(promptFor({ ...DEFAULT_VOICE_CLEANUP, prompts: { fix: 'mine' } }, 'fix')).toBe('mine');
  });
});

describe('withVoiceCleanup', () => {
  it('changes only the key asked for and keeps comments and the other keys', () => {
    const next = withVoiceCleanup(FILE, { style: 'polish' });
    expect(next).toContain('# mine');
    expect(next).toContain('defaultEngine: parakeet');
    expect(next).toContain('provider: groq # keep');
    expect(next).toContain('style: polish');
    expect(readVoiceCleanup(next ?? '')?.style).toBe('polish');
  });

  it('does not write a default the file did not already hold', () => {
    const next = withVoiceCleanup(FILE, { style: 'fix', useConversation: false, conversationMessages: 8 });
    expect(next).not.toContain('style');
    expect(next).not.toContain('useConversation');
    expect(next).not.toContain('conversationMessages');
  });

  it('writes a default back where the file already names the key', () => {
    const text = 'postProcessing:\n  style: polish\n';
    expect(withVoiceCleanup(text, { style: 'fix' })).toContain('style: fix');
  });

  it('creates postProcessing in an empty file and starts the file with the schema modeline', () => {
    const next = withVoiceCleanup('', { useConversation: true });
    expect(next).toContain('yaml-language-server');
    expect(readVoiceCleanup(next ?? '')?.useConversation).toBe(true);
  });

  it('clamps the message count into 1..10', () => {
    expect(readVoiceCleanup(withVoiceCleanup('', { conversationMessages: 99 }) ?? '')?.conversationMessages).toBe(10);
    expect(readVoiceCleanup(withVoiceCleanup('', { conversationMessages: 0 }) ?? '')?.conversationMessages).toBe(1);
  });

  it('stores an edited prompt trimmed and capped', () => {
    const next = withVoiceCleanup('', { prompts: { fix: `  ${'x'.repeat(MAX_VOICE_PROMPT_CHARS + 50)}  ` } });
    expect(readVoiceCleanup(next ?? '')?.prompts.fix).toHaveLength(MAX_VOICE_PROMPT_CHARS);
  });

  it('keeps the other prompt when one is edited', () => {
    const one = withVoiceCleanup('', { prompts: { fix: 'a' } }) ?? '';
    const two = withVoiceCleanup(one, { prompts: { polish: 'b' } }) ?? '';
    expect(readVoiceCleanup(two)?.prompts).toEqual({ fix: 'a', polish: 'b' });
  });

  it('deletes the key on "Reset to default" and drops an emptied prompts map', () => {
    const edited = withVoiceCleanup(FILE, { prompts: { fix: 'a' } }) ?? '';
    const reset = withVoiceCleanup(edited, { prompts: { fix: null } }) ?? '';
    expect(reset).not.toContain('prompts');
    expect(reset).toContain('# mine');
  });

  it('treats a blank prompt or the shipped default as a reset', () => {
    const edited = withVoiceCleanup('', { prompts: { fix: 'a', polish: 'b' } }) ?? '';
    const reset = withVoiceCleanup(edited, { prompts: { fix: '   ', polish: DEFAULT_VOICE_CLEANUP_PROMPTS.polish } });
    expect(reset).not.toContain('prompts');
  });

  it('leaves an untouched prompt alone when only the other changes', () => {
    const edited = withVoiceCleanup('', { prompts: { fix: 'a' } }) ?? '';
    const next = withVoiceCleanup(edited, { prompts: { polish: undefined }, style: 'polish' }) ?? '';
    expect(readVoiceCleanup(next)?.prompts).toEqual({ fix: 'a' });
  });

  it('removes postProcessing when the last key is reset', () => {
    const text = 'postProcessing:\n  prompts:\n    fix: a\n';
    expect(withVoiceCleanup(text, { prompts: { fix: null } })).not.toContain('postProcessing');
  });

  it('refuses to edit a file that does not check', () => {
    expect(withVoiceCleanup('postProcessing:\n  style: shout\n', { style: 'fix' })).toBeNull();
  });
});
