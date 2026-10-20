import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Transcript } from '../../src/components/transcript.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import {
  type AgentRunMark,
  agentRuns,
  RUN_GAP_MS,
  type TranscriptEntry,
  transcriptItems,
} from '../../src/lib/session-screens.ts';
import { render as mount, run } from '../support/react.ts';

// An unmounted tree is a subscriber the transcript-hold gate no longer counts; a leaked one starves later suites.
const mounted: ReactTestRenderer[] = [];
const render = (element: ReactElement): ReactTestRenderer => {
  const tree = mount(element);
  mounted.push(tree);
  return tree;
};
afterEach(() => {
  for (const tree of mounted.splice(0)) run(() => tree.unmount());
});

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const assistant = (id: string, at: number | null = T0): TranscriptEntry => ({
  id,
  kind: 'assistant',
  text: `text ${id}`,
  ...(at === null ? {} : { at }),
});
const tools = (id: string): TranscriptEntry => ({
  id,
  kind: 'tool',
  text: 'ran',
  tools: [{ key: id, use: { name: 'Bash', input: { command: 'ls' } }, result: { text: '' } }],
});
const owner = (id: string): TranscriptEntry => ({ id, kind: 'user', text: 'hi' });
const peer = (id: string): TranscriptEntry => ({
  ...owner(id),
  peer: { name: 'torrey', sessionId: 's', kind: 'message', replyExpected: false, note: '' },
});
const system = (id: string): TranscriptEntry => ({ id, kind: 'system', text: 'Ferretry says' });
const command = (id: string): TranscriptEntry => ({ id, kind: 'command', text: '/model' });
const sentCard = (id: string): TranscriptEntry => ({ ...tools(id), sent: {} as never });
const packCard = (id: string): TranscriptEntry => ({ ...tools(id), pack: {} as never });
const hiddenNotice = (id: string): TranscriptEntry => ({ id, kind: 'notice', text: 'bookkeeping' });

const runsOf = (...entries: TranscriptEntry[]): (string | undefined)[] =>
  agentRuns(transcriptItems(entries)).map((mark: AgentRunMark | undefined) =>
    mark === undefined ? undefined : `${mark.role}${mark.end ? '$' : ''}`,
  );

describe('agentRuns', () => {
  test('names the agent once and marks the last text of a run as its end', () => {
    expect(runsOf(assistant('a'), assistant('b'), assistant('c'))).toEqual(['start', 'continue', 'continue$']);
    expect(runsOf(assistant('a'))).toEqual(['start$']);
  });

  test('tool rows between and after texts fold into the run without breaking it', () => {
    expect(
      runsOf(assistant('a'), tools('t1'), assistant('b'), tools('t2'), tools('t3'), assistant('c'), tools('t4')),
    ).toEqual(['start', undefined, 'continue', undefined, undefined, 'continue$', undefined]);
  });

  test('tools that open the transcript do not start a run, so the first text still names the agent', () => {
    expect(runsOf(tools('t0'), assistant('a'), assistant('b'))).toEqual([undefined, 'start', 'continue$']);
  });

  test('every non-agent row closes the run, so the agent is named again after it', () => {
    for (const between of [owner('x'), peer('x'), system('x'), command('x'), sentCard('x'), packCard('x')])
      expect(runsOf(assistant('a'), between, assistant('b'))).toEqual(['start$', undefined, 'start$']);
  });

  test('a tool row inside a run does not hide a later closer', () => {
    expect(runsOf(assistant('a'), tools('t'), owner('x'), tools('t2'), assistant('b'))).toEqual([
      'start$',
      undefined,
      undefined,
      undefined,
      'start$',
    ]);
  });

  test('a hidden daemon notice is not a row, so it neither breaks nor joins a run', () => {
    expect(runsOf(assistant('a'), hiddenNotice('n'), assistant('b'))).toEqual(['start', 'continue$']);
  });

  test('a gap longer than ten minutes starts a new run; exactly ten minutes does not', () => {
    expect(runsOf(assistant('a'), assistant('b', T0 + RUN_GAP_MS))).toEqual(['start', 'continue$']);
    expect(runsOf(assistant('a'), assistant('b', T0 + RUN_GAP_MS + 1), assistant('c', T0 + RUN_GAP_MS + 2))).toEqual([
      'start$',
      'start',
      'continue$',
    ]);
  });

  test('the gap is measured from the last text, and an untimed row never creates one', () => {
    expect(runsOf(assistant('a'), tools('t'), assistant('b', T0 + RUN_GAP_MS + 1))).toEqual([
      'start$',
      undefined,
      'start$',
    ]);
    expect(runsOf(assistant('a', null), assistant('b', T0 + 99 * RUN_GAP_MS))).toEqual(['start', 'continue$']);
    expect(runsOf(assistant('a'), assistant('b', null), assistant('c', T0 + RUN_GAP_MS + 1))).toEqual([
      'start',
      'continue$',
      'start$',
    ]);
  });
});

describe('a run of agent output as rows', () => {
  const shown = (entry: TranscriptEntry, run?: AgentRunMark) =>
    render(<TranscriptRow entry={{ ...entry, label: 'Gasper' }} run={run} />);

  test('a start names the agent visibly and its time is always shown', () => {
    const row = shown(assistant('a'), { role: 'start', end: true });
    expect(row.root.findByType('header').props.className).toBeUndefined();
    expect(row.root.findAllByProps({ className: 'fy-run-time' })).toHaveLength(0);
    expect(row.root.findByProps({ 'data-transcript-kind': 'assistant' }).props['data-transcript-run']).toBe('start');
  });

  test('a continuation keeps the name for a screen reader and tucks its time away unless it ends the run', () => {
    const middle = shown(assistant('b'), { role: 'continue', end: false });
    expect(middle.root.findByType('header').props.className).toBe('sr-only');
    expect(middle.root.findAllByProps({ className: 'fy-run-time' })).toHaveLength(1);
    const last = shown(assistant('c'), { role: 'continue', end: true });
    expect(last.root.findByType('header').props.className).toBe('sr-only');
    expect(last.root.findAllByProps({ className: 'fy-run-time' })).toHaveLength(0);
  });

  test('a row with no run mark renders as before', () => {
    const row = shown(assistant('a'));
    expect(row.root.findByType('header').props.className).toBeUndefined();
    expect(row.root.findByProps({ 'data-transcript-kind': 'assistant' }).props['data-transcript-run']).toBeUndefined();
  });

  test('the transcript hands each text its mark, naming the agent only at the start of a run', () => {
    const view = render(
      <Transcript
        agentName="Gasper"
        daemonId="d"
        entries={[assistant('a'), tools('t'), assistant('b'), owner('o'), assistant('c')]}
        sessionId="s"
      />,
    );
    const roles = view.root
      .findAllByProps({ 'data-transcript-kind': 'assistant' })
      .map(node => node.props['data-transcript-run']);
    expect(roles).toEqual(['start', 'continue', 'start']);
    expect(view.root.findAllByProps({ className: 'sr-only' }).filter(node => node.type === 'header')).toHaveLength(1);
  });
});
