import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';

import { FilesTab } from '../../src/components/files-tab.tsx';
import { MigrateSheet } from '../../src/components/migrate-sheet.tsx';
import { QuestionForm } from '../../src/components/question-form.tsx';
import { RenameSheet } from '../../src/components/rename-sheet.tsx';
import { SessionHeader } from '../../src/components/session-header.tsx';
import { SessionTerminalSurface } from '../../src/components/session-terminal-surface.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { type SessionChatClient, SessionChatPage } from '../../src/lib/pages/session-chat-page.tsx';
import { BottomSheet } from '../../src/shell/bottom-sheet.tsx';
import { openSidePaneTab, registerSidePaneTab, resetSidePaneTabsStates } from '../../src/shell/side-pane-tab-model.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
});

afterEach(() => resetSidePaneTabsStates());

const buttonNamed = (root: ReactTestInstance, label: string): ReactTestInstance => {
  const button = root.findAllByType('button').find(candidate => candidate.children.join('') === label);
  if (button === undefined) throw new Error(`missing ${label} button`);
  return button;
};

const client = (calls: string[], next: SessionView): SessionChatClient =>
  ({
    send: async () => ({ accepted: true }),
    answer: async () => next,
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
    run(() => page.unmount());
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

    run(() => buttonNamed(page.root, 'Rename…').props.onClick());
    expect(page.root.findByType(RenameSheet).props.open).toBe(true);
    run(() => page.root.findByType(RenameSheet).props.onClose());
    expect(page.root.findByType(RenameSheet).props.open).toBe(false);

    run(() => buttonNamed(page.root, 'Move account + relaunch…').props.onClick());
    expect(page.root.findByType(MigrateSheet).props.open).toBe(true);
    run(() => page.root.findByType(MigrateSheet).props.onClose());
    expect(page.root.findByType(MigrateSheet).props.open).toBe(false);

    run(() => page.root.findByType(SessionHeader).props.onOpenDetails());
    expect(
      page.root
        .findAllByType(BottomSheet)
        .some(sheet => sheet.props.ariaLabel === 'Session details' && sheet.props.open === true),
    ).toBe(true);
    run(() => page.unmount());
  });

  test('resumes finished sessions, reports lifecycle failures, and fences a wrong-session answer', async () => {
    const calls: string[] = [];
    const finished = sessionView('shared', { state: { status: 'completed' } });
    const page = render(
      <SessionChatPage
        client={client(calls, sessionView('shared', { state: { status: 'running' } }))}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        session={finished}
      />,
    );

    await runAsync(async () => {
      buttonNamed(page.root, 'Resume session').props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual(['resume:shared']);

    const failing = {
      ...client([], finished),
      interrupt: async () => await Promise.reject('daemon offline'),
    } as SessionChatClient;
    run(() =>
      page.update(
        <SessionChatPage
          client={failing}
          connection={alpha}
          entries={[]}
          onBack={() => undefined}
          onSessionChange={() => undefined}
          presentation="pane"
          session={sessionView('shared')}
        />,
      ),
    );
    await runAsync(async () => {
      buttonNamed(page.root, 'Interrupt turn').props.onClick();
      await Promise.resolve();
    });
    expect(JSON.stringify(page.toJSON())).toContain('Session action failed: daemon offline');
    run(() => page.unmount());
  });

  test('renders each supported pane surface and an honest placeholder for unwired catalogue tabs', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      return Response.json(url.endsWith('/changes') ? { repo: false, changes: [] } : { entries: [] });
    }) as typeof fetch;
    const page = render(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        readSnapshot={async () => 'paired snapshot'}
        session={sessionView('shared')}
      />,
    );
    try {
      run(() => buttonNamed(page.root, 'Files').props.onClick({ currentTarget: null }));
      expect(page.root.findAllByType(FilesTab)).toHaveLength(1);
      await runAsync(async () => await Promise.resolve());

      run(() => buttonNamed(page.root, 'Terminal').props.onClick({ currentTarget: null }));
      expect(page.root.findAllByType(SessionTerminalSurface)).toHaveLength(1);
      await runAsync(async () => await Promise.resolve());
      expect(JSON.stringify(page.toJSON())).toContain('paired snapshot');

      run(() => openSidePaneTab(daemonSessionScope(alpha, 'shared'), 'tasks'));
      expect(JSON.stringify(page.toJSON())).toContain('Tasks is ported but is not connected');
    } finally {
      run(() => page.unmount());
      globalThis.fetch = originalFetch;
    }
  });

  test('dispatches registered pane renderers with the visible daemon scope', () => {
    const unregister = registerSidePaneTab({
      id: 'workspace-proof',
      label: 'Workspace proof',
      shortLabel: 'Proof',
      closeLabel: 'Close proof',
      icon: 'tasks',
      order: 75,
      render: ({ scope, cwd }) => <p data-workspace-proof="">{`${scope.daemonId}:${scope.sessionId}:${cwd}`}</p>,
    });
    openSidePaneTab(daemonSessionScope(alpha, 'shared'), 'workspace-proof');
    const page = render(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="sheet"
        session={sessionView('shared')}
      />,
    );
    try {
      expect(page.root.findByProps({ 'data-workspace-proof': '' }).children.join('')).toBe('alpha:shared:/work/shared');
    } finally {
      run(() => page.unmount());
      unregister();
    }
  });

  test('shows a structured question instead of the composer and fails closed while its payload is missing', async () => {
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

    const answer = page.root.findByType(QuestionForm).props.api;
    await expect(answer.answer(beta, 'shared', 'ask-1', ['Yes'])).rejects.toThrow(
      'question scope must belong to the visible session',
    );
    await runAsync(async () => {
      await answer.answer(alpha, 'shared', 'ask-1', ['Yes'], undefined, ['Yes']);
    });

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
    run(() => page.unmount());
  });
});
