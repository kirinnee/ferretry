/** r12 H1 — Durian reads YAML through our parser, with aliases off. */
import { beforeAll, describe, expect, it } from 'bun:test';
import { check, parse, VERSION } from 'durian-hypermedia';
import { configureDurian } from '../../../../app/hypermedia/durian.ts';

beforeAll(configureDurian);

describe('configureDurian', () => {
  it('is the pinned release (no later API under us)', () => {
    expect(VERSION).toBe('0.5.1');
  });

  it('reads chart data written as YAML', () => {
    const doc = parse(
      '```chart\nkind: line\nx: { label: step, values: [1, 2, 3] }\nseries:\n  - name: calls\n    data: [1, 2, 3]\n```\n',
    );
    expect(doc.blocks[0]).toMatchObject({ type: 'chart', chart: { kind: 'line' } });
    expect(check(doc).filter(p => p.level === 'error')).toEqual([]);
  });

  it('reads front matter as YAML', () => {
    const doc = parse('---\ntitle: A title\n---\n\n# Body\n');
    expect(doc.frontMatter).toEqual({ title: 'A title' });
  });

  it('refuses an alias bomb: the chart is not drawn from the expansion', () => {
    const levels = Array.from(
      { length: 9 },
      (_, i) => `l${i + 1}: &l${i + 1} [${Array.from({ length: 9 }, () => `*l${i}`).join(', ')}]`,
    );
    const doc = parse(`\`\`\`chart\nkind: line\nl0: &l0 [x, x, x, x, x, x, x, x, x]\n${levels.join('\n')}\n\`\`\`\n`);
    expect(doc.blocks[0]).not.toMatchObject({ type: 'chart', chart: { kind: 'line' } });
  });
});
