import { describe, expect, test } from 'bun:test';
import { Transcript } from '../../src/components/transcript.tsx';
import { detailsLabel, type TranscriptEntry, transcriptItems } from '../../src/lib/session-screens.ts';
import '../support/dom.ts';
import { render, run } from '../support/react.ts';

const entries: readonly TranscriptEntry[] = [
  { id: 'u1', kind: 'user', text: 'where are you?' },
  { id: 'd1', kind: 'notice', text: 'reasoning', label: 'Reasoning', detail: true },
  { id: 'd2', kind: 'notice', text: 'in=2 out=300', label: 'Usage', detail: true },
  { id: 'a1', kind: 'assistant', text: 'In the repo.' },
  { id: 'd3', kind: 'notice', text: 'completed', label: 'System', detail: true },
];

describe('transcriptItems', () => {
  test('folds each run of detail rows into one item and keeps the visible rhythm', () => {
    const items = transcriptItems(entries);
    expect(items.map(item => (item.kind === 'details' ? `details:${item.entries.length}` : item.entry.id))).toEqual([
      'u1',
      'details:2',
      'a1',
      'details:1',
    ]);
    const assistant = items[2];
    expect(assistant?.kind === 'entry' ? assistant.previous?.id : undefined).toBe('u1');
    expect(items[1]?.kind === 'details' ? items[1].id : '').toBe('details:d1');
  });

  test('counts in words', () => {
    expect(detailsLabel(1)).toBe('1 system event');
    expect(detailsLabel(2)).toBe('2 system events');
  });
});

describe('Transcript details', () => {
  test('hides bookkeeping behind a toggle that opens and closes one run', () => {
    const view = render(<Transcript daemonId="d" entries={entries} sessionId="s" />);
    const toggles = () => view.root.findAll(node => node.type === 'button' && node.props['aria-expanded'] !== undefined);
    expect(toggles().map(button => button.children.join(''))).toEqual([
      'Show details (2 system events)',
      'Show details (1 system event)',
    ]);
    run(() => toggles()[0]?.props.onClick());
    expect(toggles()[0]?.children.join('')).toBe('Hide details');
    expect(view.root.findAll(node => node.type === 'li')).toHaveLength(2);
    run(() => toggles()[0]?.props.onClick());
    expect(view.root.findAll(node => node.type === 'li')).toHaveLength(0);
  });

  test('a busy session ends on the live activity line', () => {
    const view = render(
      <Transcript
        activity={{ harness: 'claude', verb: 'Pontificating…', elapsed: '4s' }}
        busy
        daemonId="d"
        entries={[]}
        sessionId="s"
      />,
    );
    expect(view.root.findByProps({ role: 'status' }).props['data-activity-harness']).toBe('claude');
  });
});
