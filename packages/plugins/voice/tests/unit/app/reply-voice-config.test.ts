import { describe, expect, it } from 'bun:test';
import { DEFAULT_REPLY_VOICE_CHOICE, readReplyVoice, withReplyVoice } from '../../../app/lib/reply-voice-config.ts';

const VOICE = { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' };
const FILE =
  '# yaml-language-server: $schema=./.schema/voice.json\n# mine\ndefaultEngine: parakeet\npostProcessing:\n  provider: groq # keep\n';

describe('the reply voice in voice.yaml', () => {
  it('reads Kokoro from an empty file and from a file that names no reply voice', () => {
    expect(readReplyVoice('')).toEqual(DEFAULT_REPLY_VOICE_CHOICE);
    expect(readReplyVoice(FILE)).toEqual(DEFAULT_REPLY_VOICE_CHOICE);
  });

  it('choosing ElevenLabs adds only that key, and the owner’s comments and other settings stay', () => {
    const next = withReplyVoice(FILE, { provider: 'elevenlabs' });
    expect(next).toContain('# mine');
    expect(next).toContain('provider: groq # keep');
    expect(next).toContain('defaultEngine: parakeet');
    expect(readReplyVoice(next ?? '')).toMatchObject({ provider: 'elevenlabs', voiceId: undefined });
    // No key, secret or value of any kind is ever written.
    expect(next).not.toMatch(/key|secret|xi_/iu);
  });

  it('picking a voice writes its id and name; choosing Kokoro again deletes the provider key instead of writing the default', () => {
    const on = withReplyVoice(FILE, { provider: 'elevenlabs', voice: VOICE }) ?? '';
    expect(readReplyVoice(on)).toMatchObject({ provider: 'elevenlabs', voiceId: VOICE.id, voiceName: 'George' });
    const back = withReplyVoice(on, { provider: 'kokoro' }) ?? '';
    expect(back).not.toContain('provider: kokoro');
    expect(readReplyVoice(back)).toMatchObject({ provider: 'kokoro', voiceId: VOICE.id });
  });

  it('a file that does not check is not edited', () => {
    expect(withReplyVoice('replyVoice:\n  provider: openai\n', { provider: 'elevenlabs' })).toBeNull();
    expect(readReplyVoice('replyVoice:\n  provider: openai\n')).toBeNull();
    expect(withReplyVoice(': : :', { provider: 'elevenlabs' })).toBeNull();
  });

  it('a voice id that is not a plain id is refused rather than written into the file', () => {
    expect(withReplyVoice('', { voice: { id: '../../v1/user', name: 'Evil' } })).toBeNull();
  });

  it('keeps the daily limit the owner wrote', () => {
    const text = 'replyVoice:\n  provider: elevenlabs\n  elevenlabs:\n    dailyChars: 5000\n';
    expect(readReplyVoice(text)?.dailyChars).toBe(5000);
    expect(readReplyVoice(withReplyVoice(text, { voice: VOICE }) ?? '')?.dailyChars).toBe(5000);
  });
});
