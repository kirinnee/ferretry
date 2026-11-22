/**
 * `fy render check <file|->` (r12 H6): the doccheck an agent can run on a message BEFORE sending it. Nothing runs it
 * automatically. It prints one `line N: message` per problem Durian's `check` finds plus the problems of every
 * `fy-render` fence, and exits 1 on any error, 0 otherwise.
 */
import { describe, expect, test } from 'bun:test';
import { MESSAGE_LIMITS } from '../../../app/hypermedia/limits.ts';
import { checkMessage, findingLine } from '../../../cli/reading/check.ts';
import { readingVerbs } from '../../../cli/reading/verbs.ts';

/** Durian's own hostile fixture, shipped inside the package (`fixtures/hostile/`): a fence that never closes. */
const HOSTILE_13 = await Bun.file(
  new URL('../fixtures/hostile/13-unclosed-fence.dh.md', import.meta.resolve('durian-hypermedia')),
).text();

const FENCE = '```';

const harness = (files: Record<string, string>) => {
  const out: string[] = [];
  const err: string[] = [];
  const read: string[] = [];
  const verbs = readingVerbs({
    client: { call: (async () => undefined) as never, subscribe: () => () => undefined },
    io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text), isTty: false },
    readText: async (path: string) => {
      read.push(path);
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
  } as never);
  const check = (args: string[]) => verbs['render check']({ args, options: {} } as never);
  return { check, out, err, read };
};

describe('fy render check', () => {
  test('Durian hostile/13 (a fence that never closes) exits 1 printing `line N:`', async () => {
    const { check, out } = harness({ 'hostile-13.md': HOSTILE_13 });
    expect(await check(['hostile-13.md'])).toBe(1);
    const printed = out.join('');
    expect(printed).toMatch(/^line \d+: /mu);
    expect(printed).toContain('line 8: a code fence is never closed');
  });

  test('a clean message exits 0 and says so', async () => {
    const { check, out, err } = harness({
      'ok.md': `# Plan\n\nRun it:\n\n${FENCE}terminal\n$ fy status\n${FENCE}\n\nSee @src/api.ts and &F12.\n`,
    });
    expect(await check(['ok.md'])).toBe(0);
    expect(out.join('')).toContain('no problems');
    expect(err.join('')).toBe('');
  });

  test('`-` reads standard input through the shell, and a missing argument is a usage error', async () => {
    const { check, read, err } = harness({ '-': `${FENCE}chart\nkind: bar\n${FENCE}\n` });
    expect(await check(['-'])).toBe(1);
    expect(read).toEqual(['-']);
    expect(await check([])).toBe(2);
    expect(err.join('')).toContain('fy render check <file|->');
  });

  test('a file that cannot be read is a usage error (2), never "problems found" (1)', async () => {
    const { check, err } = harness({});
    expect(await check(['nope.md'])).toBe(2);
    expect(err.join('')).toContain('nope.md');
  });

  test('the check reads a message with the size cap the app reads it with (one number, two halves)', () => {
    const cap = MESSAGE_LIMITS.maxInputBytes;
    expect(checkMessage('a'.repeat(cap))).toEqual([]);
    const over = checkMessage('a'.repeat(cap + 1));
    expect(over).toHaveLength(1);
    expect(over[0]?.level).toBe('error');
  });

  test('a front matter block is Markdown the reader sees, so it is not a problem (chat has none)', () => {
    expect(checkMessage('---\nk: v\n---\n\nhello\n')).toEqual([]);
  });
});

describe('fy render check: fy-render fences (our host block)', () => {
  const block = (...lines: string[]) => [`${FENCE}fy-render`, ...lines, FENCE].join('\n');

  test('a good block draws no problem', () => {
    expect(checkMessage(block('type: mermaid', 'alt: Request flow', '---', 'flowchart TB', '  A --> B'))).toEqual([]);
  });

  test('a block with no alt says which line and why: it would render as a plain code fence', () => {
    const text = `Intro\n\n${block('type: mermaid', '---', 'flowchart TB')}\n`;
    const found = checkMessage(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 3, level: 'error' });
    expect(found[0]?.message).toContain('Missing required alt header');
    expect(findingLine(found[0] as never)).toMatch(/^line 3: /u);
  });

  test('a missing --- boundary, an unknown type and an oversize payload are each an error on the fence', () => {
    expect(checkMessage(block('type: mermaid', 'alt: x', 'flowchart TB'))[0]?.message).toContain('--- boundary');
    expect(checkMessage(block('type: hologram', 'alt: x', '---', 'x'))[0]?.message).toContain('Unknown fy-render type');
    const huge = 'A'.repeat(20_001);
    expect(checkMessage(block('type: mermaid', 'alt: x', '---', huge))[0]?.message).toContain('20,000');
  });

  test('an svg that carries a script is refused with the sink’s own reason', () => {
    const found = checkMessage(block('type: svg', 'alt: x', '---', '<svg viewBox="0 0 1 1"><script>1</script></svg>'));
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('error');
  });

  test('an info string with attributes is plain code, said as a warning that does not fail the check', () => {
    const found = checkMessage(`${FENCE}fy-render notes\ntype: mermaid\n${FENCE}\n`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 1, level: 'warn' });
    expect(found[0]?.message).toContain('plain code');
  });

  test('a fence inside another fence is an example, not a block', () => {
    const text = `\`\`\`\`markdown\n${block('type: mermaid', '---', 'x')}\n\`\`\`\`\n`;
    expect(checkMessage(text)).toEqual([]);
  });

  test('warnings alone leave the exit code 0 and are still printed', async () => {
    const { check, out } = harness({ 'w.md': `${FENCE}fy-render notes\nx\n${FENCE}\n` });
    expect(await check(['w.md'])).toBe(0);
    expect(out.join('')).toContain('line 1: warning:');
  });
});
