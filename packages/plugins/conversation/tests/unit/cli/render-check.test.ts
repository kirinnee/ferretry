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
  const limits: (number | undefined)[] = [];
  const verbs = readingVerbs({
    client: { call: (async () => undefined) as never, subscribe: () => () => undefined },
    io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text), isTty: false },
    // Like the shell's reader: with a limit it hands back no more than that many bytes of the file, a byte order mark
    // kept (`plugin-host.ts`: a bounded read counts the bytes it was asked for).
    readText: async (path: string, limit?: number) => {
      read.push(path);
      limits.push(limit);
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return limit === undefined
        ? text
        : new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(text).slice(0, limit));
    },
  } as never);
  const check = (args: string[]) => verbs['render check']({ args, options: {} } as never);
  return { check, out, err, read, limits };
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

  test('the same missing-alt block is reported on the same line whatever the line ending (LF, CRLF, bare CR)', () => {
    const lines = ['intro', '', `${FENCE}fy-render`, 'type: mermaid', '---', 'flowchart TB', FENCE, ''];
    const found = (eol: string) => checkMessage(lines.join(eol)).map(each => ({ line: each.line, level: each.level }));
    expect(found('\n')).toEqual([{ line: 3, level: 'error' }]);
    expect(found('\r\n')).toEqual([{ line: 3, level: 'error' }]);
    expect(found('\r')).toEqual([{ line: 3, level: 'error' }]);
  });

  test('warnings alone leave the exit code 0 and are still printed', async () => {
    const { check, out } = harness({ 'w.md': `${FENCE}fy-render notes\nx\n${FENCE}\n` });
    expect(await check(['w.md'])).toBe(0);
    expect(out.join('')).toContain('line 1: warning:');
  });
});

describe('fy render check: input bounds', () => {
  const cap = MESSAGE_LIMITS.maxInputBytes;
  const badBlock = `${FENCE}fy-render\ntype: mermaid\n---\nflowchart TB\n${FENCE}\n`;

  test('a file and standard input are both read with a bound of one byte past the cap, never whole', async () => {
    const { check, limits } = harness({ 'a.md': 'hello\n', '-': 'hello\n' });
    await check(['a.md']);
    await check(['-']);
    expect(limits).toEqual([cap + 1, cap + 1]);
  });

  test('a message past the cap answers with the size finding alone: no host scan reports a second problem', () => {
    const found = checkMessage(`${badBlock}${'a'.repeat(cap)}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ level: 'error' });
    expect(found[0]?.message).toContain('300,000');
  });

  test('an over-cap file exits 1 with the one size line, even though only the bounded prefix was read', async () => {
    const { check, out } = harness({ 'big.md': `${badBlock}${'a'.repeat(cap * 2)}` });
    expect(await check(['big.md'])).toBe(1);
    const lines = out.join('').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^line 1: .*300,000/u);
  });

  test('a message exactly at the cap is still read and scanned', () => {
    const text = `${badBlock}${'a'.repeat(cap - badBlock.length)}`;
    expect(new TextEncoder().encode(text).length).toBe(cap);
    expect(checkMessage(text).map(found => found.message)).toEqual([expect.stringContaining('alt')]);
  });

  describe('a byte order mark (2312 L138)', () => {
    const BOM = '\u{feff}';
    const noAlt = `${FENCE}fy-render\ntype: mermaid\n---\nflowchart TB\n${FENCE}\n`;

    test('a small BOM-prefixed message whose first fence has no alt is reported on line 1, like the same text without it', () => {
      const plain = checkMessage(noAlt).map(found => ({ line: found.line, level: found.level }));
      expect(plain).toEqual([{ line: 1, level: 'error' }]);
      const marked = checkMessage(`${BOM}${noAlt}`);
      expect(marked.map(found => ({ line: found.line, level: found.level }))).toEqual(plain);
      expect(marked[0]?.message).toContain('Missing required alt header');
    });

    test('a BOM-prefixed file exits 1 and names the problem; it never answers "no problems found"', async () => {
      const { check, out } = harness({ 'bom.md': `${BOM}${noAlt}` });
      expect(await check(['bom.md'])).toBe(1);
      expect(out.join('')).toMatch(/^line 1: .*alt/u);
    });

    test('the cap counts the bytes read, the mark included: cap-2 characters behind a mark are cap+1 bytes', () => {
      const found = checkMessage(`${BOM}${'a'.repeat(cap - 2)}`);
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toContain('300,000');
      // One byte less and it is read (and clean).
      expect(checkMessage(`${BOM}${'a'.repeat(cap - 3)}`)).toEqual([]);
    });

    test('only ONE leading mark is dropped: a second one is text, and no fence is found behind it', () => {
      expect(checkMessage(`${BOM}${BOM}${noAlt}`)).toEqual([]);
    });
  });
});

describe('fy render check: terminal-safe output', () => {
  // Written as escapes in a string so no invisible character sits in this source.
  const CONTROL = new RegExp(
    '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
    'u',
  );

  test('control bytes from the message never reach the terminal: they are shown as escapes', async () => {
    const hostile = `${FENCE}fy-render \u001b]0;pwned\u0007 \u001b[2J\u009b31m ‮\n---\n${FENCE}\n`;
    const { check, out } = harness({ 'h.md': hostile });
    await check(['h.md']);
    const printed = out.join('').replace(/\n$/u, '');
    expect(CONTROL.test(printed)).toBe(false);
    expect(printed).toContain('\\u{1b}');
  });

  test('a finding message is bounded: a long info string is clipped with an ellipsis', () => {
    const line = findingLine({ line: 1, level: 'warn', message: `x${'y'.repeat(5_000)}` });
    expect(line.length).toBeLessThan(400);
    expect(line.endsWith('…')).toBe(true);
  });

  test('a path with control bytes is escaped in the cannot-read error, which stays one short line', async () => {
    const { check, err } = harness({});
    expect(await check([`bad\u001b[2Jname${'z'.repeat(2_000)}`])).toBe(2);
    const said = err.join('');
    expect(CONTROL.test(said.replace(/\n$/u, ''))).toBe(false);
    expect(said).toContain('\\u{1b}');
    expect(said.length).toBeLessThan(400);
  });
});
