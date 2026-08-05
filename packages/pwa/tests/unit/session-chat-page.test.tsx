import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ComponentProps, ReactElement } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import { ComposerRuntime } from '../../src/components/composer-runtime.tsx';
import { FileInstanceSurface } from '../../src/components/file-instance-surface.tsx';
import { FilesTab } from '../../src/components/files-tab.tsx';
import { MigrateSheet } from '../../src/components/migrate-sheet.tsx';
import { QuestionForm } from '../../src/components/question-form.tsx';
import { RenameSheet } from '../../src/components/rename-sheet.tsx';
import type { RuntimeModelControls } from '../../src/components/runtime-controls.tsx';
import { SessionHeader } from '../../src/components/session-header.tsx';
import { SessionTerminalSurface } from '../../src/components/session-terminal-surface.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import { SessionSearchProvider } from '../../src/features/session-search/session-search.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { type SessionChatClient, SessionChatPage } from '../../src/lib/pages/session-chat-page.tsx';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { BottomSheet } from '../../src/shell/bottom-sheet.tsx';
import { openSidePaneTab, registerSidePaneTab, resetSidePaneTabsStates } from '../../src/shell/side-pane-tab-model.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';
import { taskSummary } from '../support/tasks.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});

const originalFetch = globalThis.fetch;

const route = (input: string | URL | Request): Response => {
  const url = String(input);
  if (url.includes('/v1/sessions/') && url.endsWith('/tasks')) return Response.json({ tasks: [] });
  return Response.json(url.endsWith('/changes') ? { repo: false, changes: [] } : { entries: [] });
};

/** Mirrors the session route's required search boundary around the chat page. */
const withSessionSearch = (page: ReactElement<ComponentProps<typeof SessionChatPage>>): ReactElement => (
  <SessionSearchProvider
    connection={page.props.connection}
    focusSignal={0}
    scope={daemonSessionScope(page.props.connection, page.props.session.config.id)}
  >
    {page}
  </SessionSearchProvider>
);

const renderSessionChatPage = (page: ReactElement<ComponentProps<typeof SessionChatPage>>) =>
  render(withSessionSearch(page));

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request) => route(input)) as typeof fetch;
});

afterEach(() => {
  resetSidePaneTabsStates();
  globalThis.fetch = originalFetch;
});

const buttonNamed = (root: ReactTestInstance, label: string): ReactTestInstance => {
  const button = root.findAllByType('button').find(candidate => candidate.children.join('') === label);
  if (button === undefined) throw new Error(`missing ${label} button`);
  return button;
};

const client = (calls: string[], next: SessionView): SessionChatClient =>
  ({
    send: async () => ({ accepted: true }),
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
    const page = renderSessionChatPage(
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

  test('mounts runtime controls only when the paired client can invoke the runtime route', () => {
    const next = sessionView('shared');
    const runtimeClient: SessionChatClient = {
      ...client([], next),
      runtime: async () => next,
    };
    const page = renderSessionChatPage(
      <SessionChatPage
        client={runtimeClient}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        session={next}
      />,
    );
    try {
      const runtime = page.root.findByType(ComposerRuntime);
      expect(runtime.props.view.config.id).toBe('shared');
      expect(runtime.props.canControl).toBe(true);
    } finally {
      run(() => page.unmount());
    }
  });

  test('fences a composer runtime command to its live daemon and publishes its returned observation', async () => {
    const next = sessionView('shared', { state: { observedModel: 'gpt-5.6-sol' } });
    const calls: Array<{ id: string; command: unknown; requestId: string | undefined }> = [];
    const published: SessionView[] = [];
    const runtimeClient: SessionChatClient = {
      ...client([], next),
      runtime: async (id, command, requestId) => {
        calls.push({ id, command, requestId });
        return next;
      },
    };
    const page = renderSessionChatPage(
      <SessionChatPage
        client={runtimeClient}
        connection={alpha}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={view => published.push(view)}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    try {
      const composerRuntime = page.root.findByType(ComposerRuntime);
      const modelControls = composerRuntime.props.renderModelControls({
        open: true,
        onClose: () => undefined,
        onClaudeEffortSent: () => undefined,
        onSwitchFailed: () => undefined,
        onSwitchSubmitted: () => undefined,
      }) as ReactElement<ComponentProps<typeof RuntimeModelControls>>;

      await runAsync(() =>
        modelControls.props.api.runtime(alpha, 'shared', { action: 'model' }, 'runtime-observation'),
      );
      expect(calls).toEqual([{ id: 'shared', command: { action: 'model' }, requestId: 'runtime-observation' }]);
      expect(published).toEqual([next]);

      await expect(
        modelControls.props.api.runtime(
          daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceToken: 'beta-token' }),
          'shared',
          { action: 'model' },
          'foreign-runtime',
        ),
      ).rejects.toThrow('runtime control belongs to a session that is no longer active');
      expect(calls).toHaveLength(1);
    } finally {
      run(() => page.unmount());
    }
  });

  test('states the missing browser pane in visible text rather than a disabled control', () => {
    const page = renderSessionChatPage(
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
    const page = renderSessionChatPage(
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
      const page = renderSessionChatPage(
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
    const page = renderSessionChatPage(
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
      // Absent settings leave the optional dictation slot genuinely empty
      // rather than handing the composer an undefined it must re-check.
      expect('dictationSettings' in page.root.findByType(Composer).props).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test('forwards browser-local dictation settings to the composer when the app has them', () => {
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        dictationSettings={DEFAULT_STT_SETTINGS}
        entries={[]}
        onBack={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    try {
      expect(page.root.findByType(Composer).props.dictationSettings).toBe(DEFAULT_STT_SETTINGS);
    } finally {
      run(() => page.unmount());
    }
  });

  test('runs lifecycle actions through the visible daemon and confirms stop before mutating', async () => {
    const calls: string[] = [];
    const published: SessionView[] = [];
    let refreshes = 0;
    const next = sessionView('shared', { state: { status: 'interrupted' } });
    const page = renderSessionChatPage(
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
    const page = renderSessionChatPage(
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
        withSessionSearch(
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
      ),
    );
    await runAsync(async () => {
      buttonNamed(page.root, 'Interrupt turn').props.onClick();
      await Promise.resolve();
    });
    expect(JSON.stringify(page.toJSON())).toContain('Session action failed: daemon offline');
    run(() => page.unmount());
  });

  test('renders each supported pane surface and current-session task search', async () => {
    const searchTask = {
      ...taskSummary({ id: 'F6', title: 'Needle task' }),
      ask: { source: 'human', text: 'Find the needle' },
      clarifications: [],
      description: 'A task used to prove the current-session search action.',
      sessionId: 'shared',
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tasks/F6'))
        return Response.json({ activity: [], sessionId: 'shared', task: searchTask });
      if (url.pathname.endsWith('/tasks')) return Response.json({ tasks: [searchTask] });
      if (url.pathname.endsWith('/fs')) return Response.json({ entries: [{ name: 'needle.ts', type: 'file' }] });
      return Response.json(url.pathname.endsWith('/changes') ? { repo: false, changes: [] } : { entries: [] });
    }) as typeof fetch;
    const page = renderSessionChatPage(
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
      await runAsync(async () => {
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      });
      const input = page.root.findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      const results = page.root.find(node => String(node.props.className).includes('z-[80]')).findAllByType('button');
      expect(results).toHaveLength(2);
      run(() => results[1]?.props.onClick());

      // ONE TAB PER FILE (#35): a file tab renders ITS file, not the picker.
      await runAsync(async () => await Promise.resolve());
      expect(page.root.findAllByType(FileInstanceSurface)).toHaveLength(1);
      expect(page.root.findAllByType(FileInstanceSurface)[0]?.props.instance.key).toBe('needle.ts');
      expect(page.root.findAllByType(FilesTab)).toHaveLength(0);
    } finally {
      run(() => page.unmount());
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
    const unregisterUnwired = registerSidePaneTab({
      id: 'unwired-proof',
      label: 'Unwired proof',
      shortLabel: 'Unwired',
      closeLabel: 'Close unwired proof',
      icon: 'tasks',
      order: 76,
    });
    openSidePaneTab(daemonSessionScope(alpha, 'shared'), 'workspace-proof');
    const page = renderSessionChatPage(
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
      run(() => openSidePaneTab(daemonSessionScope(alpha, 'shared'), 'unwired-proof'));
      expect(JSON.stringify(page.toJSON())).toContain('Unwired proof is ported but is not connected');
    } finally {
      run(() => page.unmount());
      unregister();
      unregisterUnwired();
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
    const page = renderSessionChatPage(
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
          withSessionSearch(
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
        ),
      );
      expect(page.root.findAllByProps({ 'data-question-unavailable': '' }).length).toBeGreaterThan(0);
      expect(page.root.findAllByProps({ className: 'fy-composer' })).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });

  test('renders the refresh error verbatim and never as a second live region', () => {
    const page = renderSessionChatPage(
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
