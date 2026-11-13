import { describe, expect, it } from 'bun:test';
import { epochMs, instantFromEpochMs, type Instant } from '@ferretry/std';
import type { FerretId, FerretRecord, SitrepLine } from '../../../../../contract/index.ts';
import { FerretRegistry } from '../../../../../daemon/lib/registry/registry.ts';
import {
  EXCERPT_WITHHELD,
  oneLine,
  SUBTREE_ENDED_WINDOW_MS,
  SUBTREE_LAST_LINE_MAX,
  type SubtreePorts,
  SubtreeService,
  subtreeMembers,
} from '../../../../../daemon/lib/session/pack/subtree.ts';
import { mapBounded } from '../../../../../daemon/lib/session/pack/bounded.ts';

const NOW = epochMs('2026-11-07T12:00:00.000Z' as Instant);
const at = (minutesAgo: number): Instant => instantFromEpochMs(NOW - minutesAgo * 60_000);

const ferret = (
  id: string,
  options: {
    readonly parent?: string;
    readonly name?: string;
    readonly state?: FerretRecord['state'];
    readonly stateAt?: Instant;
  } = {},
): FerretRecord => ({
  format: 1,
  id: id as FerretId,
  name: options.name ?? id,
  ...(options.parent === undefined ? {} : { parent: options.parent as FerretId }),
  role: options.parent === undefined ? 'lead' : 'helper',
  harness: 'claude-code',
  runner: 'tmux',
  folder: `/work/${id}`,
  state: options.state ?? 'working',
  createdAt: at(600),
  stateAt: options.stateAt ?? at(1),
});

const line = (text: string, minutesAgo: number, kind: SitrepLine['kind'] = 'note'): SitrepLine => ({
  kind,
  text,
  at: at(minutesAgo),
});

function ports(
  lines: Readonly<Record<string, readonly SitrepLine[]>>,
  overrides: Partial<SubtreePorts> = {},
): SubtreePorts & { readonly redactCalls: (readonly string[])[]; readonly reads: string[] } {
  const redactCalls: (readonly string[])[] = [];
  const reads: string[] = [];
  return {
    redactCalls,
    reads,
    lines: async id => {
      reads.push(id);
      return lines[id] ?? [];
    },
    redact: async texts => {
      redactCalls.push(texts);
      return texts.map(text => text.replaceAll('hunter2', '*******'));
    },
    nowMs: () => NOW,
    ...overrides,
  };
}

describe('subtree members', () => {
  it('should list descendants nested by depth, a ferret directly before its own helpers, siblings by name', () => {
    const registry = new FerretRegistry([
      ferret('root'),
      ferret('b', { parent: 'root', name: 'bravo' }),
      ferret('a', { parent: 'root', name: 'alpha' }),
      ferret('a1', { parent: 'a', name: 'zulu' }),
    ]);
    const members = subtreeMembers(registry, 'root' as FerretId, NOW);
    expect(members.map(member => [String(member.ferret.id), member.depth])).toEqual([
      ['a', 1],
      ['a1', 2],
      ['b', 1],
    ]);
  });

  it('should keep a ferret stopped inside the window and drop one stopped before it', () => {
    const registry = new FerretRegistry([
      ferret('root'),
      ferret('recent', { parent: 'root', state: 'stopped', stateAt: at(30) }),
      ferret('old', {
        parent: 'root',
        state: 'stopped',
        stateAt: instantFromEpochMs(NOW - SUBTREE_ENDED_WINDOW_MS - 1),
      }),
    ]);
    expect(subtreeMembers(registry, 'root' as FerretId, NOW).map(member => String(member.ferret.id))).toEqual([
      'recent',
    ]);
  });

  it('G24 lineage comes from the registry’s parent links: a cycle terminates and the root is not a row', () => {
    const registry = new FerretRegistry([ferret('x', { parent: 'y' }), ferret('y', { parent: 'x' })]);
    expect(subtreeMembers(registry, 'x' as FerretId, NOW).map(member => String(member.ferret.id))).toEqual(['y']);
  });
});

describe('one line', () => {
  it('should take the first non-blank line, collapse whitespace and cut a long one with an ellipsis', () => {
    expect(oneLine('\n\n  hello   there \nsecond')).toBe('hello there');
    const long = oneLine('x'.repeat(SUBTREE_LAST_LINE_MAX + 20));
    expect([...long].length).toBe(SUBTREE_LAST_LINE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the subtree table', () => {
  it('should build one row per descendant with its newest dated line', async () => {
    const registry = new FerretRegistry([ferret('root'), ferret('a', { parent: 'root' })]);
    const view = await new SubtreeService(
      registry,
      ports({ a: [line('older', 10), line('newest\nmore', 2, 'card'), { kind: 'doing', text: 'undated' }] }),
    ).view('root' as FerretId);
    expect(view?.rows).toEqual([
      expect.objectContaining({
        id: 'a',
        depth: 1,
        state: 'running',
        last: { at: at(2), kind: 'card', text: 'newest' },
      }),
    ]);
  });

  it('should answer undefined for a ferret the registry does not hold', async () => {
    expect(await new SubtreeService(new FerretRegistry(), ports({})).view('nobody' as FerretId)).toBeUndefined();
  });

  it('G24 an excerpt is masked by the secret redactor before it is cut', async () => {
    const registry = new FerretRegistry([ferret('root'), ferret('a', { parent: 'root' })]);
    const subject = ports({ a: [line('the password is hunter2', 1)] });
    const view = await new SubtreeService(registry, subject).view('root' as FerretId);
    expect(view?.rows[0]?.last?.text).toBe('the password is *******');
    expect(subject.redactCalls).toEqual([['the password is hunter2']]);
  });

  it('G24 a secret straddling the cut-off is masked whole, because redaction runs on the full text first', async () => {
    const registry = new FerretRegistry([ferret('root'), ferret('a', { parent: 'root' })]);
    const text = `${'x'.repeat(SUBTREE_LAST_LINE_MAX - 4)}hunter2`;
    const view = await new SubtreeService(registry, ports({ a: [line(text, 1)] })).view('root' as FerretId);
    expect(view?.rows[0]?.last?.text).not.toContain('hunt');
  });

  it('G24 the redactor runs once for the whole table', async () => {
    const registry = new FerretRegistry([
      ferret('root'),
      ferret('a', { parent: 'root' }),
      ferret('b', { parent: 'root' }),
    ]);
    const subject = ports({ a: [line('one', 1)], b: [line('two', 1)] });
    await new SubtreeService(registry, subject).view('root' as FerretId);
    expect(subject.redactCalls).toHaveLength(1);
  });

  it('G24 shows [excerpt withheld], never the raw text, when the redactor cannot run', async () => {
    const registry = new FerretRegistry([ferret('root'), ferret('a', { parent: 'root' })]);
    const view = await new SubtreeService(
      registry,
      ports(
        { a: [line('the password is hunter2', 1)] },
        {
          redact: async () => {
            throw new Error('vault will not open');
          },
        },
      ),
    ).view('root' as FerretId);
    expect(view?.rows[0]?.last?.text).toBe(EXCERPT_WITHHELD);
    expect(JSON.stringify(view)).not.toContain('hunter2');
  });

  it('G24 withholds when the redactor answers the wrong number of texts', async () => {
    const registry = new FerretRegistry([ferret('root'), ferret('a', { parent: 'root' })]);
    const view = await new SubtreeService(registry, ports({ a: [line('secret', 1)] }, { redact: async () => [] })).view(
      'root' as FerretId,
    );
    expect(view?.rows[0]?.last?.text).toBe(EXCERPT_WITHHELD);
  });

  it('G24 the line lookups are bounded: never more in flight than the limit, and rows past the budget get none', async () => {
    const helpers = Array.from({ length: 12 }, (_, index) =>
      ferret(`h${String(index).padStart(2, '0')}`, { parent: 'root' }),
    );
    const registry = new FerretRegistry([ferret('root'), ...helpers]);
    let inFlight = 0;
    let peak = 0;
    const subject = ports(
      {},
      {
        lines: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return [line('hi', 1)];
        },
      },
    );
    const view = await new SubtreeService(registry, subject, { concurrency: 3, excerptRows: 5, endedRows: 1 }).view(
      'root' as FerretId,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(view?.rows.filter(row => row.last !== undefined)).toHaveLength(5);
    expect(view?.rows).toHaveLength(12);
  });

  it('should list a row whose lookup fails, without an excerpt, rather than fail the table', async () => {
    const registry = new FerretRegistry([ferret('root'), ferret('a', { parent: 'root' })]);
    const view = await new SubtreeService(
      registry,
      ports(
        {},
        {
          lines: async () => {
            throw new Error('gone');
          },
        },
      ),
    ).view('root' as FerretId);
    expect(view?.rows).toEqual([expect.objectContaining({ id: 'a' })]);
    expect(view?.rows[0]?.last).toBeUndefined();
  });
});

describe('bounded map', () => {
  it('should keep results in item order and never exceed the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapBounded([1, 2, 3, 4, 5], 2, async value => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
