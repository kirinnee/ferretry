import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { CodeBlock } from '../../src/components/code-block.tsx';
import { bodyLanguage, elapsedLabel, summarizeToolRun, ToolGroup } from '../../src/components/tool-group.tsx';
import { extractToolSummary } from '../../src/lib/tool-extract.ts';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { selectionHeld, transcriptHeldStill, useLiveClock } from '../../src/hooks/use-live-clock.ts';
import type { ToolCall } from '../../src/lib/session-screens.ts';
import { render, run } from '../support/react.ts';

const call = (key: string, name: string, input: unknown, overrides: Partial<ToolCall> = {}): ToolCall => ({
  key,
  use: { name, input },
  ...overrides,
});

/** Every rendered string, concatenated — what a reader actually sees. */
const textOf = (renderer: ReactTestRenderer): string => {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join('');
    if (node !== null && typeof node === 'object' && 'children' in node) {
      return walk((node as { children: unknown }).children);
    }
    return '';
  };
  return walk(renderer.toJSON());
};

const labelOf = (node: ReactTestInstance): string => node.children.filter(child => typeof child === 'string').join('');

/** The lucide icons a tree rendered, by name — the status glyphs are part of
 *  the reading, not decoration. */
const iconsOf = (renderer: ReactTestRenderer): readonly string[] =>
  renderer.root.findAllByType('svg').flatMap(node => String(node.props.className ?? '').match(/lucide-[a-z-]+/g) ?? []);

const html = (instance: ReactTestInstance): string => String(instance.props.dangerouslySetInnerHTML.__html);

/** The rendered code with highlight markup removed — the text on screen. */
const plain = (instance: ReactTestInstance): string =>
  html(instance)
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

describe('summarizeToolRun', () => {
  test('counts repeated verbs in the order they ran and names an orphan result', () => {
    const summary = summarizeToolRun([
      call('a', 'Bash', { command: 'bun test' }),
      call('b', 'edit', { file_path: 'a.ts', new_string: 'x' }),
      call('c', 'edit', { file_path: 'b.ts', new_string: 'y' }),
      call('d', 'read', { file_path: 'c.ts' }),
      call('e', '', undefined, { orphanResult: true, result: { text: 'stray' } }),
    ]);

    expect(summary).toBe('Bash, Edit ×2, Read, result');
  });
});

describe('elapsedLabel', () => {
  test('reads seconds under a minute and minutes above it', () => {
    expect(elapsedLabel('1970-01-01T00:00:00.000Z', 34_000)).toBe('34s');
    expect(elapsedLabel('1970-01-01T00:00:00.000Z', 95_000)).toBe('1m 35s');
  });

  test('answers nothing rather than a wrong duration', () => {
    expect(elapsedLabel(undefined, 1_000)).toBeUndefined();
    expect(elapsedLabel('not a date', 1_000)).toBeUndefined();
  });

  test('never counts backwards when a call claims to start in the future', () => {
    expect(elapsedLabel('1970-01-01T00:01:00.000Z', 0)).toBe('0s');
  });
});

describe('CodeBlock', () => {
  test('highlights a known language and escapes the source it tokenizes', () => {
    const block = render(<CodeBlock code={'const x = "<img src=x>";'} lang="typescript" />);
    const code = block.root.findByType('code');

    expect(html(code)).toContain('hljs-keyword');
    expect(html(code)).toContain('&lt;img');
    expect(html(code)).not.toContain('<img');
  });

  test('escapes an unknown language rather than inserting it as markup', () => {
    const block = render(<CodeBlock code={'<script>alert(1)</script>'} />);

    expect(html(block.root.findByType('code'))).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('never tokenizes an error body and carries the error tone', () => {
    const block = render(<CodeBlock code={'error: <fail>'} lang="typescript" tone="err" />);

    expect(html(block.root.findByType('code'))).toBe('error: &lt;fail&gt;');
    expect(block.root.findByType('pre').props.className).toContain('border-err-border');
  });

  test('opens a long body only when the reader asks, and closes again', () => {
    const code = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const block = render(<CodeBlock code={code} />);
    const toggle = block.root.findByType('button');

    expect(labelOf(toggle)).toContain('show 4 more lines');
    expect(html(block.root.findByType('code'))).not.toContain('line 19');

    run(() => toggle.props.onClick());
    expect(html(block.root.findByType('code'))).toContain('line 19');
    expect(labelOf(block.root.findByType('button'))).toContain('show less');

    run(() => block.root.findByType('button').props.onClick());
    expect(html(block.root.findByType('code'))).not.toContain('line 19');
  });

  test('leaves a short body without a toggle at all', () => {
    const block = render(<CodeBlock code="one\ntwo" />);

    expect(block.root.findAllByType('button')).toHaveLength(0);
  });
});

describe('ToolGroup', () => {
  test('renders a single finished call as its own line, with no group wrapper', () => {
    const group = render(
      <ToolGroup calls={[call('a', 'Bash', { command: 'bun test' })]} isLast={false} live={false} />,
    );

    expect(textOf(group)).toContain('Bash');
    expect(textOf(group)).not.toContain('tools');
  });

  test('collapses a run into one line and expands it on demand', () => {
    const group = render(
      <ToolGroup
        calls={[
          call('a', 'Bash', { command: 'bun test' }, { result: { text: 'ok' } }),
          call('b', 'read', { file_path: '/work/app.ts' }, { result: { text: 'source' } }),
          call('c', 'read', { file_path: '/work/other.ts' }, { result: { text: 'source' } }),
        ]}
        isLast
        live={false}
      />,
    );
    const summary = group.root.findAllByType('button')[0];

    expect(textOf(group)).toContain('3 tools');
    expect(textOf(group)).toContain('Bash, Read ×2');
    expect(group.root.findAllByType('button')).toHaveLength(1);

    run(() => summary?.props.onClick());
    expect(group.root.findAllByType('button').length).toBe(4);
    expect(textOf(group)).toContain('app.ts');

    run(() => group.root.findAllByType('button')[0]?.props.onClick());
    expect(group.root.findAllByType('button')).toHaveLength(1);
  });

  test('keeps a failed call visible in the collapsed summary', () => {
    const group = render(
      <ToolGroup
        calls={[
          call('a', 'Bash', { command: 'bun test' }, { result: { text: 'boom', isError: true } }),
          call('b', 'Bash', { command: 'bun run build' }, { result: { text: 'ok' } }),
        ]}
        isLast={false}
        live={false}
      />,
    );

    expect(iconsOf(group)).toContain('lucide-triangle-alert');
  });

  test('gives the running tool its own live line below the finished history', () => {
    const group = render(
      <ToolGroup
        calls={[
          call('a', 'Bash', { command: 'bun test' }, { result: { text: 'ok' } }),
          call('b', 'read', { file_path: '/work/app.ts' }, { result: { text: 'source' } }),
          call('c', 'Bash', { command: 'bun run build' }, { ts: '1970-01-01T00:00:00.000Z' }),
        ]}
        isLast
        live
      />,
    );

    expect(textOf(group)).toContain('2 tools');
    expect(group.root.findAllByProps({ className: 'kt-chrome flex items-center gap-1.5 px-2 py-px' })).toHaveLength(1);
    expect(textOf(group)).toContain('bun run build');
    group.unmount();
  });

  test('shows only the live line when nothing has finished yet', () => {
    const group = render(<ToolGroup calls={[call('a', 'Bash', { command: 'bun test' })]} isLast live />);

    expect(textOf(group)).toContain('bun test');
    expect(group.root.findAllByType('button')).toHaveLength(0);
    group.unmount();
  });

  test('drops the elapsed label rather than guessing when a running call has no start', () => {
    const group = render(<ToolGroup calls={[call('a', 'Bash', { command: 'bun test' })]} isLast live />);

    expect(textOf(group)).not.toContain('—');
    group.unmount();
  });

  test('treats a completed run as history even while the session is live', () => {
    const group = render(
      <ToolGroup calls={[call('a', 'Bash', { command: 'bun test' }, { result: { text: 'ok' } })]} isLast live />,
    );

    expect(group.root.findAllByProps({ className: 'kt-chrome flex items-center gap-1.5 px-2 py-px' })).toHaveLength(0);
  });

  test('opens a call to its input body and its result, cleaned of the codex wall-time prefix', () => {
    const group = render(
      <ToolGroup
        calls={[
          call('a', 'exec', 'cmd: "bun test"', {
            result: { text: 'Script completed\nWall time 1.5 seconds\nOutput:\nall green' },
          }),
        ]}
        isLast={false}
        live={false}
      />,
    );

    run(() => group.root.findAllByType('button')[0]?.props.onClick());
    const bodies = group.root.findAllByType('code').map(plain);

    expect(bodies[0]).toContain('bun test');
    expect(bodies[1]).toContain('all green');
    expect(bodies[1]).not.toContain('Wall time');
    expect(textOf(group)).toContain('result');
  });

  test('renders a failed result in the error tone and never highlights it', () => {
    const group = render(
      <ToolGroup
        calls={[call('a', 'read', { file_path: 'a.ts' }, { result: { text: 'no such file', isError: true } })]}
        isLast={false}
        live={false}
      />,
    );

    run(() => group.root.findAllByType('button')[0]?.props.onClick());

    expect(textOf(group)).toContain('error');
    expect(group.root.findAllByProps({ tone: 'err' }).length).toBeGreaterThan(0);
  });

  test('shows an orphan result as a result row rather than dropping it', () => {
    const group = render(
      <ToolGroup
        calls={[call('a', '', undefined, { orphanResult: true, result: { text: 'stray output' } })]}
        isLast={false}
        live={false}
      />,
    );

    expect(textOf(group)).toContain('tool result');
    run(() => group.root.findAllByType('button')[0]?.props.onClick());
    expect(html(group.root.findByType('code'))).toContain('stray output');
  });

  test('leaves a call with neither body nor result unopenable', () => {
    const group = render(<ToolGroup calls={[call('a', 'mystery', undefined)]} isLast={false} live={false} />);
    const line = group.root.findByType('button');

    expect(line.props.className).toContain('cursor-default');
    run(() => line.props.onClick());
    expect(group.root.findAllByType('code')).toHaveLength(0);
  });

  test('reads each tool kind with its own icon hue and body language', () => {
    const calls = [
      call('bash', 'Bash', { command: 'ls' }),
      call('read', 'read', { file_path: 'a.ts' }),
      call('write', 'write', { file_path: 'a.py', content: 'x = 1' }),
      call('edit', 'edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
      call('patch', 'apply_patch', '*** Begin Patch\n*** Update File: a.ts'),
      call('search', 'grep', { pattern: 'x' }),
      call('plan', 'update_plan', 'update_plan'),
      call('wait', 'wait', { cell_id: '2' }),
      call('generic', 'teleport', { prompt: 'go' }),
    ];
    const group = render(<ToolGroup calls={calls} isLast={false} live={false} />);

    run(() => group.root.findAllByType('button')[0]?.props.onClick());
    const hues = group.root
      .findAllByType('svg')
      .map(node => node.props.style?.color)
      .filter((color): color is string => typeof color === 'string');

    expect(hues).toEqual([
      'var(--tool-bash)',
      'var(--tool-read)',
      'var(--tool-write)',
      'var(--tool-edit)',
      'var(--tool-patch)',
      'var(--tool-search)',
      'var(--tool-plan)',
      'var(--tool-wait)',
      'var(--tool-generic)',
    ]);
  });

  test('picks the body language from what the tool did, not from the tool name', () => {
    expect(bodyLanguage(extractToolSummary('Bash', { command: 'ls' }))).toBe('bash');
    expect(bodyLanguage(extractToolSummary('edit', { file_path: 'a.ts', new_string: 'x' }))).toBe('diff');
    expect(bodyLanguage(extractToolSummary('apply_patch', '*** Begin Patch'))).toBe('diff');
    expect(bodyLanguage(extractToolSummary('write', { file_path: 'a.py', content: 'x = 1' }))).toBe('python');
    expect(bodyLanguage(extractToolSummary('read', { file_path: 'a.ts' }))).toBeUndefined();
  });
});

describe('TranscriptRow tool rows', () => {
  test('renders a tool row carrying calls as the collapsed group', () => {
    const row = render(
      <TranscriptRow
        entry={{
          id: 'tools-1',
          kind: 'tool',
          text: 'ran 2 tools',
          tools: [
            call('a', 'Bash', { command: 'bun test' }, { result: { text: 'ok' } }),
            call('b', 'read', { file_path: 'a.ts' }, { result: { text: 'x' } }),
          ],
        }}
        isLast
        live={false}
      />,
    );

    expect(textOf(row)).toContain('2 tools');
    expect(textOf(row)).not.toContain('ran 2 tools');
  });

  test('keeps rendering a tool row with no calls as its text line', () => {
    const row = render(<TranscriptRow entry={{ id: 'tools-2', kind: 'tool', text: 'ran a tool', tools: [] }} />);

    expect(textOf(row)).toContain('ran a tool');
  });
});

function ClockProbe({ now, intervalMs, hold }: { now: () => number; intervalMs: number; hold?: boolean }) {
  return <span>{useLiveClock({ now, intervalMs, hold })}</span>;
}

describe('useLiveClock', () => {
  test('holds only a real selected range, unless a pointer gesture is still active', () => {
    expect(selectionHeld(null)).toBeFalse();
    expect(selectionHeld({ isCollapsed: true, rangeCount: 1 })).toBeFalse();
    expect(selectionHeld({ isCollapsed: false, rangeCount: 0 })).toBeFalse();
    expect(selectionHeld({ isCollapsed: false, rangeCount: 1 })).toBeTrue();
    expect(transcriptHeldStill(true, null)).toBeTrue();
    expect(transcriptHeldStill(false, { isCollapsed: false, rangeCount: 1 })).toBeTrue();
  });

  test('advances on its interval and stops when the transcript must hold still', async () => {
    let ticks = 100;
    const now = () => {
      ticks += 10;
      return ticks;
    };

    const ticking = render(<ClockProbe intervalMs={1} now={now} />);
    const first = Number(ticking.root.findByType('span').children[0]);
    await new Promise(resolve => setTimeout(resolve, 20));
    const later = Number(ticking.root.findByType('span').children[0]);
    ticking.unmount();

    expect(later).toBeGreaterThan(first);

    const frozen = render(<ClockProbe hold intervalMs={1} now={now} />);
    const held = Number(frozen.root.findByType('span').children[0]);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(Number(frozen.root.findByType('span').children[0])).toBe(held);
    frozen.unmount();
  });
});
