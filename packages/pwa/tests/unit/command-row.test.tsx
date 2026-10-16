import { describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { CommandRow } from '../../src/components/command-row.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import type { SlashCommand } from '../../src/lib/slash-commands.ts';
import { render, run } from '../support/react.ts';

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

const iconsOf = (renderer: ReactTestRenderer): readonly string[] =>
  renderer.root.findAllByType('svg').flatMap(node => String(node.props.className ?? '').match(/lucide-[a-z-]+/g) ?? []);

/** The expanded code surface's props, found by what it was handed. */
const codeBlocks = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(node => typeof node.props.code === 'string' && typeof node.type !== 'string');

const row = (command: SlashCommand) => render(<CommandRow command={command} />);

describe('CommandRow', () => {
  test('reads as the command, its arguments and its output on one line', () => {
    const view = row({ name: '/model', args: 'opus[1m]', output: 'Set model to Opus 5.5 (1M context)', tone: 'ok' });
    expect(textOf(view)).toBe('/model opus[1m]→Set model to Opus 5.5 (1M context)');
    expect(view.root.findAllByType('button')).toHaveLength(0);
    expect(iconsOf(view)).toEqual([]);
  });

  test('a command with no arguments and no output is just the command', () => {
    const view = row({ name: '/clear', tone: 'ok' });
    expect(textOf(view)).toBe('/clear');
  });

  test('output whose command scrolled away shows on its own, with no arrow', () => {
    const view = row({ name: '', output: 'orphaned output', tone: 'ok' });
    expect(textOf(view)).toBe('orphaned output');
  });

  test('stderr keeps the error tone and the red triangle', () => {
    const view = row({ name: '/doctor', output: 'config unreadable', tone: 'err' });
    expect(view.root.findByProps({ className: 'fy-command' }).props['data-command-tone']).toBe('err');
    expect(iconsOf(view)).toContain('lucide-triangle-alert');
  });

  test('long output opens to the full text in a code surface, in the tone it was written', () => {
    const view = row({ name: '/context', output: 'Context usage\n  12k / 1M tokens', tone: 'err' });
    expect(textOf(view)).toContain('Context usage');
    expect(textOf(view)).not.toContain('12k');
    const toggle = view.root.findByType('button');
    expect(toggle.props['aria-expanded']).toBe(false);
    run(() => toggle.props.onClick());
    expect(view.root.findByType('button').props['aria-expanded']).toBe(true);
    expect(codeBlocks(view)[0]?.props).toMatchObject({
      code: 'Context usage\n  12k / 1M tokens',
      tone: 'err',
    });
    run(() => view.root.findByType('button').props.onClick());
    expect(codeBlocks(view)).toHaveLength(0);

    const ok = row({ name: '/context', output: 'a\nb', tone: 'ok' });
    run(() => ok.root.findByType('button').props.onClick());
    expect(codeBlocks(ok)[0]?.props.tone).toBe('default');
  });
});

describe('TranscriptRow for a command', () => {
  test('renders the compact command row in the chrome tier, never a "You" bubble', () => {
    const view = render(
      <TranscriptRow
        entry={{ id: 'c', kind: 'command', text: '/model opus', command: { name: '/model', args: 'opus', tone: 'ok' } }}
        previous={{ id: 'u', kind: 'user', text: 'hi' }}
      />,
    );
    const wrapper = view.root.findByProps({ 'data-transcript-kind': 'command' });
    expect(wrapper.props['data-transcript-density']).toBe('chrome');
    expect(textOf(view)).not.toContain('You');
  });

  test('a command row that lost its command still reads, labelled as a command', () => {
    const view = render(<TranscriptRow entry={{ id: 'c', kind: 'command', text: '/model' }} />);
    expect(textOf(view)).toContain('Command');
    expect(view.root.findByProps({ 'data-transcript-kind': 'command' }).props.className).toContain('fy-message-chrome');
  });
});
