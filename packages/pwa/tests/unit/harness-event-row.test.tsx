import { describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import { HarnessEventRow } from '../../src/components/harness-event-row.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { classifySystemText, type SystemBlockInfo } from '../../src/lib/system-blocks.ts';
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

const codeBlocks = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(node => typeof node.props.code === 'string' && typeof node.type !== 'string');

const block = (text: string): SystemBlockInfo => {
  const info = classifySystemText(text);
  if (info === null) throw new Error('fixture is not a system block');
  return info;
};

// A real Claude Code notification (session path genericised), XML escapes and all.
const COMPLETED = block(`<task-notification>
<task-id>bdwjs9ydf</task-id>
<tool-use-id>toolu_017HQfBCqvcdsLc218BNK2Nr</tool-use-id>
<output-file>/tmp/claude-1000/project/session/tasks/bdwjs9ydf.output</output-file>
<status>completed</status>
<summary>Background command "direnv exec . task setup &gt; /tmp/setup.log 2&gt;&amp;1" completed (exit code 0)</summary>
</task-notification>`);

const FAILED_AGENT = block(`<task-notification>
<task-id>a1</task-id>
<status>failed</status>
<summary>Agent "Pair a phone" failed: Agent terminated early due to an API error</summary>
</task-notification>`);

const MONITOR_STOPPED = block(`<task-notification>
<task-id>bm1</task-id>
<status>stopped</status>
<summary>Monitor "watch the deploy" stopped</summary>
</task-notification>`);

const rhythm = { 'data-transcript-density': 'chrome' };

describe('HarnessEventRow', () => {
  test('reads a finished background command as one quiet line with its exit code', () => {
    const view = render(<HarnessEventRow event={COMPLETED} rhythm={rhythm} />);
    expect(textOf(view)).toBe('Background command finisheddirenv exec . task setup > /tmp/setup.log 2>&1exit 0');
    const root = view.root.findByProps({ 'data-transcript-kind': 'system' });
    expect(root.props.role).toBe('note');
    expect(root.props['data-harness-event']).toBe('task notification');
    expect(root.props['data-transcript-density']).toBe('chrome');
    expect(view.root.findByProps({ 'data-event-tone': 'ok' })).toBeDefined();
    expect(iconsOf(view)).toEqual(['lucide-cog', 'lucide-chevron-right']);
  });

  test('opens to the whole command and the output file as text, never a link', async () => {
    const view = render(<HarnessEventRow event={COMPLETED} rhythm={rhythm} />);
    const toggle = view.root.findByType('button');
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(codeBlocks(view)).toHaveLength(0);
    await run(() => toggle.props.onClick());
    expect(view.root.findByType('button').props['aria-expanded']).toBe(true);
    expect(codeBlocks(view).map(node => node.props.code)).toEqual(['direnv exec . task setup > /tmp/setup.log 2>&1']);
    expect(textOf(view)).toContain('Output file /tmp/claude-1000/project/session/tasks/bdwjs9ydf.output');
    expect(view.root.findAllByType('a')).toHaveLength(0);
  });

  test('a failure reads in the error tone and opens to its reason', async () => {
    const view = render(<HarnessEventRow event={FAILED_AGENT} rhythm={rhythm} />);
    expect(textOf(view)).toBe('Subagent failedPair a phone');
    expect(view.root.findByProps({ 'data-event-tone': 'err' })).toBeDefined();
    expect(iconsOf(view)).toEqual(['lucide-cog', 'lucide-triangle-alert', 'lucide-chevron-right']);
    await run(() => view.root.findByType('button').props.onClick());
    expect(codeBlocks(view).map(node => [node.props.code, node.props.tone])).toEqual([
      ['Agent terminated early due to an API error', 'err'],
    ]);
  });

  test('a task with nothing more to show is a plain line', () => {
    const view = render(<HarnessEventRow event={MONITOR_STOPPED} rhythm={rhythm} />);
    expect(textOf(view)).toBe('Monitor stoppedwatch the deploy');
    expect(view.root.findAllByType('button')).toHaveLength(0);
    expect(iconsOf(view)).toEqual(['lucide-cog']);
  });

  test('a record carrying several notifications is one line per task', () => {
    const both = block(
      `${'<task-notification>\n<status>stopped</status>\n<summary>Monitor "a" stopped</summary>\n</task-notification>'}\n${'<task-notification>\n<status>stopped</status>\n<summary>Monitor "b" stopped</summary>\n</task-notification>'}`,
    );
    const view = render(<HarnessEventRow event={both} rhythm={rhythm} />);
    expect(textOf(view)).toBe('Monitor stoppedaMonitor stoppedb');
  });

  test('another harness block is its heading and summary, opening to the raw text', async () => {
    const interrupted = block('[Request interrupted by user]');
    const view = render(<HarnessEventRow event={interrupted} rhythm={rhythm} />);
    expect(textOf(view)).toBe('Interrupted[Request interrupted by user]');
    expect(view.root.findByProps({ 'data-event-tone': 'warn' })).toBeDefined();
    await run(() => view.root.findByType('button').props.onClick());
    expect(codeBlocks(view).map(node => node.props.code)).toEqual(['[Request interrupted by user]']);
  });

  test("a subagent's message wears the agent icon", () => {
    const message = block('Another Claude session sent a message:\n<agent-message from="a1">\nDone.\n</agent-message>');
    const view = render(<HarnessEventRow event={message} rhythm={rhythm} />);
    expect(textOf(view)).toBe('Agent messageDone.');
    expect(iconsOf(view)).toEqual(['lucide-bot', 'lucide-chevron-right']);
  });

  test('a block with no summary is just its heading', () => {
    const view = render(
      <HarnessEventRow event={{ label: 'environment_context', raw: '<environment_context/>' }} rhythm={rhythm} />,
    );
    expect(textOf(view)).toBe('environment_context');
  });
});

describe('TranscriptRow · harness events', () => {
  test('a system row carrying a harness event renders as the event, never a bubble', () => {
    const view = render(<TranscriptRow entry={{ id: 'e1', kind: 'system', text: 'x', event: COMPLETED }} />);
    expect(view.root.findAllByProps({ 'data-harness-event': 'task notification' }).length).toBeGreaterThan(0);
    expect(view.root.findAllByProps({ 'data-transcript-kind': 'user' })).toHaveLength(0);
    expect(textOf(view)).not.toContain('Ferretry');
  });
});
