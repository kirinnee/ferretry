import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { render, run } from '../support/react.ts';

const textOf = (renderer: ReactTestRenderer): string => {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join('');
    if (node !== null && typeof node === 'object' && 'children' in node)
      return walk((node as { children: unknown }).children);
    return '';
  };
  return walk(renderer.toJSON());
};

const PEER: TranscriptEntry = {
  id: 'p1',
  kind: 'user',
  text: "Hey! How's your **day** going?",
  label: '10:01:02',
  peer: {
    name: 'torrey',
    sessionId: 'mvb0sw7d-27f71326',
    replyExpected: false,
    note: 'No reply is required; torrey has carried on.',
  },
};

const fleet = [
  { config: { id: 'mvb0sw7d-27f71326', teammate: 'torrey' }, state: { status: 'running' } },
] as unknown as SessionView[];

describe('a message from another agent', () => {
  test('reads as FROM that agent, with its name chip, a proved :reference and a Markdown body', () => {
    const navigated: string[] = [];
    const view = render(
      <ReferenceSurfaceProvider
        surface={{
          agentReferenceResolver: createAgentReferenceResolver('d1' as DaemonId, fleet),
          onNavigate: to => void navigated.push(to),
        }}
      >
        <TranscriptRow entry={PEER} />
      </ReferenceSurfaceProvider>,
    );
    const text = textOf(view);
    expect(text).not.toContain('You');
    expect(text).toContain('Torrey → sent this');
    expect(view.root.findByProps({ className: 'fy-peer-avatar' }).children).toEqual(['T']);
    // The sender is a real reference, through the one renderer, so it opens that agent's session.
    const [link] = view.root.findAllByType('a');
    expect(link?.props.href).toBe('/d/d1/session/mvb0sw7d-27f71326');
    run(() => link?.props.onClick({ preventDefault: () => undefined, button: 0 }));
    expect(navigated).toEqual(['/d/d1/session/mvb0sw7d-27f71326']);
    expect(view.root.findAllByType('strong').map(node => node.children)).toEqual([['day']]);
    // The boilerplate addressed to the agent is folded, not shown inline.
    expect(view.root.findByType('details').findByType('summary').children).toEqual(['Delivery note for the agent']);
    expect(view.root.findByProps({ 'data-transcript-kind': 'user' }).props['data-peer']).toBe('torrey');
  });

  test('says when the sender is parked on a reply, and omits an empty note', () => {
    const view = render(
      <TranscriptRow entry={{ ...PEER, label: undefined, peer: { name: 'kamila', replyExpected: true, note: '' } }} />,
    );
    expect(textOf(view)).toContain('waiting for a reply');
    expect(view.root.findAllByType('details')).toHaveLength(0);
    expect(view.root.findAllByProps({ className: 'fy-peer-clock' })).toHaveLength(0);
  });

  test('wears its delivery chip when the ledger proved it', () => {
    const view = render(
      <TranscriptRow
        entry={{
          ...PEER,
          send: {
            sendId: 's1',
            acceptedAt: '2026-10-16T10:01:00.000Z',
            message: 'x',
            attachmentIds: [],
            fate: 'delivered',
          },
        }}
      />,
    );
    expect(view.root.findAll(node => node.props['data-send-fate'] === 'delivered')).not.toHaveLength(0);
  });

  test('starts a new turn after your own message', () => {
    const view = render(
      <TranscriptRow entry={PEER} previous={{ id: 'u', kind: 'user', text: 'mine', label: 'You' }} />,
    );
    expect(view.root.findByProps({ 'data-transcript-kind': 'user' }).props['data-transcript-turn']).toBe('true');
  });
});

describe('a notice from Ferretry itself', () => {
  test('is one compact system line naming its source, never a You bubble', () => {
    const view = render(
      <TranscriptRow
        entry={{
          id: 'n',
          kind: 'system',
          text: 'Your message to aniya did not reach it: `fy send aniya …`.',
          label: '10:05:00',
        }}
      />,
    );
    const row = view.root.findByProps({ 'data-transcript-kind': 'system' });
    expect(row.props.role).toBe('note');
    expect(row.props['data-transcript-density']).toBe('chrome');
    expect(textOf(view)).toBe('FerretryYour message to aniya did not reach it: fy send aniya ….10:05:00');
  });

  test('omits the clock when the record had none', () => {
    const view = render(<TranscriptRow entry={{ id: 'n', kind: 'system', text: 'A notice.' }} />);
    expect(view.root.findAllByProps({ className: 'fy-system-clock' })).toHaveLength(0);
  });
});
