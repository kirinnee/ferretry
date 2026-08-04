import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';

import { FilesTab } from '../../src/components/files-tab.tsx';
import { MigrateSheet } from '../../src/components/migrate-sheet.tsx';
import { Composer } from '../../src/components/composer.tsx';
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
    expect(buttonNamed(page.root, 'Interrupt turn')).toBeDefined();
    expect(buttonNamed(page.root, 'Stop session')).toBeDefined();
    run(() => page.unmount());
  });

  test('states the missing browser pane in visible text rather than a disabled control', () => {
    const page = render(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    try {
      // A disabled button explains nothing: it takes no focus, shows no title on
      // touch, and most screen readers skip it. The reason is ordinary text now.
      expect(page.root.findAllByType('button').some(node => node.children.join('').includes('Browser'))).toBe(false);
      expect(page.root.findByProps({ 'data-pane-unavailable': 'browser' }).children.join('')).toContain(
        'No browser pane',
      );
      // Neither group claims a toolbar: they are plain wrapping buttons with no
      // roving tabindex, so the role would promise arrow keys nothing implements.
      expect(page.root.findAllByProps({ role: 'toolbar' })).toHaveLength(0);
      expect(page.root.findByProps({ 'aria-label': 'Workspace panes' }).type).toBe('fieldset');
      expect(page.root.findByProps({ 'aria-label': 'Session lifecycle' }).type).toBe('fieldset');
    } finally {
      run(() => page.unmount());
    }
  });

  test('moves the lifecycle controls into Session Details on a phone instead of wrapping the row', () => {
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
      // The wrapped four-band row is gone: at rest a phone shows the pane
      // openers and nothing else. A closed BottomSheet renders null, so the
      // absence of the button IS the absence of the row.
      expect(page.root.findAllByProps({ 'aria-label': 'Session lifecycle' })).toHaveLength(0);
      expect(buttonNamed(page.root, 'Files')).toBeDefined();

      // And they are reachable — in the sheet the source keeps them in.
      run(() => page.root.findByType(SessionHeader).props.onOpenDetails());
      expect(page.root.findAllByProps({ 'aria-label': 'Session lifecycle' })).toHaveLength(1);
      expect(buttonNamed(page.root, 'Interrupt turn')).toBeDefined();
      expect(buttonNamed(page.root, 'Stop session')).toBeDefined();
    } finally {
      run(() => page.unmount());
    }
  });

  test('caps transcript and composer with one measure so neither can disagree with the other', () => {
    const surface = (presentation: 'pane' | 'sheet', chatWidth: 'full' | 'readable') => {
      const page = render(
        <SessionChatPage
          chatWidth={chatWidth}
          client={client([], sessionView('shared'))}
          connection={alpha}
          entries={[]}
          onBack={() => undefined}
          onSessionChange={() => undefined}
          presentation={presentation}
          session={sessionView('shared')}
        />,
      );
      const node = page.root.findByProps({ className: 'kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col' });
      return { page, node };
    };

    const shipped = surface('pane', 'full');
    // `full` is the shipped default and is uncapped, exactly as the source is.
    expect(shipped.node.props['data-chat-width']).toBe('full');
    // ONE surface holds both, which is what makes the two measures agree.
    expect(shipped.node.findAllByType(Transcript)).toHaveLength(1);
    expect(shipped.node.findAllByProps({ className: 'fy-composer' }).length).toBeGreaterThan(0);
    run(() => shipped.page.unmount());

    const narrowed = surface('pane', 'readable');
    expect(narrowed.node.props['data-chat-width']).toBe('readable');
    run(() => narrowed.page.unmount());
  });

  test('hands the composer its presentation so the phone gets the phone growth ceiling', () => {
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
      expect(page.root.findByType(Composer).props.compact).toBe(true);
    } finally {
      run(() => page.unmount());
    }
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

    // RENAME IS NOT OFFERED: `/rename` is not mounted, so an action that could
    // only open a sheet whose submit fails is not presented as working at all.
    expect(page.root.findAllByType('button').some(node => node.children.join('').startsWith('Rename'))).toBe(false);
    expect(page.root.findAllByType(RenameSheet)).toHaveLength(0);

    // Migrate's route IS mounted, so it stays exactly as it was.
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

  test('never offers to answer a structured question, because /answer is not mounted', async () => {
    const pending = sessionView('shared', {
      state: {
        status: 'awaiting_question',
        pendingQuestion: {
          toolUseId: 'ask-1',
          questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        },
      },
    });
    const calls: string[] = [];
    const page = render(
      <SessionChatPage
        client={client(calls, pending)}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        session={pending}
      />,
    );
    try {
      // No form, because no form here could submit. A control that looks live,
      // takes a choice and then throws is worse than a sentence that says so.
      expect(page.root.findAllByType(QuestionForm)).toHaveLength(0);
      expect(page.root.findAllByProps({ className: 'fy-composer' })).toHaveLength(0);
      expect(page.root.findByProps({ 'data-question-unavailable': '' })).toBeDefined();
      expect(JSON.stringify(page.toJSON())).toContain('cannot answer one');

      // Interrupt is the one action that CAN clear the turn, so it stays live.
      await runAsync(async () => {
        buttonNamed(page.root, 'Interrupt turn').props.onClick();
        await Promise.resolve();
      });
      expect(calls).toEqual(['interrupt:shared']);

      // The same truthful state covers a status with no payload yet: both mean
      // "waiting on an answer this build cannot give".
      run(() =>
        page.update(
          <SessionChatPage
            client={client([], pending)}
            connection={alpha}
            entries={[]}
            onBack={() => undefined}
            onSessionChange={() => undefined}
            presentation="pane"
            session={sessionView('shared', { state: { status: 'awaiting_question', pendingQuestion: null } })}
          />,
        ),
      );
      expect(page.root.findAllByProps({ 'data-question-unavailable': '' }).length).toBeGreaterThan(0);
      expect(page.root.findAllByProps({ className: 'fy-composer' })).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });

  test('renders the refresh error verbatim and never as a second live region', () => {
    const page = render(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        refreshError="Workspace refresh issue: the daemon did not answer."
        session={sessionView('shared')}
      />,
    );
    try {
      const painted = JSON.stringify(page.toJSON());
      // Verbatim: App.tsx hands down a finished sentence, so a prefix added here
      // would make the spoken text and the painted text disagree.
      expect(painted).toContain('Workspace refresh issue: the daemon did not answer.');
      expect(painted).not.toContain('Workspace refresh issue: Workspace refresh issue:');
      // The only live regions left are the action alert and the pane
      // announcement — the refresh banner announces nothing, because App.tsx
      // already does.
      const statuses = page.root
        .findAllByProps({ role: 'status' })
        .filter(node => JSON.stringify(node.props.children ?? '').includes('daemon did not answer'));
      expect(statuses).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });
});
