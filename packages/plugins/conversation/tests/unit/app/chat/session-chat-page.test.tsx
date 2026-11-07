import { afterEach, describe, expect, test } from 'bun:test';
import { createLiveActivityHub, PanelSlot } from '@ferretry/app';
import { ensureDom, render, run } from '@ferretry/app/testing';
import type { FerretLiveActivity } from '@ferretry/core-ferrets/contract';
import type { ComponentProps } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { HandoffSourceProvider } from '../../../../app/chat/handoff-message.tsx';
import { SessionChatPage } from '../../../../app/chat/session-chat-page.tsx';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { TranscriptUnboundNotice } from '../../../../app/chat/transcript-unbound-notice.tsx';
import { Composer } from '../../../../app/composer/composer.tsx';
import { QuestionForm } from '../../../../app/questions/question-form.tsx';
import { type FakeClient, fakeClient } from '../../../support/app/fake-client.ts';
import { ferretView } from '../../../support/app/ferret-view.ts';

ensureDom();

/**
 * THE CHAT: one ferret's conversation and the slots the rest of its screen is drawn in. Today's suite drove the whole
 * workspace (top bar, Info, Actions, the deck, the agenda); those parts are other plugins' panels on 5.0 and their
 * cases moved with them. What is left is the conversation's own: the transcript, the hand-off reader, the question form
 * or the composer, the issue line, the unbound notice, the search, and the slots.
 */

const HANDOFF = 'GET /v1/ferrets/:ferretId/handoffs/:name';
const ANSWER = 'POST /v1/ferrets/:ferretId/answer';

type PageProps = ComponentProps<typeof SessionChatPage>;

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const page of mounted.splice(0)) run(() => page.unmount());
});

const draw = (overrides: Partial<PageProps> = {}, client: FakeClient = fakeClient({})) => {
  const props: PageProps = {
    client,
    daemonId: 'alpha',
    entries: [],
    session: ferretView('shared'),
    ...overrides,
  };
  const page = render(<SessionChatPage {...props} />);
  mounted.push(page);
  return page;
};

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('');

const QUESTION = {
  toolUseId: 'ask-1',
  questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }],
};

describe('SessionChatPage', () => {
  test('draws the transcript and the composer on this daemon, with the slots the ferret screen is drawn in', () => {
    const page = draw({
      entries: [{ id: 'one', kind: 'assistant', label: 'Assistant', text: 'The daemon answered.' }],
      session: ferretView('shared', { config: { teammate: 'Alpha Agent' } }),
    });

    expect(page.root.findByType(Transcript).props.daemonId).toBe('alpha');
    expect(page.root.findByType(Transcript).props.entries[0].text).toBe('The daemon answered.');
    expect(page.root.findAllByType(Composer)).toHaveLength(1);
    expect(page.root.findAllByType(PanelSlot).map(slot => [slot.props.slot, slot.props.subject])).toEqual([
      ['ferret.toolbar', 'shared'],
      ['ferret.side', 'shared'],
    ]);
  });

  test('reads a message handed over through a file from this ferret, through the half’s client', async () => {
    const handoff = { v: 1, name: 'turn-008', message: 'look at this', attachments: [] };
    const client = fakeClient({ [HANDOFF]: () => handoff });
    const page = draw({}, client);
    const source = page.root.findByType(HandoffSourceProvider).props.source;

    expect(source.daemon.daemonId).toBe('alpha');
    expect(source.sessionId).toBe('shared');
    expect(await source.read('turn-008')).toMatchObject({ name: 'turn-008', message: 'look at this' });
    expect(client.calls).toEqual([{ route: HANDOFF, init: { params: { ferretId: 'shared', name: 'turn-008' } } }]);
  });

  test('a send returns the transcript to the tail and still refreshes the chat', () => {
    let refreshed = 0;
    const page = draw({ onRefresh: () => (refreshed += 1) });
    expect(page.root.findByType(Transcript).props.pinSignal).toBe(0);
    run(() => page.root.findByType(Composer).props.onSent({ words: 'hi' }));
    expect(page.root.findByType(Transcript).props.pinSignal).toBe(1);
    expect(refreshed).toBe(1);
  });

  test('caps transcript and composer with one measure so neither can disagree with the other', () => {
    for (const chatWidth of ['full', 'readable'] as const) {
      const page = draw({ chatWidth });
      const surface = page.root.find(node => node.props['data-chat-width'] !== undefined);
      expect(surface.props['data-chat-width']).toBe(chatWidth);
      // ONE surface holds both, which is what makes the two measures agree.
      expect(surface.findAllByType(Transcript)).toHaveLength(1);
      expect(surface.findAllByType(Composer)).toHaveLength(1);
    }
  });

  test('hands the transcript the reading position it was given, and none when there is none', () => {
    const readingPosition = { read: () => null, write: () => undefined };
    expect(draw({ readingPosition }).root.findByType(Transcript).props.readingPosition).toBe(readingPosition);
    expect(draw().root.findByType(Transcript).props.readingPosition).toBeUndefined();
  });

  test('a message still waiting to go into the ferret is left out of the Transcript', () => {
    const waiting = {
      id: 'send:w1',
      kind: 'ledger',
      text: 'saved for later',
      ledger: {
        sendId: 'w1',
        acceptedAt: '2026-11-04T11:00:00.000Z',
        message: 'saved for later',
        attachmentIds: [],
        fate: 'accepted',
        held: true,
      },
      placement: 'chronological',
    } as unknown as TranscriptEntry;
    expect(draw({ entries: [waiting] }).root.findByType(Transcript).props.entries).toEqual([]);
  });
});

describe('the question the ferret is asking', () => {
  test('mounts the structured form in place of the composer and answers through the daemon, then refreshes', async () => {
    const answered: unknown[] = [];
    const client = fakeClient({
      [ANSWER]: init => {
        answered.push([init.params?.['ferretId'], init.body, init.headers]);
        return { ok: true };
      },
    });
    let refreshed = 0;
    const page = draw(
      {
        onRefresh: () => (refreshed += 1),
        question: QUESTION,
        session: ferretView('shared', { state: { status: 'awaiting_question' } }),
      },
      client,
    );

    expect(page.root.findAllByType(QuestionForm)).toHaveLength(1);
    expect(page.root.findAllByType(Composer)).toHaveLength(0);
    expect(page.root.findAllByProps({ 'data-question-unavailable': '' })).toHaveLength(0);
    const form = page.root.findByType(QuestionForm);
    expect(form.props.daemon).toBe('alpha');
    expect(form.props.ferretId).toBe('shared');
    await form.props.api.answer(
      'shared',
      'ask-1',
      ['Yes'],
      undefined,
      undefined,
      [{ kind: 'selection', labels: ['Yes'] }],
      'answer-1',
    );

    expect(answered).toEqual([
      [
        'shared',
        { toolUseId: 'ask-1', labels: ['Yes'], answers: [{ kind: 'selection', labels: ['Yes'] }] },
        { 'x-fy-request-id': 'answer-1' },
      ],
    ]);
    expect(refreshed).toBe(1);
  });

  test('a waiting status with no validated question is damaged evidence: no form, no composer, and no invented answer', () => {
    const page = draw({ question: null, session: ferretView('shared', { state: { status: 'awaiting_question' } }) });
    expect(page.root.findAllByProps({ 'data-question-unavailable': '' }).length).toBeGreaterThan(0);
    expect(page.root.findAllByType(QuestionForm)).toHaveLength(0);
    expect(page.root.findAllByType(Composer)).toHaveLength(0);
  });

  test('a finished ferret draws no question, whatever was last read', () => {
    const page = draw({ question: QUESTION, session: ferretView('shared', { state: { status: 'stopped' } }) });
    expect(page.root.findAllByType(QuestionForm)).toHaveLength(0);
    expect(page.root.findByType(Composer).props.disabled).toBe(true);
  });
});

describe('the issue line', () => {
  test('renders the refresh error verbatim and never as a second live region', () => {
    const page = draw({ refreshError: 'Conversation issue: the daemon did not answer.' });
    const painted = JSON.stringify(page.toJSON());
    expect(painted).toContain('Conversation issue: the daemon did not answer.');
    expect(painted).not.toContain('Conversation issue: Conversation issue:');
    const statuses = page.root
      .findAllByProps({ role: 'status' })
      .filter(node => textOf(node).includes('daemon did not answer'));
    expect(statuses).toHaveLength(0);
  });

  test('keeps a refresh error to one line, with the whole sentence one tap away', () => {
    const page = draw({ refreshError: 'Conversation issue: the daemon did not answer.' });
    const issue = page.root.findByProps({ 'data-session-issue': '' });
    expect(issue.type).toBe('details');
    expect(textOf(issue)).toBe('Conversation issue: the daemon did not answer.');
    expect(issue.findByType('summary').props.className).toContain('truncate');
  });

  test('shows an unprovable transcript as its own notice in place of the issue line, with Check again', () => {
    let refreshed = 0;
    const page = draw({
      onRefresh: () => (refreshed += 1),
      refreshError: 'Conversation issue: ferret shared has no transcript this daemon can prove is its own',
      transcriptUnbound: true,
    });
    expect(page.root.findAllByType(TranscriptUnboundNotice)).toHaveLength(1);
    expect(page.root.findAllByProps({ 'data-session-issue': '' })).toHaveLength(0);
    run(() => page.root.findByType(TranscriptUnboundNotice).props.onCheckAgain());
    expect(refreshed).toBe(1);
  });
});

describe('whose turn it is', () => {
  test("the daemon's working turn spins the transcript and the composer, from the turn's start", () => {
    const turn = '2026-10-16T08:00:00.000Z';
    const page = draw({ session: ferretView('shared', { state: { turnState: 'working', turnStateAt: turn } }) });
    expect(page.root.findByType(Transcript).props.busy).toBe(true);
    expect(page.root.findByType(Composer).props.busy).toBe(true);
    expect(page.root.findByType(Transcript).props.turnStartedAt).toBe(turn);
  });

  for (const turnState of ['your-turn', 'needs-input'] as const) {
    test(`the daemon's ${turnState} stops the spinner at once and gives no turn start`, () => {
      const page = draw({
        session: ferretView('shared', { state: { turnState, turnStateAt: '2026-10-16T08:00:00.000Z' } }),
      });
      expect(page.root.findByType(Transcript).props.busy).toBe(false);
      expect(page.root.findByType(Composer).props.busy).toBe(false);
      expect(page.root.findByType(Transcript).props.turnStartedAt).toBeNull();
    });
  }

  test('hands the transcript the latest live sample the feed published', () => {
    const hub = createLiveActivityHub<FerretLiveActivity>();
    const page = draw({
      liveActivity: hub,
      session: ferretView('shared', { state: { turnState: 'working', turnStateAt: '2026-10-16T08:00:00.000Z' } }),
    });
    expect(page.root.findByType(Transcript).props.live).toBeNull();
    const sample = {
      sessionId: 'shared',
      at: '2026-10-16T08:00:05.000Z',
      turnStartedAt: '2026-10-16T08:00:00.000Z',
      inputTokens: 48_000,
    } as FerretLiveActivity;
    run(() => hub.publish(sample));
    expect(page.root.findByType(Transcript).props.live).toEqual(sample);
  });
});

describe('search within the conversation', () => {
  const searchPort = {
    search: async () => ({ v: 1 as const, ferret: 'shared', query: 'x', file: 'f', matches: [], truncated: false }),
    reach: async () => true,
  };
  const searchBars = (root: ReactTestInstance): number => root.findAll(node => node.type === 'search').length;
  const controlF = (init: KeyboardEventInit = { ctrlKey: true }): void =>
    run(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', cancelable: true, ...init }));
    });

  test('opens on Ctrl-F and Cmd-F in the chat, and leaves other shortcuts to the browser', () => {
    const view = draw({ conversationSearch: searchPort as never });
    controlF({ ctrlKey: true, shiftKey: true });
    controlF({ altKey: true, metaKey: true });
    expect(searchBars(view.root)).toBe(0);
    controlF({ metaKey: true });
    expect(searchBars(view.root)).toBe(1);
    controlF({ ctrlKey: true });
    expect(searchBars(view.root)).toBe(1);
  });

  test('leaves Ctrl-F to the browser when focus is in another pane', () => {
    const view = draw({ conversationSearch: searchPort as never });
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    try {
      controlF();
      expect(searchBars(view.root)).toBe(0);
    } finally {
      elsewhere.remove();
    }
  });

  test('offers no search where the host has none', () => {
    const view = draw();
    controlF();
    expect(searchBars(view.root)).toBe(0);
  });
});
