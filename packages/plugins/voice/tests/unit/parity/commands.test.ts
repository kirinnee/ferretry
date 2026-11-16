/** The Voice-owned V rows of docs/design/rebuild-parity.tsv, each named by its id: `fy stt …` is `fy voice …` (§1.4). */
import { describe, expect, test } from 'bun:test';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

const result = {
  text: 'Never install at the repository root.',
  provider: 'groq',
  model: 'llama-3.3-70b',
  latencyMs: 320,
};

async function run(verb: 'voice' | 'voice enhance', args: string[]) {
  const calls: { route: string; body: unknown }[] = [];
  const out: string[] = [];
  const half = cli.build?.({
    manifest,
    client: {
      call: async (route: string, init?: { body?: unknown }) => {
        calls.push({ route, body: init?.body });
        return result;
      },
      subscribe: () => () => undefined,
    } as never,
    io: { out: text => out.push(text), err: () => undefined, isTty: false },
  });
  const code = await half?.verbs[verb === 'voice' ? 'voice [text...]' : verb]({ args, options: {} });
  return { code, calls, out: out.join('') };
}

describe('fy voice', () => {
  test('V-0453 bare fy stt is fy voice: it cleans up the text it is given', async () => {
    expect(manifest.actions.cli.map(entry => entry.verb)).toContain('voice [text...]');
    const answered = await run('voice', ['helo', 'wold']);
    expect(answered.code).toBe(0);
    expect(answered.calls[0]?.route).toBe('POST /v1/stt/enhance');
    expect(answered.out).toContain('Never install at the repository root.');
  });

  test('V-0454 fy stt enhance <text...> is fy voice enhance <text...>', async () => {
    const answered = await run('voice enhance', ['helo', 'wold']);
    expect(answered.code).toBe(0);
    expect(answered.calls[0]).toMatchObject({ route: 'POST /v1/stt/enhance', body: { text: 'helo wold' } });
  });
});
