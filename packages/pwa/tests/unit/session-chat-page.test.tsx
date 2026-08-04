import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';

import { QuestionForm } from '../../src/components/question-form.tsx';
import { SessionHeader } from '../../src/components/session-header.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type SessionChatClient, SessionChatPage } from '../../src/lib/pages/session-chat-page.tsx';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});

const buttonNamed = (root: ReactTestInstance, label: string): ReactTestInstance => {
  const button = root.findAllByType('button').find(candidate => candidate.children.join('') === label);
  if (button === undefined) throw new Error(`missing ${label} button`);
  return button;
};

const client = (calls: string[], next: SessionView): SessionChatClient =>
  ({
    send: async () => ({ accepted: true }),
    answer: async () => next,
    attachTarget: async () => ({ tmuxSession: 'fy-shared' }),
    interrupt: async (id: string) => {
      calls.push(`interrupt:${id}`);
      return next;
    },
    resume: async (id: string) => {
      calls.push(`resume:${id}`);
      return next;
    },
    stop: async (id: string, reason?: string) => {
      calls.push(`stop:${id}:${reason}`);
      return next;
    },
  }) as unknown as SessionChatClient;

describe('SessionChatPage', () => {
  test('renders the proved transcript, composer, controls, and honest pane launchers', () => {
    const page = render(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[{ id: 'one', kind: 'assistant', label: 'Assistant', text: 'The daemon answered.' }]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared', { config: { teammate: 'Alpha Agent' } })}
      />,
    );

    expect(page.root.findAllByType(SessionHeader)).toHaveLength(1);
    expect(page.root.findByType(Transcript).props.daemonId).toBe('alpha');
    expect(page.root.findByType(Transcript).props.entries[0].text).toBe('The daemon answered.');
    expect(page.root.findByProps({ className: 'fy-composer' })).toBeDefined();
    expect(buttonNamed(page.root, 'Files')).toBeDefined();
    expect(buttonNamed(page.root, 'Terminal')).toBeDefined();
    expect(buttonNamed(page.root, 'Browser unavailable').props.disabled).toBe(true);
    expect(buttonNamed(page.root, 'Interrupt turn')).toBeDefined();
    expect(buttonNamed(page.root, 'Stop session')).toBeDefined();
  });

  test('runs lifecycle actions through the visible daemon and confirms stop before mutating', async () => {
    const calls: string[] = [];
    const published: SessionView[] = [];
    let refreshes = 0;
    const next = sessionView('shared', { state: { status: 'interrupted' } });
    const page = render(
      <SessionChatPage
        client={client(calls, next)}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onRefresh={() => {
          refreshes += 1;
        }}
        onSessionChange={view => published.push(view)}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );

    await runAsync(async () => {
      buttonNamed(page.root, 'Interrupt turn').props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual(['interrupt:shared']);
    expect(published).toEqual([next]);
    expect(refreshes).toBe(1);

    run(() => buttonNamed(page.root, 'Stop session').props.onClick());
    expect(calls).toEqual(['interrupt:shared']);
    expect(buttonNamed(page.root, 'Confirm stop')).toBeDefined();
    await runAsync(async () => {
      buttonNamed(page.root, 'Confirm stop').props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual(['interrupt:shared', 'stop:shared:stopped from the PWA session workspace']);
  });

  test('shows a structured question instead of the composer and fails closed while its payload is missing', () => {
    const pending = sessionView('shared', {
      state: {
        status: 'awaiting_question',
        pendingQuestion: {
          toolUseId: 'ask-1',
          questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        },
      },
    });
    const page = render(
      <SessionChatPage
        client={client([], pending)}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="sheet"
        session={pending}
      />,
    );

    expect(page.root.findAllByType(QuestionForm)).toHaveLength(1);
    expect(page.root.findAllByProps({ className: 'fy-composer' })).toHaveLength(0);

    run(() =>
      page.update(
        <SessionChatPage
          client={client([], pending)}
          connection={alpha}
          entries={[]}
          onBack={() => undefined}
          onSessionChange={() => undefined}
          presentation="sheet"
          session={sessionView('shared', { state: { status: 'awaiting_question', pendingQuestion: null } })}
        />,
      ),
    );
    expect(page.root.findAllByType(QuestionForm)).toHaveLength(0);
    expect(JSON.stringify(page.toJSON())).toContain('Question details have not loaded yet');
    expect(page.root.findAllByProps({ className: 'fy-composer' })).toHaveLength(0);
  });
});
