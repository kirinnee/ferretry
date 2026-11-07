import { describe, expect, test } from 'bun:test';
import {
  MAX_STT_DICTIONARY_ENTRIES,
  SttEnhancementRequestSchema,
  type SttEnhancementResult,
} from '../../../contract/index.ts';
import cli from '../../../cli/index.ts';
import { enhanceRequest, renderEnhancement } from '../../../cli/lib/enhance.ts';
import manifest from '../../../manifest.ts';

const terms = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `term-${index}`);

const result: SttEnhancementResult = {
  text: 'Never install at the repository root.',
  provider: 'groq',
  model: 'llama-3.3-70b',
  latencyMs: 320,
};

function run(
  verb: 'voice' | 'voice enhance',
  args: string[],
  options: Record<string, string | boolean | string[]> = {},
) {
  const calls: { route: string; body: unknown }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const half = cli.build?.({
    manifest,
    client: {
      call: async (route: string, init?: { body?: unknown }) => {
        calls.push({ route, body: init?.body });
        return result;
      },
      subscribe: () => () => undefined,
    } as never,
    io: { out: text => out.push(text), err: text => err.push(text), isTty: false },
  });
  return { calls, out, err, done: half?.verbs[verb]({ args, options }) };
}

describe('fy voice', () => {
  test('cleans up text given on the command line, enhance being the default verb', async () => {
    for (const verb of ['voice', 'voice enhance'] as const) {
      const { calls, out, done } = run(verb, ['never', 'install', 'at', 'the', 'root'], { model: ' llama ' });
      expect(await done).toBe(0);
      expect(calls).toEqual([
        {
          route: 'POST /v1/stt/enhance',
          body: { text: 'never install at the root', provider: 'groq', model: 'llama' },
        },
      ]);
      expect(out[0]).toStartWith('Never install at the repository root.');
    }
  });

  test('refuses an empty request rather than paying a provider for nothing', async () => {
    const { calls, err, done } = run('voice', ['  ']);
    expect(await done).toBe(2);
    expect(calls).toEqual([]);
    expect(err[0]).toContain('enhance needs the text to clean up');
  });

  test('omits every optional field the caller did not supply', () => {
    expect(enhanceRequest(['hello'], { model: '  ', context: '  ', term: [] })).toEqual({
      text: 'hello',
      provider: 'groq',
    });
  });

  test('collects repeated terms and a trimmed context into the request', async () => {
    const { calls, done } = run('voice', ['hello'], { term: ['Ferretry', '  '], context: ' release notes ' });
    await done;
    expect(calls[0]?.body).toEqual({
      text: 'hello',
      provider: 'groq',
      userContext: 'release notes',
      dictionary: [{ term: 'Ferretry' }],
    });
  });

  test('carries a dictionary that exactly fills the wire bound and discards the term past it', () => {
    const exact = enhanceRequest(['hello'], { term: terms(MAX_STT_DICTIONARY_ENTRIES) });
    expect(exact.dictionary).toHaveLength(MAX_STT_DICTIONARY_ENTRIES);
    expect(() => SttEnhancementRequestSchema.parse(exact)).not.toThrow();
    const over = enhanceRequest(['hello'], { term: terms(MAX_STT_DICTIONARY_ENTRIES + 1) });
    expect(over.dictionary).toHaveLength(MAX_STT_DICTIONARY_ENTRIES);
    expect(over.dictionary).not.toContainEqual({ term: `term-${MAX_STT_DICTIONARY_ENTRIES}` });
    expect(() => SttEnhancementRequestSchema.parse(over)).not.toThrow();
  });

  test('refuses a transcript past the wire bound before it reaches the daemon', async () => {
    const { calls, err, done } = run('voice', ['x'.repeat(8_001)]);
    expect(await done).toBe(2);
    expect(calls).toEqual([]);
    expect(err).toHaveLength(1);
  });

  test('emits the enhancement payload under --json', async () => {
    const { out, done } = run('voice', ['hello'], { json: true });
    await done;
    expect(JSON.parse(out[0] ?? '{}')).toHaveProperty('provider', 'groq');
  });

  test('renders the provider and latency under the cleaned text', () => {
    expect(renderEnhancement(result)).toBe('Never install at the repository root.\n— groq/llama-3.3-70b in 320ms');
  });
});
