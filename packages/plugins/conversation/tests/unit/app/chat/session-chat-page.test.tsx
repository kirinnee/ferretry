import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createLiveActivityHub,
  deviceControls,
  PanelSlot,
  ReferenceSurfaceProvider,
  writeMdComposePref,
} from '@ferretry/app';
import { ensureDom, render, run, runAsync, WithAppHooks } from '@ferretry/app/testing';
import { FERRETS_FILE_OPEN_HOOK, FerretsChanged, type FerretLiveActivity } from '@ferretry/core-ferrets/contract';
import type { ComponentProps } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { CONVERSATION_ABOVE_COMPOSER_SLOT } from '../../../../contract/index.ts';
import { HandoffSourceProvider } from '../../../../app/chat/handoff-message.tsx';
import { unreadChatSession } from '../../../../app/chat/chat-session.ts';
import { SessionChatPage } from '../../../../app/chat/session-chat-page.tsx';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';
import { TranscriptUnboundNotice } from '../../../../app/chat/transcript-unbound-notice.tsx';
import { Composer } from '../../../../app/composer/composer.tsx';
import { QuestionForm } from '../../../../app/questions/question-form.tsx';
import { type FakeClient, fakeClient } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/composer-host.tsx';
import { ferretView } from '../../../support/app/ferret-view.ts';

import * as realSharedDraft from '../../../../app/composer/use-shared-draft.ts';

ensureDom();

/**
 * The shared draft's clear can take up to a second to come back while this device's last keystroke is answered. A case
 * holds it open here (a gate it releases itself); every other case goes straight to the real hook.
 */
// Taken before the mock replaces the module's binding, or the mock would call itself.
const { useSharedDraft: realUseSharedDraft, ...otherSharedDraftExports } = realSharedDraft;
const clearGate: { current: Promise<undefined> | undefined } = { current: undefined };
mock.module('../../../../app/composer/use-shared-draft.ts', () => ({
  ...otherSharedDraftExports,
  useSharedDraft: (...args: Parameters<typeof realUseSharedDraft>) => {
    const real = realUseSharedDraft(...args);
    return {
      ...real,
      sendClear: (...rest: Parameters<typeof real.sendClear>) => {
        return clearGate.current ?? real.sendClear(...rest);
      },
    };
  },
}));

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
  // The device controls are one shared store: leave every choice at its default for the next case.
  deviceControls().setControls('alpha', {
    composerEnterKey: null,
    composerPhoneEnterKey: null,
    composerVimMode: false,
    suggestionKeys: 'ladder',
    skillSuggestions: true,
  });
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
    // The ferret screen's own slots, and each row's (an assistant row offers its actions and what other halves add).
    expect(page.root.findAllByType(PanelSlot).map(slot => [slot.props.slot, slot.props.subject])).toEqual([
      ['ferret.toolbar', 'shared'],
      ['conversation.row-actions', 'shared'],
      ['conversation.row', 'shared'],
      ['conversation.above-composer', 'shared'],
      ['ferret.side', 'shared'],
    ]);
  });

  test('embedded under an agenda item: only the conversation and composer — no toolbar, no side panels (no terminal, no passkey ask)', () => {
    const page = draw({ embedded: true, session: ferretView('shared') });

    expect(page.root.findByType(Transcript).props.daemonId).toBe('alpha');
    expect(page.root.findAllByType(Composer)).toHaveLength(1);
    const slots = page.root.findAllByType(PanelSlot).map(slot => slot.props.slot);
    expect(slots).not.toContain('ferret.toolbar');
    expect(slots).not.toContain('ferret.side');
    expect(slots).toContain('conversation.above-composer');
  });

  test('offers the above-composer slot for this ferret, in the input column directly before the composer', () => {
    const page = draw();

    const column = page.root.findByProps({ className: 'fy-chat-input__column' });
    const drawn = column.children.filter((child): child is ReactTestInstance => typeof child !== 'string');
    expect(drawn.map(child => child.type)).toEqual([PanelSlot, Composer]);
    expect(drawn[0]?.props).toMatchObject({
      daemon: 'alpha',
      slot: CONVERSATION_ABOVE_COMPOSER_SLOT,
      subject: 'shared',
    });
  });

  const aboveComposerProps = (page: ReturnType<typeof draw>) =>
    page.root.findAll(node => node.type === PanelSlot && node.props.slot === CONVERSATION_ABOVE_COMPOSER_SLOT)[0]?.props
      .props;

  test('hands the above-composer slot the rows, the turn, what the ferret waits on and the send ledger ids', () => {
    const page = draw({
      entries: [
        {
          id: 'u1',
          kind: 'user',
          label: 'You',
          text: 'read this',
          send: {
            sendId: 's1',
            acceptedAt: '2026-11-04T11:00:00.000Z',
            message: 'read this',
            attachmentIds: [],
            fate: 'delivered',
          },
        },
        { id: 'a1', kind: 'assistant', label: 'Assistant', text: 'Done.' },
      ] as unknown as TranscriptEntry[],
      question: QUESTION,
      sends: [{ sendId: 's1', acceptedAt: '2026-11-04T11:00:00.000Z', message: 'read this' }] as unknown as NonNullable<
        PageProps['sends']
      >,
      session: ferretView('shared', { state: { status: 'awaiting_question', turnState: 'needs-input' } }),
    });

    expect(aboveComposerProps(page)).toEqual({
      rows: [
        { id: 'u1', kind: 'user', label: 'You', text: 'read this', send: { sendId: 's1' } },
        { id: 'a1', kind: 'assistant', label: 'Assistant', text: 'Done.' },
      ],
      turn: { state: 'needs-input', live: true },
      needsInput: {
        question: {
          questions: [{ question: 'Ship it?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }],
        },
      },
      // The ledger's words stay in Conversation: only the id and the daemon's acceptance instant are offered.
      sends: [{ sendId: 's1', acceptedAt: '2026-11-04T11:00:00.000Z' }],
    });
  });

  test('a page given no ledger offers no sends', () => {
    expect(aboveComposerProps(draw()).sends).toEqual([]);
  });

  test('the turn is live only when the ferret was read from the daemon and the latest refresh did not fail', () => {
    // Read, no failure: live.
    expect(aboveComposerProps(draw()).turn.live).toBe(true);
    // Read, but the latest refresh failed: the turn on screen may be stale, so it is not live.
    expect(aboveComposerProps(draw({ refreshError: 'Conversation issue: offline' })).turn.live).toBe(false);
    // Never read (the page is drawn from the id alone): not live, and it claims no turn.
    const unread = aboveComposerProps(draw({ session: unreadChatSession('shared') }));
    expect(unread.turn).toEqual({ state: null, live: false });
  });

  test('an ended ferret offers nothing it was waiting on', () => {
    const page = draw({
      question: QUESTION,
      session: ferretView('shared', { state: { status: 'completed' } }),
    });
    expect(aboveComposerProps(page).needsInput).toEqual({});
  });

  test('keeps the slot above a pending question’s form too: a permission card is not hidden by a question', () => {
    const page = draw({
      question: QUESTION,
      session: ferretView('shared', { state: { status: 'awaiting_question' } }),
    });

    const column = page.root.findByProps({ className: 'fy-chat-input__column' });
    const drawn = column.children.filter((child): child is ReactTestInstance => typeof child !== 'string');
    expect(drawn.map(child => child.type)).toEqual([PanelSlot, QuestionForm]);
  });

  test('hands the composer this device’s Enter-key choices, Vim mode and suggestion families', () => {
    const page = draw();
    expect(page.root.findByType(Composer).props).toMatchObject({
      enterKeyPreference: null,
      phoneEnterKeyPreference: null,
      vimMode: false,
      suggestions: { ladderSuggestions: true, directReferenceSuggestions: false, skillSuggestions: true },
    });

    // Enter-to-send off (↵ is a new line), a phone that sends on return, Vim on, `@`-less symbols only and no skills.
    run(() =>
      deviceControls().setControls('alpha', {
        composerEnterKey: 'newline',
        composerPhoneEnterKey: 'send',
        composerVimMode: true,
        suggestionKeys: 'symbols',
        skillSuggestions: false,
      }),
    );
    expect(page.root.findByType(Composer).props).toMatchObject({
      enterKeyPreference: 'newline',
      phoneEnterKeyPreference: 'send',
      vimMode: true,
      suggestions: { ladderSuggestions: false, directReferenceSuggestions: true, skillSuggestions: false },
    });
  });

  test('reads a message handed over through a file from this ferret, through the half’s client', async () => {
    const handoff = { name: 'turn-008', message: 'look at this', attachments: [] };
    const client = fakeClient({ [HANDOFF]: () => handoff });
    const page = draw({}, client);
    const source = page.root.findByType(HandoffSourceProvider).props.source;

    expect(source.daemon.daemonId).toBe('alpha');
    expect(source.sessionId).toBe('shared');
    expect(await source.read('turn-008')).toMatchObject({ name: 'turn-008', message: 'look at this' });
    expect(client.callsTo(HANDOFF)).toMatchObject([
      { route: HANDOFF, params: { ferretId: 'shared', name: 'turn-008' } },
    ]);
  });

  describe('references', () => {
    const FLEET = 'GET /v1/ferrets';
    const row = { id: 'other', name: 'torrey', state: 'idle', folder: '/repo' };
    const opening = { open: () => true };
    const surfaceOf = (page: ReturnType<typeof draw>) => page.root.findByType(ReferenceSurfaceProvider).props.surface;
    const drawWithHook = (overrides: Partial<PageProps>, hook: unknown, client: FakeClient) => {
      const page = render(
        <WithAppHooks provided={hook === undefined ? {} : { [FERRETS_FILE_OPEN_HOOK]: hook }}>
          <SessionChatPage
            client={client}
            daemonId="alpha"
            entries={[]}
            session={ferretView('shared')}
            {...overrides}
          />
        </WithAppHooks>,
      );
      mounted.push(page);
      return page;
    };

    test('proves :agent from the fleet this daemon lists, through the half’s own client', async () => {
      const client = fakeClient({ [FLEET]: () => [row] });
      const page = draw({}, client);
      await runAsync(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      expect(client.callsTo(FLEET)).toHaveLength(1);
      expect(surfaceOf(page).agentReferenceResolver({ name: 'torrey' })).toEqual({
        daemonId: 'alpha',
        sessionId: 'other',
        name: 'torrey',
      });
    });

    test('proves no agent before the fleet is read', () => {
      const page = draw({}, fakeClient({ [FLEET]: () => [row] }));

      expect(surfaceOf(page).agentReferenceResolver).toBeUndefined();
    });

    test('opens an @file only where Ferrets gives an opener and a workspace shows Files', async () => {
      const client = () => fakeClient({ [FLEET]: () => [row] });
      const without = drawWithHook({}, undefined, client());
      const wrongShape = drawWithHook({}, { open: 'no' }, client());
      const embedded = drawWithHook({ embedded: true }, opening, client());
      const full = drawWithHook({}, opening, client());
      await runAsync(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      expect(surfaceOf(without).onCodeReferenceOpen).toBeUndefined();
      expect(surfaceOf(wrongShape).onCodeReferenceOpen).toBeUndefined();
      expect(surfaceOf(embedded).onCodeReferenceOpen).toBeUndefined();
      expect(typeof surfaceOf(full).onCodeReferenceOpen).toBe('function');
    });

    test('keeps the surface and the file proof across working <-> idle, and the file proof across another ferret’s coming', async () => {
      let rows = [{ id: 'shared', name: 'aniya', state: 'working', folder: '/repo' }, row];
      const client = fakeClient({ [FLEET]: () => rows });
      const page = drawWithHook({}, opening, client);
      const wait = (ms: number) =>
        runAsync(async () => {
          await new Promise(resolve => setTimeout(resolve, ms));
        });
      await wait(0);
      const first = surfaceOf(page);

      // Act — any ferret going idle is a read, and moves nothing the proof reads
      rows = rows.map(each => ({ ...each, state: 'idle' }));
      client.emit(FerretsChanged.name, {});
      await wait(1_100);
      const idle = surfaceOf(page);
      // A ferret comes: the callsigns change (the surface is rebuilt), this ferret's folder does not
      rows = [...rows, { id: 'third', name: 'kim', state: 'working', folder: '/elsewhere' }];
      client.emit(FerretsChanged.name, {});
      await wait(1_100);
      const grown = surfaceOf(page);

      // Assert
      expect(client.callsTo(FLEET)).toHaveLength(3);
      expect(idle).toBe(first);
      expect(grown).not.toBe(first);
      expect(grown.agentReferenceResolver({ name: 'kim' })).not.toBeNull();
      expect(grown.resolveFilePaths).toBe(first.resolveFilePaths);
      expect(grown.onCodeReferenceOpen).toBe(first.onCodeReferenceOpen);
    });

    test('asks Ferrets to open the path in THIS ferret’s Files, and stays quiet when the path is refused', async () => {
      const asked: Array<[string, string]> = [];
      const refusing = { open: (ferret: string, path: string) => (asked.push([ferret, path]), path !== 'bad') };
      const client = fakeClient({ [FLEET]: () => [row] });
      const page = drawWithHook({}, refusing, client);
      await runAsync(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      run(() => surfaceOf(page).onCodeReferenceOpen({ path: 'src/a.ts' }));
      run(() => surfaceOf(page).onCodeReferenceOpen({ path: 'bad' }));

      expect(asked).toEqual([
        ['shared', 'src/a.ts'],
        ['shared', 'bad'],
      ]);
    });
  });

  test('a send returns the transcript to the tail and still refreshes the chat', () => {
    let refreshed = 0;
    const page = draw({ onRefresh: () => (refreshed += 1) });
    expect(page.root.findByType(Transcript).props.pinSignal).toBe(0);
    run(() => page.root.findByType(Composer).props.onSent({ words: 'hi' }));
    expect(page.root.findByType(Transcript).props.pinSignal).toBe(1);
    expect(refreshed).toBe(1);
  });

  test('an ask’s reply is about that ask: its own draft, the !A3 prefix, and a receipt when it is sent (triage B17)', async () => {
    const received: unknown[] = [];
    const restored: string[] = [];
    const sentBodies: string[] = [];
    const client = fakeClient({
      'POST /v1/ferrets/:ferretId/send': call => {
        sentBodies.push(String((call.body as { message?: string } | undefined)?.message));
        return { sendId: 's1', disposition: 'delivered' };
      },
    });
    const page = draw(
      {
        ask: {
          id: 'A3',
          onReplied: sent => received.push(sent),
          restore: 'take it back',
          onRestored: () => restored.push('done'),
        },
      },
      client,
    );
    const composer = page.root.findByType(Composer);
    expect(composer.props.draftSlot).toBe('A3');
    expect(composer.props.restore).toBe('take it back');
    // The composer itself puts the words in the box once and says so.
    expect(restored).toEqual(['done']);
    run(() => composer.props.onSent({ words: 'hi', sendId: 's1', disposition: 'delivered' }));
    expect(received).toEqual([{ words: 'hi', sendId: 's1', disposition: 'delivered' }]);
    // The route's answer is not this test's subject: the request it was given is.
    await composer.props.api.send('shared', { message: 'hi' }).catch(() => undefined);
    expect(sentBodies.join('')).toContain('!A3');
  });

  test('without an ask the composer is the ferret’s own chat box: no item draft, no prefix', () => {
    const page = draw();
    expect(page.root.findByType(Composer).props.draftSlot).toBeUndefined();
    expect(page.root.findByType(Composer).props.api).toBeUndefined();
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
      [ANSWER]: call => {
        answered.push([call.params['ferretId'], call.body, call.headers]);
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

  test('under an agenda item the reply box stays with the question’s form: the item is answered through the Agenda, not the chat', () => {
    const page = draw({
      ask: { id: 'A6' },
      embedded: true,
      question: QUESTION,
      session: ferretView('shared', { state: { status: 'awaiting_question' } }),
    });

    expect(page.root.findAllByType(QuestionForm)).toHaveLength(1);
    expect(page.root.findAllByType(Composer)).toHaveLength(1);
  });

  test('a form card’s Send, pressed for real, answers the form and sends no chat message, even while the ferret waits on its question', async () => {
    const sent: unknown[] = [];
    const replied: unknown[] = [];
    let answered = 0;
    const client = fakeClient({
      'POST /v1/ferrets/:ferretId/send': call => {
        sent.push(call.body);
        return { sendId: 's1', disposition: 'delivered' };
      },
    });
    const page = draw(
      {
        ask: { id: 'A6', answerForm: () => (answered += 1), formChanges: 3, onReplied: reply => replied.push(reply) },
        embedded: true,
        question: QUESTION,
        session: ferretView('shared', { state: { status: 'awaiting_question' } }),
      },
      client,
    );

    expect(page.root.findByType(Composer).props.allowEmptySend).toBe(true);
    expect(page.root.findByType(Composer).props.clearErrorOn).toBe(3);
    await runAsync(async () => page.root.findByType('form').props.onSubmit({ preventDefault() {} }));

    expect(answered).toBe(1);
    expect(sent).toEqual([]);
    // A form's Send is an answer, not a reply: the Inbox is told nothing.
    expect(replied).toEqual([]);
  });

  test('a Send pressed on form A6 answers A6 only, even when the page moves to form A7 of the same ferret before it ends', async () => {
    const answeredOn: string[] = [];
    const base: Partial<PageProps> = {
      embedded: true,
      question: QUESTION,
      session: ferretView('shared', { state: { status: 'awaiting_question' } }),
    };
    const props = (id: string): PageProps => ({
      client: fakeClient({}),
      daemonId: 'alpha',
      entries: [],
      ...base,
      ask: { id, answerForm: () => void answeredOn.push(id) },
      session: base.session as PageProps['session'],
    });
    let release: () => void = () => undefined;
    clearGate.current = new Promise<undefined>(resolve => {
      release = () => resolve(undefined);
    });
    try {
      const page = draw(props('A6'));
      // The press happens while the shared draft's clear is still out; then the owner opens the next item of the same ferret.
      // (The press is its own act, not part of an async one: an update inside an open async act waits for it to end.)
      let pressed: Promise<void> = Promise.resolve();
      run(() => {
        pressed = page.root.findByType('form').props.onSubmit({ preventDefault() {} });
      });
      run(() => page.update(<SessionChatPage {...props('A7')} />));
      release();
      await runAsync(async () => await pressed);
    } finally {
      clearGate.current = undefined;
    }

    expect(answeredOn).toEqual(['A6']);
  });

  test('without a form the item’s reply box is still a reply to the item', () => {
    const page = draw({ ask: { id: 'A6' }, embedded: true });
    expect(page.root.findByType(Composer).props.allowEmptySend).toBeUndefined();
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

  test('shows an unprovable transcript as its own notice, with Check again', () => {
    let refreshed = 0;
    const page = draw({
      onRefresh: () => (refreshed += 1),
      transcriptUnbound: true,
    });
    expect(page.root.findAllByType(TranscriptUnboundNotice)).toHaveLength(1);
    run(() => page.root.findByType(TranscriptUnboundNotice).props.onCheckAgain());
    expect(refreshed).toBe(1);
  });

  test('shows a separate session failure ALONGSIDE the unprovable-transcript notice, never instead of it', () => {
    const page = draw({
      refreshError: 'Conversation issue: Session: permission denied',
      session: unreadChatSession('shared'),
      transcriptUnbound: true,
    });
    expect(page.root.findAllByType(TranscriptUnboundNotice)).toHaveLength(1);
    const issue = page.root.findAllByProps({ 'data-session-issue': '' });
    expect(issue).toHaveLength(1);
    expect(textOf(issue[0] as ReactTestInstance)).toBe('Conversation issue: Session: permission denied');
  });

  test('disables the composer, and says why, for a ferret that was never read', () => {
    const page = draw({
      refreshError: 'Conversation issue: Session: permission denied',
      session: unreadChatSession('shared'),
    });
    expect(page.root.findByType(Composer).props.disabled).toBe(true);
    expect(textOf(page.root.findByProps({ 'data-composer-unread': '' }))).toContain('could not be read');
  });

  test('leaves the composer on, with no such note, for a ferret that was read', () => {
    const page = draw();
    expect(page.root.findByType(Composer).props.disabled).toBe(false);
    expect(page.root.findAllByProps({ 'data-composer-unread': '' })).toHaveLength(0);
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

describe('the ferret’s harness reaches the composer', () => {
  // The plain textarea: the live editor has its own suites.
  beforeEach(() => writeMdComposePref('off'));
  afterEach(() => writeMdComposePref('on'));

  const SKILL_ROUTE = 'GET /v1/ferrets/:ferretId/references';
  const skillsClient = () =>
    fakeClient(
      {
        [SKILL_ROUTE]: call => ({
          ferret: call.params.ferretId,
          prefix: call.query.prefix,
          provided: true,
          entries: [{ token: 'summary', label: '', detail: 'Give a fast recap' }],
        }),
      },
      'alpha',
    );

  /** The page inside the half's client context, which is where its composer reads the ferret's skills. */
  const drawWith = (session: PageProps['session'], client: FakeClient) => {
    const page = render(
      withClient(<SessionChatPage client={client} daemonId="alpha" entries={[]} session={session} />, client),
    );
    mounted.push(page);
    return page;
  };

  /** Types `/summary` in the page's own composer and reads the menu's header and footer: what Enter would insert. */
  const menuOffered = async (page: ReturnType<typeof draw>): Promise<string> => {
    await runAsync(async () => {
      page.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value: '/summary', selectionStart: 8, selectionEnd: 8 } });
    });
    // The skills read is asynchronous: wait for the menu (up to ~2 s) rather than one fixed tick, which a slow CI runner misses.
    for (let tries = 0; tries < 100; tries += 1) {
      if (page.root.findAllByProps({ className: 'fy-ac-foot' }).length > 0) break;
      await runAsync(async () => await new Promise<void>(resolve => setTimeout(resolve, 20)));
    }
    return textOf(page.root.findByProps({ className: 'fy-ac-foot' }));
  };

  test('a Codex ferret’s picked skill inserts $name', async () => {
    const page = drawWith(ferretView('shared', { config: { harness: 'codex' } }), skillsClient());
    expect(page.root.findByType(Composer).props.harness).toBe('codex');
    expect(await menuOffered(page)).toBe('↵ inserts $summary · ⇥ complete · esc');
  });

  test('a Claude ferret’s picked skill inserts /name', async () => {
    const page = drawWith(ferretView('shared', { config: { harness: 'claude' } }), skillsClient());
    expect(page.root.findByType(Composer).props.harness).toBe('claude');
    expect(await menuOffered(page)).toBe('↵ inserts /summary · ⇥ complete · esc');
  });

  test('a ferret the chat could not read names no harness, so the menu offers what every harness accepts', () => {
    const page = draw({ session: unreadChatSession('shared') });
    expect(page.root.findByType(Composer).props.harness).toBeUndefined();
  });
});
