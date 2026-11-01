import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { clockOfInstant } from '../../src/lib/message-clock.ts';
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
  at: Date.UTC(2026, 9, 18, 1, 1, 2),
  peer: {
    name: 'torrey',
    sessionId: 'mvb0sw7d-27f71326',
    kind: 'message',
    replyExpected: false,
    note: 'No reply needed. To reply: fy send torrey "<reply>"',
  },
};

const fleet = [
  { config: { id: 'mvb0sw7d-27f71326', teammate: 'torrey' }, state: { status: 'running' } },
] as unknown as SessionView[];

const proved = (navigated: string[]) => ({
  agentReferenceResolver: createAgentReferenceResolver('d1' as DaemonId, fleet),
  onNavigate: (to: string) => void navigated.push(to),
});

describe('a message from another ferret', () => {
  test('reads as FROM that ferret: a proved :reference, a Markdown body, and no delivery boilerplate', () => {
    const navigated: string[] = [];
    const view = render(
      <ReferenceSurfaceProvider surface={proved(navigated)}>
        <TranscriptRow entry={PEER} />
      </ReferenceSurfaceProvider>,
    );
    const text = textOf(view);
    expect(text).not.toContain('You');
    expect(text).toContain('Message from ferret');
    expect(view.root.findByProps({ className: 'fy-peer-avatar' }).children).toEqual(['T']);
    // The sender is a real reference, through the one renderer, so it opens that ferret's session.
    const [link] = view.root.findAllByType('a');
    expect(link?.props.href).toBe('/d/d1/session/mvb0sw7d-27f71326');
    run(() => link?.props.onClick({ preventDefault: () => undefined, button: 0 }));
    expect(navigated).toEqual(['/d/d1/session/mvb0sw7d-27f71326']);
    expect(view.root.findAllByType('strong').map(node => node.children)).toEqual([['day']]);
    // Nothing addressed to the receiving agent reaches the reader.
    expect(text).not.toContain('fy send');
    expect(text).not.toContain('mvb0sw7d');
    expect(view.root.findAllByType('details')).toHaveLength(0);
    expect(view.root.findByProps({ 'data-transcript-kind': 'user' }).props['data-peer']).toBe('torrey');
  });

  test('minimises a bulky message to its first line, and opens it on "Show more"', () => {
    const bulky = { ...PEER, text: '## Status report\n\n- one\n- two\n\nLots more detail follows here.' };
    const view = render(<TranscriptRow entry={bulky} />);
    expect(view.root.findByProps({ 'data-peer': 'torrey' })).toBeDefined();
    expect(view.root.findByProps({ 'data-peer-preview': '' }).children).toEqual(['Status report']);
    expect(textOf(view)).not.toContain('Lots more detail');
    const more = view.root.findByProps({ 'data-peer-more': '' });
    expect(more.props['aria-expanded']).toBe(false);
    run(() => more.props.onClick());
    expect(textOf(view)).toContain('Lots more detail');
    expect(view.root.findAllByProps({ 'data-peer-preview': '' })).toHaveLength(0);
    expect(view.root.findByProps({ 'data-peer-more': '' }).children).toEqual(['Show less']);
  });

  test('cuts a long single line at about 120 characters, and shows a short message whole with no control', () => {
    const long = { ...PEER, text: `${'word '.repeat(60)}end` };
    const view = render(<TranscriptRow entry={long} />);
    const preview = view.root.findByProps({ 'data-peer-preview': '' }).children.join('');
    expect(preview.length).toBeLessThanOrEqual(121);
    expect(preview.endsWith('…')).toBe(true);
    const short = render(<TranscriptRow entry={PEER} />);
    expect(short.root.findAllByProps({ 'data-peer-more': '' })).toHaveLength(0);
  });

  test('draws an instructions update as one folded gear line with no text prefix, and opens its sections', () => {
    const note = {
      id: 'iu',
      kind: 'user' as const,
      text: '[instructions updated] Ferretry changed part of the instructions you were started with:\n\nBoard: all work is a card.\n\nFerretry tools: terminals.',
      at: Date.UTC(2026, 9, 18, 1, 1, 2),
    };
    const view = render(<TranscriptRow entry={note} />);
    const shown = textOf(view);
    expect(shown).toContain('Ferretry · Instructions updated · Board, Ferretry tools');
    expect(shown).not.toContain('[instructions updated]');
    expect(shown).not.toContain('all work is a card');
    const toggle = view.root.findByProps({ className: 'fy-system-details' });
    run(() => toggle.props.onClick());
    expect(textOf(view)).toContain('all work is a card');
    expect(view.root.findByProps({ 'data-instructions-update': '' })).toBeDefined();
  });

  test('offers a quiet link to the sender’s own conversation, which a modifier-click leaves to the browser', () => {
    const navigated: string[] = [];
    const view = render(
      <ReferenceSurfaceProvider surface={proved(navigated)}>
        <TranscriptRow entry={PEER} />
      </ReferenceSurfaceProvider>,
    );
    const open = view.root.findByProps({ className: 'fy-peer-open' });
    // The foot's row says only "Open conversation ›"; the name it opens stays in the spoken name.
    expect(open.children[0]).toBe('Open conversation');
    const [chevron, spoken] = open.children.filter(child => typeof child !== 'string');
    expect(chevron?.props['aria-hidden']).toBe('true');
    expect(spoken?.props.className).toBe('sr-only');
    expect(spoken?.children.join('')).toBe(' with Torrey');
    expect(open.props.href).toBe('/d/d1/session/mvb0sw7d-27f71326');
    let prevented = 0;
    run(() => open.props.onClick({ preventDefault: () => (prevented += 1), button: 0, metaKey: true }));
    run(() => open.props.onClick({ preventDefault: () => (prevented += 1), button: 1 }));
    expect(prevented).toBe(0);
    run(() => open.props.onClick({ preventDefault: () => (prevented += 1), button: 0 }));
    expect(prevented).toBe(1);
    expect(navigated).toEqual(['/d/d1/session/mvb0sw7d-27f71326']);
  });

  test('proves a sender with no session id by its name, and offers nothing to click without a destination', () => {
    const { sessionId: _id, ...unnamed } = PEER.peer as NonNullable<TranscriptEntry['peer']>;
    const byName = render(
      <ReferenceSurfaceProvider surface={proved([])}>
        <TranscriptRow entry={{ ...PEER, peer: unnamed }} />
      </ReferenceSurfaceProvider>,
    );
    expect(byName.root.findByProps({ className: 'fy-peer-open' }).props.href).toBe('/d/d1/session/mvb0sw7d-27f71326');
    const { onNavigate: _nav, ...nowhere } = proved([]);
    const inert = render(
      <ReferenceSurfaceProvider surface={nowhere}>
        <TranscriptRow entry={PEER} />
      </ReferenceSurfaceProvider>,
    );
    expect(inert.root.findAllByProps({ className: 'fy-peer-open' })).toHaveLength(0);
  });

  test('shows an unproved sender as a plain name with nothing to click', () => {
    const view = render(<TranscriptRow entry={PEER} />);
    expect(view.root.findByProps({ className: 'fy-peer-name' }).children).toEqual(['Torrey']);
    expect(view.root.findAllByType('a')).toHaveLength(0);
  });

  test('says what kind of message it is: a question is waiting, a reply replied, a note says nothing', () => {
    const question = render(
      <TranscriptRow entry={{ ...PEER, peer: { name: 'kamila', kind: 'question', replyExpected: true, note: '' } }} />,
    );
    expect(textOf(question)).toContain('waiting for a reply');
    const reply = render(
      <TranscriptRow entry={{ ...PEER, peer: { name: 'kamila', kind: 'reply', replyExpected: false, note: '' } }} />,
    );
    expect(reply.root.findByProps({ className: 'fy-peer-kind' }).children).toEqual(['replied']);
    expect(render(<TranscriptRow entry={PEER} />).root.findAllByProps({ className: 'fy-peer-kind' })).toHaveLength(0);
  });

  test('carries Show more, the quiet link and the time on the foot’s ONE line, controls first', () => {
    const bulky = { ...PEER, text: '## Status report\n\n- one\n- two\n\nLots more detail follows here.' };
    const view = render(
      <ReferenceSurfaceProvider surface={proved([])}>
        <TranscriptRow entry={bulky} />
      </ReferenceSurfaceProvider>,
    );
    // The three controls that each took a row of their own share the receipt line: the controls as
    // its `lead` at the left, the time and ticks behind them.
    const foot = view.root.findByProps({ 'data-message-footer': '' });
    expect(foot.props['data-side']).toBe('other');
    expect(foot.findByProps({ 'data-peer-more': '' })).toBeDefined();
    expect(foot.findByProps({ className: 'fy-peer-sep' }).props['aria-hidden']).toBe('true');
    expect(foot.findByProps({ className: 'fy-peer-open' })).toBeDefined();
    expect(foot.findByType('time').children).toEqual([clockOfInstant(PEER.at)?.short ?? '']);
  });

  test('carries its time at the foot, on the reader’s clock, never in the header', () => {
    const view = render(<TranscriptRow entry={PEER} />);
    const clock = clockOfInstant(PEER.at);
    expect(view.root.findByProps({ 'data-message-footer': '' }).props['data-side']).toBe('other');
    expect(view.root.findByType('time').children).toEqual([clock?.short ?? '']);
    expect(view.root.findByType('header').findAllByType('time')).toHaveLength(0);
    const { at: _at, ...undated } = PEER;
    expect(render(<TranscriptRow entry={undated} />).root.findAllByType('time')).toHaveLength(0);
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
          at: Date.UTC(2026, 9, 18, 1, 5, 0),
        }}
      />,
    );
    const row = view.root.findByProps({ 'data-transcript-kind': 'system' });
    expect(row.props.role).toBe('note');
    expect(row.props['data-transcript-density']).toBe('chrome');
    expect(textOf(view)).toBe(
      `FerretryYour message to aniya did not reach it: fy send aniya ….${clockOfInstant(Date.UTC(2026, 9, 18, 1, 5, 0))?.short}`,
    );
  });

  test('omits the clock when the record had none', () => {
    const view = render(<TranscriptRow entry={{ id: 'n', kind: 'system', text: 'A notice.' }} />);
    expect(view.root.findAllByType('time')).toHaveLength(0);
  });
});

describe('a Ferretry message from any part of Ferretry', () => {
  const FEATURES = ['Warden', 'Agenda', 'Monitor', 'Lessons', 'Migrate', 'Restart', 'Delivery'];
  const entryFor = (feature: string, text: string) => ({
    id: `f-${feature}`,
    kind: 'user' as const,
    text,
    at: Date.UTC(2026, 9, 18, 1, 1, 2),
    send: {
      sendId: `s-${feature}`,
      acceptedAt: '2026-10-18T01:01:02.000Z',
      message: text,
      attachmentIds: [],
      fate: 'accepted' as const,
      path: 'direct' as const,
      senderKind: 'daemon' as const,
      by: { kind: 'ferretry' as const, feature },
    },
  });

  test('draws as one compact system row, never the owner bubble, for every feature', () => {
    for (const feature of FEATURES) {
      const view = render(<TranscriptRow entry={entryFor(feature, 'Still with us?')} />);
      expect(view.root.findByProps({ 'data-ferretry-message': feature })).toBeDefined();
      expect(textOf(view)).toContain(`Ferretry · ${feature}`);
      expect(textOf(view)).toContain('Still with us?');
      expect(view.root.findAllByProps({ className: 'fy-system-details' })).toHaveLength(0);
    }
  });

  test('keeps long text behind Show', () => {
    const view = render(
      <TranscriptRow entry={entryFor('Warden', 'You went quiet.\n\nRun fy signal working if busy.')} />,
    );
    expect(textOf(view)).not.toContain('fy signal working');
    run(() => view.root.findByProps({ className: 'fy-system-details' }).props.onClick());
    expect(textOf(view)).toContain('fy signal working');
  });

  test('draws the same row while it travels as a ledger row', () => {
    const { send } = entryFor('Warden', 'Still with us?');
    const view = render(<TranscriptRow entry={{ id: 'l1', kind: 'ledger', text: send.message, ledger: send }} />);
    expect(view.root.findByProps({ 'data-ferretry-message': 'Warden' })).toBeDefined();
  });
});
