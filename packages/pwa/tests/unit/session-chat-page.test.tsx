import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type HarnessDialog,
  MCP_OAUTH_PATH,
  matchesSessionSearchQuery,
  type PermissionRequest,
  type SessionView,
  sessionSearchTaskHaystack,
} from '@ferretry/protocol';
import { type FyApiClient, FyHttpError } from '@ferretry/protocol/client';
import { Copy } from 'lucide-react';
import { type ComponentProps, cloneElement, type ReactElement } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import { ComposerRuntime } from '../../src/components/composer-runtime.tsx';
import { FileInstanceSurface } from '../../src/components/file-instance-surface.tsx';
import { FilesTab } from '../../src/components/files-tab.tsx';
import { HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { MigrateSheet } from '../../src/components/migrate-sheet.tsx';
import { QuestionForm } from '../../src/components/question-form.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import type { RuntimeModelControls } from '../../src/components/runtime-controls.tsx';
import { SessionTopBar, sessionDisplayName } from '../../src/components/session-top-bar.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import { SessionAnalyticsSurface } from '../../src/features/analytics/session-analytics-surface.tsx';
import { AgendaDrawer, AgendaLine, AgendaReferenceChips } from '../../src/features/agenda/agenda-line.tsx';
import { AgendaRow } from '../../src/features/agenda/agenda-row.tsx';
import { AgendaItemView } from '../../src/features/agenda/agenda-item-view.tsx';
import { ContextRailBody } from '../../src/features/context-rail/context-rail-body.tsx';
import { DialogCard } from '../../src/features/harness-dialog/dialog-card.tsx';
import { ApprovalCard } from '../../src/features/permission-request/approval-card.tsx';
import { ActionToast } from '../../src/features/session-actions/action-toast.tsx';
import { ActionsMenu } from '../../src/features/session-actions/actions-menu.tsx';
import { AddMcpForm } from '../../src/features/session-actions/add-mcp-form.tsx';
import { ConvertSheet } from '../../src/features/session-actions/convert-sheet.tsx';
import type { CoreActionContext } from '../../src/features/session-actions/core-actions.ts';
import { ForkForm } from '../../src/features/session-actions/fork-form.tsx';
import type { SessionActionContribution } from '../../src/features/session-actions/registry.ts';
import { RenameForm } from '../../src/features/session-actions/rename-form.tsx';
import { SessionInfo } from '../../src/features/session-info/session-info.tsx';
import { SessionSearchProvider, SessionTasksSearchSurface } from '../../src/features/session-search/session-search.tsx';
import { SessionWorkspace } from '../../src/features/workspace/session-workspace.tsx';
import { WorkspaceView } from '../../src/features/workspace/workspace-view.tsx';
import { TOUCH_SELECTION_RELEASE_SETTLE_MS } from '../../src/hooks/use-live-clock.ts';
import { DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { DaemonAgendaClient } from '../../src/lib/agenda-client.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { createLiveActivityHub, type LiveActivityFeed } from '../../src/lib/live-activity-feed.ts';
import { daemonSessionPath } from '../../src/lib/pages/routes.ts';
import {
  type SessionAgendaModel,
  type SessionChatClient,
  SessionChatPage,
} from '../../src/lib/pages/session-chat-page.tsx';
import { DaemonClientProvider } from '../../src/lib/store.tsx';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { createSurfaceEventHub } from '../../src/lib/surface-control.ts';
import { DaemonUsageStore } from '../../src/lib/usage-store.ts';
import { WorkspaceLayoutStore } from '../../src/lib/workspace-layout-store.ts';
import { WorkspaceRailPreferenceStore } from '../../src/lib/workspace-rail-preferences.ts';
import { BottomSheet } from '../../src/shell/bottom-sheet.tsx';
import { resetSidePaneTabsStates } from '../../src/shell/side-pane-tab-model.ts';
import { fakeDeck, terminalListing, terminalView } from '../support/terminal-deck.ts';
import { factoryFor } from './features/fleet/mcp-sign-in-support.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';
import { settleUntil } from '../support/settle.ts';
import { taskSummary } from '../support/tasks.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});

/** No browser storage behind a store: `undefined` would fall back to the shared localStorage. */
const NO_STORAGE = { getItem: () => null, setItem: () => undefined };

const originalFetch = globalThis.fetch;

/** The session id this URL addresses, so a fixture answers under the scope that asked. */
const sessionIdOf = (url: URL): string =>
  decodeURIComponent(url.pathname.split('/v1/sessions/')[1]?.split('/')[0] ?? '');

/**
 * An EMPTY but protocol-shaped answer for the search provider every session page
 * mounts.
 *
 * `/fs/index` is matched FIRST and deliberately: it does not end with `/fs`, so
 * a ladder that tests the listing route first answers the index with a directory
 * listing, the document fails its schema, and every page test quietly runs with
 * `fileState: 'unavailable'`. Tests that only assert focus would still pass —
 * which is exactly how that regression stays invisible.
 */
const route = (input: string | URL | Request): Response => {
  const raw = String(input);
  const url = new URL(raw, 'https://fixture.example.test');
  const sessionId = sessionIdOf(url);
  if (url.pathname.endsWith('/fs/index'))
    return Response.json({ v: 1, sessionId, root: `/work/${sessionId}`, files: [], coverage: 'complete', skipped: [] });
  if (url.pathname.endsWith('/mcp'))
    return Response.json({ project: { path: `/work/${sessionId}/.mcp.json`, etag: null, servers: [] } });
  if (url.pathname.includes('/v1/sessions/') && url.pathname.endsWith('/tasks'))
    return Response.json({ v: 1, sessionId, tasks: [], parseErrors: 0, updatedAt: '2026-08-06T00:00:00.000Z' });
  return Response.json(url.pathname.endsWith('/changes') ? { repo: false, changes: [] } : { entries: [] });
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

/**
 * Every mount gets its OWN layout and rail stores with no storage behind them, so one case's open tabs
 * can never leak into the next, and a desktop form factor unless the case asks for another — the
 * window size a test runner reports is not a screen anybody chose.
 */
const renderSessionChatPage = (
  page: ReactElement<ComponentProps<typeof SessionChatPage>>,
  daemon?: (connection: unknown) => Promise<FyApiClient>,
) => {
  const tree = withSessionSearch(
    cloneElement(page, {
      workspaceLayouts: page.props.workspaceLayouts ?? new WorkspaceLayoutStore(NO_STORAGE),
      workspaceRails: page.props.workspaceRails ?? new WorkspaceRailPreferenceStore(NO_STORAGE),
      formFactor: page.props.formFactor ?? (page.props.presentation === 'sheet' ? 'phone' : 'desktop'),
    }),
  );
  return render(daemon === undefined ? tree : <DaemonClientProvider client={daemon}>{tree}</DaemonClientProvider>);
};

// The transcript-hold gate is one module for the whole process. A tree an earlier file left mounted
// keeps it attached, and a press it never released (row-context-gesture fires touch pointer 1 without
// a pointerup) latches it for up to its 20 s cap — freezing every Transcript this file renders. A blur
// ends any held gesture whatever its pointer ids, and a touch release then settles on a timer, so wait
// that out once before the first test.
beforeAll(async () => {
  window.dispatchEvent(new Event('blur'));
  await Bun.sleep(TOUCH_SELECTION_RELEASE_SETTLE_MS + 30);
});

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

const buttonWithLabelSpan = (root: ReactTestInstance, label: string): ReactTestInstance => {
  const button = root
    .findAllByType('button')
    .find(candidate => candidate.findAllByType('span').some(span => span.children.join('') === label));
  if (button === undefined) throw new Error(`missing ${label} button`);
  return button;
};

/** A lifecycle button in the session bar, by the full name it announces. */
const barAction = (root: ReactTestInstance, label: string): ReactTestInstance => {
  const button = root.findAllByType('button').find(candidate => candidate.props['aria-label'] === label);
  if (button === undefined) throw new Error(`missing ${label} in the session bar`);
  return button;
};

const hasBarAction = (root: ReactTestInstance, label: string): boolean =>
  root.findAllByType('button').some(candidate => candidate.props['aria-label'] === label);

/** The text a node renders, read from the tree rather than by serialising props that may hold elements. */
const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('');

/** Actions ▾, the header's one place for doing things. */
const actionsTrigger = (root: ReactTestInstance): ReactTestInstance =>
  root.findByProps({ 'data-session-actions-trigger': '' });

const openActions = (root: ReactTestInstance): void => {
  if (actionsTrigger(root).props['aria-expanded'] !== true) run(() => actionsTrigger(root).props.onClick());
};

const actionRows = (root: ReactTestInstance): readonly ReactTestInstance[] =>
  root.findAll(node => node.type === 'button' && node.props['data-session-action-item'] !== undefined);

/** The rows Actions ▾ offers, by their label, read with the menu open and left as it was found. */
const actionLabels = (root: ReactTestInstance): readonly string[] => {
  const wasOpen = actionsTrigger(root).props['aria-expanded'] === true;
  openActions(root);
  const labels = actionRows(root).map(row => textOf(row.findByProps({ className: 'fy-actions-menu__label' })));
  if (!wasOpen) run(() => actionsTrigger(root).props.onClick());
  return labels;
};

/** Opens Actions ▾ and chooses one row by its action id. */
const chooseAction = (root: ReactTestInstance, id: string): void => {
  openActions(root);
  const row = actionRows(root).find(candidate => candidate.props['data-session-action-item'] === id);
  if (row === undefined) throw new Error(`missing ${id} in Actions`);
  run(() => row.props.onClick());
};

/** Lets every queued promise in a chain of daemon calls settle. */
const flush = async (turns = 8): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  });
};

/** The "needs you" button the status carries while the session has unanswered Attention. */
const needsYouButtons = (root: ReactTestInstance): readonly ReactTestInstance[] =>
  root.findAll(node => node.type === 'button' && node.props['data-needs-you'] !== undefined);

const client = (calls: string[], next: SessionView): SessionChatClient =>
  ({
    answer: async (_id: string, toolUseId: string) => {
      calls.push(`answer:${toolUseId}`);
      return next;
    },
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

/**
 * A client whose `runtime` is a REAL prototype method over private state.
 *
 * The shipped `DaemonApiClient` is this shape, and the defect it pins cannot be
 * seen from an arrow-function mock: an arrow ignores its receiver, so an unbound
 * call still succeeds and every test passes while the built app throws
 * `Cannot read properties of undefined` and sends nothing. Touching `#sent` is
 * what makes the receiver load-bearing — call this method detached and it dies
 * before it records anything, exactly as the minified client did.
 */
class ReceiverBoundChatClient {
  readonly #sent: { sessionId: string; command: unknown; requestId: string | undefined }[] = [];

  constructor(private readonly next: SessionView) {}

  get sent(): readonly { sessionId: string; command: unknown; requestId: string | undefined }[] {
    return this.#sent;
  }

  async answer(): Promise<SessionView> {
    return this.next;
  }
  async send(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  async interrupt(): Promise<SessionView> {
    return this.next;
  }
  async resume(): Promise<SessionView> {
    return this.next;
  }
  async stop(): Promise<SessionView> {
    return this.next;
  }
  async runtime(sessionId: string, command: unknown, requestId?: string): Promise<SessionView> {
    this.#sent.push({ sessionId, command, requestId });
    return this.next;
  }
}

/**
 * What Info reads through, beyond the page: the Agenda ledger (refused here, so Signals is honest
 * about an unread board) and a fleet whose MCP catalogue is empty.
 */
const contextDependencies = (): NonNullable<ComponentProps<typeof SessionChatPage>['context']> => ({
  attention: new DaemonAgendaClient(undefined, async () => Response.json({}, { status: 503 })),
  createFleetClient: factoryFor({
    'GET /v1/fleet/components': { format: 'version-2', kinds: [] },
    [`GET ${MCP_OAUTH_PATH}`]: { connections: [] },
    // What Info › Context reads: every MCP server and skill the ferret sees (docs/mcp-scopes.md).
    'GET /v1/sessions/shared/mcp/servers': {
      problems: [],
      servers: [
        {
          id: 'id-ferretry',
          name: 'ferretry',
          scope: 'ferretry',
          harness: 'claude',
          transport: 'stdio',
          target: 'fy mcp serve',
          runtimes: [{ runtime: 'claude-auto' }],
        },
      ],
    },
    'GET /v1/sessions/shared/skills/inventory': {
      sessionId: 'shared',
      harness: 'claude',
      truncated: false,
      skills: [
        {
          name: 'floop',
          description: 'Review until satisfied.',
          harness: 'claude',
          scope: 'user',
          path: '/fy/fleet/homes/claude-auto/skills/floop/SKILL.md',
          runtimes: ['claude-auto'],
        },
      ],
    },
  }),
  machineName: 'alpha box',
});

/**
 * The carrier-routed typed client the page reaches for rename, fork, migrate, worktrees and the
 * Warden's verdicts — recording each call in a line a test can read. Any other route refuses.
 */
const fakeDaemon = (options: { readonly migrate?: Error | readonly (Error | undefined)[] } = {}) => {
  const calls: string[] = [];
  /** Every migrate request: its id and whether it forced past the in-flight check. */
  const requests: { readonly requestId: string; readonly forceInflight: unknown; readonly conversation?: unknown }[] =
    [];
  let migrations = 0;
  const api = {
    rename: async (id: string, name?: string, teammate?: string, clearParent?: boolean) => {
      calls.push(`rename:${id}:${name}:${teammate}:${clearParent}`);
      return sessionView(id, { config: { label: name ?? 'renamed' } });
    },
    migrate: async (
      id: string,
      agent: string,
      account: unknown,
      force: unknown,
      requestId: string,
      forceInflight?: unknown,
      conversation?: unknown,
    ) => {
      requests.push({ requestId, forceInflight, ...(conversation === undefined ? {} : { conversation }) });
      const scripted = Array.isArray(options.migrate) ? options.migrate[migrations] : options.migrate;
      migrations += 1;
      if (scripted !== undefined) throw scripted;
      calls.push(
        `migrate:${id}:${agent}:${String(account)}:${String(force)}:${requestId.startsWith(`restart-${id}-`)}`,
      );
      return sessionView(id, { state: { status: 'running' } });
    },
    messages: async (id: string) => {
      calls.push(`messages:${id}`);
      return { messages: [{ point: 'point-9', selectionBinding: 'binding-9' }], nextCursor: null };
    },
    fork: async (id: string, request: { readonly through: string; readonly agent: string }) => {
      calls.push(`fork:${id}:${request.through}:${request.agent}`);
      return { session: { id: 'forked' }, plan: {} };
    },
    // The page's own surface hooks ask for the browser and control views too; those are not recorded.
    request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
      if (path !== '/v1/worktrees') throw new Error(`no ${path} here`);
      calls.push(`request:${path}`);
      return schema.parse({ worktrees: [] });
    },
    wardenVerdicts: async () => {
      calls.push('verdicts');
      return [];
    },
  };
  return { calls, requests, factory: async () => api as unknown as FyApiClient };
};

describe('SessionChatPage', () => {
  test('names the ferret that started this one in the header, as a link to it', () => {
    const parent = sessionView('boss', { config: { teammate: 'hadi' } });
    const child = sessionView('kid', { config: { parent: 'boss' } });
    const opened: string[] = [];
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], child)}
        connection={alpha}
        daemonSessions={[parent, child]}
        entries={[]}
        onNavigate={to => opened.push(to)}
        onSessionChange={() => undefined}
        presentation="pane"
        session={child}
      />,
    );
    try {
      const link = page.root.findByProps({ 'data-session-started-by': '' });
      expect(textOf(link)).toBe('Started by Hadi · Session boss');
      run(() => link.props.onClick());
      expect(opened).toEqual(['/d/alpha/session/boss']);
    } finally {
      run(() => page.unmount());
    }
  });

  test('draws no "Started by" for a ferret nobody started, or one whose parent is unknown', () => {
    const lone = sessionView('lone', { config: { parent: 'ghost' } });
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], lone)}
        connection={alpha}
        daemonSessions={[lone]}
        entries={[]}
        onNavigate={() => undefined}
        onSessionChange={() => undefined}
        presentation="pane"
        session={lone}
      />,
    );
    try {
      expect(page.root.findAllByProps({ 'data-session-started-by': '' })).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });

  test('threads the daemon account and cached usage stores into migration', () => {
    const accountPicker = new DaemonAccountPickerStore({
      catalog: async () => ({ accounts: [] }),
      health: async () => ({ health: new Map(), error: null }),
      checkHealth: async () => ({ health: new Map(), error: null }),
    });
    const usage = new DaemonUsageStore({ usage: async () => ({ stale: false, accounts: [] }) });
    const page = renderSessionChatPage(
      <SessionChatPage
        accountPicker={accountPicker}
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
        usage={usage}
      />,
    );

    try {
      const migrate = page.root.findByType(MigrateSheet);
      expect(migrate.props.accountPicker).toBe(accountPicker);
      expect(migrate.props.usage).toBe(usage);
    } finally {
      run(() => page.unmount());
    }
  });

  test('renders the proved transcript, composer, controls, and honest pane launchers', () => {
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[{ id: 'one', kind: 'assistant', label: 'Assistant', text: 'The daemon answered.' }]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared', { config: { teammate: 'Alpha Agent' } })}
      />,
    );

    expect(page.root.findAllByType(SessionTopBar)).toHaveLength(1);
    expect(page.root.findByType(Transcript).props.daemonId).toBe('alpha');
    expect(page.root.findByType(Transcript).props.entries[0].text).toBe('The daemon answered.');
    expect(page.root.findByProps({ className: 'fy-composer' })).toBeDefined();
    // DO is Actions ▾, grouped; the old ⋯ menu is gone.
    expect(page.root.findAllByProps({ 'data-session-more': '' })).toHaveLength(0);
    expect(actionLabels(page.root)).toEqual([
      'Rename…',
      'Fork into a new ferret…',
      'Copy session id',
      'Move to another login…',
      'Move to another machine',
      'Add MCP server…',
      'Restart CLI',
      'Go back to the earlier conversation…',
      'Stop ferret…',
    ]);
    // Moving to another machine exists but cannot be done here yet: it is dimmed, with the reason.
    openActions(page.root);
    const dimmed = actionRows(page.root).find(row => row.props['data-session-action-item'] === 'move-machine');
    expect(dimmed?.props['aria-disabled']).toBe(true);
    expect(dimmed?.props.title).toBe('later');
    run(() => dimmed?.props.onClick());
    expect(actionsTrigger(page.root).props['aria-expanded']).toBe(true);
    // LOOK is Info, and a host with nothing to show draws no ⓘ.
    expect(page.root.findByType(SessionTopBar).props.onToggleInfo).toBeUndefined();
    expect(barAction(page.root, 'Interrupt turn').children.join('')).toBe('Interrupt');
    expect(barAction(page.root, 'Stop session').children.join('')).toBe('Stop');
    run(() => page.unmount());
  });

  test('reads a message handed over through a file from this session, through the paired client', async () => {
    const asked: [string, string][] = [];
    const handoff = { name: 'turn-008', message: 'look at this', attachments: [] };
    const daemon = async () =>
      ({
        handoff: async (id: string, name: string) => {
          asked.push([id, name]);
          return handoff;
        },
      }) as unknown as FyApiClient;
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
      daemon,
    );
    const source = page.root.findByType(HandoffSourceProvider).props.source;

    expect(source.daemon).toBe(alpha);
    expect(source.sessionId).toBe('shared');
    expect(await source.read('turn-008')).toEqual(handoff);
    expect(asked).toEqual([['shared', 'turn-008']]);
    run(() => page.unmount());
  });

  test('a send returns the transcript to the tail and still refreshes the page', () => {
    let refreshed = 0;
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[{ id: 'one', kind: 'assistant', label: 'Assistant', text: 'The daemon answered.' }]}
        onRefresh={() => {
          refreshed += 1;
        }}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    expect(page.root.findByType(Transcript).props.pinSignal).toBe(0);
    run(() => page.root.findByType(Composer).props.onSent());
    expect(page.root.findByType(Transcript).props.pinSignal).toBe(1);
    expect(refreshed).toBe(1);
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

  test('opens the runtime sheet on a running session whose prompt is ready, and loads its catalog', async () => {
    // THE CHIPS ASK ABOUT THE PROMPT, AND SO, NOW, DOES THE TRANSCRIPT. This
    // page used to answer both with `statusMark(...).klass === 'active'`, which
    // is `active` for every ordinary `running` session — so both chips were dead
    // on exactly the sessions a reader works in, and the only reachable sheet
    // was on a session that happened to be `waiting`. A prompt the daemon
    // recorded as ready is also NOT working, so the transcript shows no spinner
    // and the composer sends rather than queues.
    // Arrange
    const ready = sessionView('runtime-ready', { state: { promptReady: true, status: 'running' } });
    const catalogCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/runtime-models')) {
        catalogCalls.push(new URL(url).pathname);
        return Response.json({
          harness: 'claude',
          source: 'wrapper-inventory',
          choices: [{ value: 'claude-opus-5', label: 'Opus 5', reasoningEfforts: [] }],
        });
      }
      return route(input);
    }) as typeof fetch;
    const runtimeClient: SessionChatClient = { ...client([], ready), runtime: async () => ready };
    const page = renderSessionChatPage(
      <SessionChatPage
        client={runtimeClient}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={ready}
      />,
    );

    try {
      // Assert — a ready prompt is idle to every one of them.
      expect(page.root.findByType(ComposerRuntime).props.busy).toBe(false);
      // A desktop gets the pickers as a small popover at the chip, not a sheet.
      expect(page.root.findByType(ComposerRuntime).props.presentation).toBe('popover');
      expect(page.root.findByType(Transcript).props.busy).toBe(false);
      expect(page.root.findByType(Composer).props.busy).toBe(false);

      // Act — the reader taps the chip the old gate had disabled.
      const modelChip = buttonWithLabelSpan(page.root, 'claude-opus-5');
      expect(modelChip.props.disabled).toBe(false);
      run(() => modelChip.props.onClick());
      await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 0)));

      // Assert — the sheet reached the catalog and rendered its labelled list.
      expect(catalogCalls).toEqual(['/v1/sessions/runtime-ready/runtime-models']);
      const choices = page.root.findAll(
        node =>
          node.type === 'div' &&
          node.props.role === 'menu' &&
          node.props['aria-label'] === 'Switch claude model in place',
      );
      expect(choices).toHaveLength(1);
      // The launched model is the one in force until the harness reports another.
      expect(
        (choices[0] as ReactTestInstance).findAllByType('button').map(button => button.props['aria-label']),
      ).toEqual(['Switch model in place to Opus 5, current']);
    } finally {
      run(() => page.unmount());
    }
  });

  test('keeps the runtime pickers as bottom sheets on a phone', () => {
    // Arrange
    const ready = sessionView('runtime-phone', { state: { promptReady: true, status: 'running' } });
    const page = renderSessionChatPage(
      <SessionChatPage
        client={{ ...client([], ready), runtime: async () => ready }}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="sheet"
        session={ready}
      />,
    );

    try {
      // Assert
      expect(page.root.findByType(ComposerRuntime).props.presentation).toBe('sheet');
    } finally {
      run(() => page.unmount());
    }
  });

  test('lets a running session with no reported readiness attempt the switch anyway', async () => {
    // ABSENT IS UNKNOWN, NOT BUSY. The shipping daemon omits `promptReady` for
    // idle sessions whose runtime-control POST it then accepts after inspecting
    // the live pane, so pre-refusing on a missing field takes away a control the
    // reader actually has. The chip opens, and the daemon stays the authority.
    // Arrange
    const unknown = sessionView('runtime-unknown', { state: { status: 'running' } });
    const runtimeClient: SessionChatClient = { ...client([], unknown), runtime: async () => unknown };
    const page = renderSessionChatPage(
      <SessionChatPage
        client={runtimeClient}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={unknown}
      />,
    );

    try {
      // Assert
      expect(unknown.state.promptReady).toBeUndefined();
      expect(page.root.findByType(ComposerRuntime).props.busy).toBe(false);
      const modelChip = buttonWithLabelSpan(page.root, 'claude-opus-5');
      expect(modelChip.props.disabled).toBe(false);

      // Act — the sheet opens and offers its choices rather than a refusal.
      run(() => modelChip.props.onClick());
      await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 0)));

      // Assert — no pre-refusal warning, because nothing said the prompt is busy.
      expect(
        page.root.findAll(
          node => typeof node.type === 'string' && node.children.join('').startsWith('Wait for an idle prompt before'),
        ),
      ).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });

  test('refuses the runtime chips on an explicitly busy prompt, without disabling the composer', async () => {
    // `false` is the one answer that IS evidence: the daemon said this pane is
    // mid-turn, so the refusal is stated at the trigger rather than spending a
    // tap to reach a sheet that can only say no.
    // Arrange
    const busyPrompt = sessionView('runtime-busy', { state: { promptReady: false, status: 'running' } });
    const runtimeClient: SessionChatClient = { ...client([], busyPrompt), runtime: async () => busyPrompt };
    const page = renderSessionChatPage(
      <SessionChatPage
        client={runtimeClient}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={busyPrompt}
      />,
    );

    try {
      // Assert
      expect(page.root.findByType(ComposerRuntime).props.busy).toBe(true);
      const modelChip = buttonWithLabelSpan(page.root, 'claude-opus-5');
      expect(modelChip.props.disabled).toBe(true);
      expect(modelChip.props.title).toBe('Busy: wait for an idle prompt to switch.');
      // A refused SWITCH is not a refused session: the reader may still type.
      expect(page.root.findByType(Composer).props.disabled).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test('calls the runtime route on its client, not as a detached function', async () => {
    // A REAL CLIENT IS AN OBJECT. The page has to feature-check the optional
    // route, and reading it into a local to call it lost the receiver: the built
    // app reached the handler, threw on the first private field, and sent no
    // POST. Everything else here is unchanged behaviour asserted alongside it.
    // Arrange
    const next = sessionView('shared', { state: { observedModel: 'gpt-5.6-sol' } });
    const receiver = new ReceiverBoundChatClient(next);
    const published: SessionView[] = [];
    const page = renderSessionChatPage(
      <SessionChatPage
        client={receiver as unknown as SessionChatClient}
        connection={alpha}
        entries={[]}
        onSessionChange={view => published.push(view)}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );

    try {
      const modelControls = page.root.findByType(ComposerRuntime).props.renderModelControls({
        open: true,
        onClose: () => undefined,
        onClaudeEffortSent: () => undefined,
        onSwitchFailed: () => undefined,
        onSwitchSubmitted: () => undefined,
      }) as ReactElement<ComponentProps<typeof RuntimeModelControls>>;

      // Act — this is the call that threw in production.
      await runAsync(() =>
        modelControls.props.api.runtime(alpha, 'shared', { action: 'effort', effort: 'high' }, 'r1'),
      );

      // Assert — it reached the method WITH its instance, and still publishes.
      expect(receiver.sent).toEqual([
        { sessionId: 'shared', command: { action: 'effort', effort: 'high' }, requestId: 'r1' },
      ]);
      expect(published).toEqual([next]);

      // The stale-scope guard is unchanged, and still refuses before the client.
      await expect(
        modelControls.props.api.runtime(
          daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceId: 'beta-token' }),
          'shared',
          { action: 'model' },
          'foreign',
        ),
      ).rejects.toThrow('runtime control belongs to a session that is no longer active');
      expect(receiver.sent).toHaveLength(1);
    } finally {
      run(() => page.unmount());
    }
  });

  test('rebinds the runtime route to a replaced client, not only to a changed method', async () => {
    // THE HAZARD A METHOD DEPENDENCY CANNOT SEE. `runtime` lives on the
    // prototype, so two clients of the same class expose the SAME function
    // reference. A memo keyed on `client.runtime` therefore never recomputes
    // across a client swap and keeps sending this session's commands through the
    // client that has been replaced — a stale credential, or a daemon the reader
    // has since left. Nothing else in this suite would notice: the identity that
    // has to change is the receiver, which only a real object carries.
    // Arrange
    const next = sessionView('shared');
    const previous = new ReceiverBoundChatClient(next);
    const current = new ReceiverBoundChatClient(next);
    const published: SessionView[] = [];
    // Stable across both renders, so `publish` — the memo's other dependency —
    // cannot recompute the binding for us and hide a regression.
    const onSessionChange = (view: SessionView) => published.push(view);
    const session = sessionView('shared');
    const pageFor = (chatClient: ReceiverBoundChatClient) => (
      <SessionChatPage
        client={chatClient as unknown as SessionChatClient}
        connection={alpha}
        entries={[]}
        onSessionChange={onSessionChange}
        presentation="pane"
        session={session}
      />
    );
    const page = render(withSessionSearch(pageFor(previous)));

    try {
      // The premise, stated rather than assumed: one method, two clients.
      expect(previous.runtime).toBe(current.runtime);

      // Act — the same mounted page is handed the replacement client.
      run(() => page.update(withSessionSearch(pageFor(current))));
      const modelControls = page.root.findByType(ComposerRuntime).props.renderModelControls({
        open: true,
        onClose: () => undefined,
        onClaudeEffortSent: () => undefined,
        onSwitchFailed: () => undefined,
        onSwitchSubmitted: () => undefined,
      }) as ReactElement<ComponentProps<typeof RuntimeModelControls>>;
      await runAsync(() => modelControls.props.api.runtime(alpha, 'shared', { action: 'model' }, 'r2'));

      // Assert — the live client took it, and the replaced one saw nothing.
      expect(current.sent).toEqual([{ sessionId: 'shared', command: { action: 'model' }, requestId: 'r2' }]);
      expect(previous.sent).toEqual([]);
      expect(published).toEqual([next]);
    } finally {
      run(() => page.unmount());
    }
  });

  test('withdraws the runtime controls when the replacement client has no such route', async () => {
    // The feature check is not a mount-time decision. A client swapped in for one
    // that cannot reach the route must take the chips with it, or the reader is
    // offered a switch nothing can carry.
    // Arrange
    const next = sessionView('shared');
    const onSessionChange = () => undefined;
    const session = sessionView('shared');
    const pageFor = (chatClient: SessionChatClient) => (
      <SessionChatPage
        client={chatClient}
        connection={alpha}
        entries={[]}
        onSessionChange={onSessionChange}
        presentation="pane"
        session={session}
      />
    );
    const page = render(withSessionSearch(pageFor(new ReceiverBoundChatClient(next) as unknown as SessionChatClient)));

    try {
      expect(page.root.findAllByType(ComposerRuntime)).toHaveLength(1);

      // Act — the replacement omits the optional runtime route entirely.
      run(() => page.update(withSessionSearch(pageFor(client([], next)))));

      // Assert
      expect(page.root.findAllByType(ComposerRuntime)).toHaveLength(0);
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
          daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceId: 'beta-token' }),
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

  test('keeps ONE bar: no pane-opener row, no toolbar, and no browser offer a daemon cannot keep', () => {
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        project="ferretry"
        session={sessionView('shared')}
      />,
    );
    try {
      expect(page.root.findAllByProps({ 'aria-label': 'Workspace panes' })).toHaveLength(0);
      expect(page.root.findAllByProps({ 'data-pane-unavailable': 'browser' })).toHaveLength(0);
      expect(page.root.findAllByProps({ role: 'toolbar' })).toHaveLength(0);
      expect(page.root.findAllByType('button').some(node => node.children.join('').includes('Browser'))).toBe(false);
      expect(page.root.findByType(SessionTopBar).props.project).toBe('ferretry');
      // No phone drawer opener on a page that was not handed one.
      expect(page.root.findByType(SessionTopBar).props.onOpenSessions).toBeUndefined();
    } finally {
      run(() => page.unmount());
    }
  });

  test('keeps Interrupt on a phone bar and moves Stop into Actions, behind an inline confirmation', async () => {
    const calls: string[] = [];
    let opened = 0;
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client(calls, sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onOpenSessions={() => {
          opened += 1;
        }}
        onSessionChange={() => undefined}
        presentation="sheet"
        session={sessionView('shared')}
      />,
    );
    try {
      expect(hasBarAction(page.root, 'Interrupt turn')).toBe(true);
      expect(hasBarAction(page.root, 'Stop session')).toBe(false);
      expect(actionLabels(page.root).at(-1)).toBe('Stop ferret…');
      // On a phone the trigger is an icon, named for a screen reader.
      expect(actionsTrigger(page.root).props['aria-label']).toBe('Actions');
      run(() => page.root.findByType(SessionTopBar).props.onOpenSessions());
      expect(opened).toBe(1);

      // The row turns into its question in place; nothing is stopped until it is confirmed.
      chooseAction(page.root, 'stop');
      expect(calls).toEqual([]);
      const confirm = () => page.root.findByProps({ 'data-menu-confirm': 'stop' });
      expect(textOf(confirm())).toContain(`Stop ${sessionDisplayName(sessionView('shared'))}?`);
      run(() => buttonNamed(confirm(), 'Cancel').props.onClick());
      expect(page.root.findAllByProps({ 'data-menu-confirm': 'stop' })).toHaveLength(0);
      expect(calls).toEqual([]);

      chooseAction(page.root, 'stop');
      await runAsync(async () => {
        page.root.findByProps({ 'data-menu-confirm-yes': '' }).props.onClick();
        await Promise.resolve();
      });
      await flush();
      expect(calls).toEqual(['stop:shared:stopped from the PWA session workspace']);
      expect(hasBarAction(page.root, 'Interrupt turn')).toBe(true);
    } finally {
      run(() => page.unmount());
    }
  });

  test('copies the session id from Actions and says so when the clipboard refuses', async () => {
    const copied: string[] = [];
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        copyText={async text => {
          copied.push(text);
        }}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    try {
      chooseAction(page.root, 'copy-id');
      await runAsync(async () => await Promise.resolve());
      expect(copied).toEqual(['shared']);
      expect(JSON.stringify(page.toJSON())).not.toContain('could not copy');

      run(() =>
        page.update(
          withSessionSearch(
            <SessionChatPage
              client={client([], sessionView('shared'))}
              connection={alpha}
              copyText={async () => await Promise.reject(new Error('denied'))}
              entries={[]}
              onSessionChange={() => undefined}
              presentation="pane"
              session={sessionView('shared')}
            />,
          ),
        ),
      );
      chooseAction(page.root, 'copy-id');
      await runAsync(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(JSON.stringify(page.toJSON())).toContain('could not copy the session id: denied');
    } finally {
      run(() => page.unmount());
    }
  });

  test('copies through the browser clipboard by default, and refuses where there is none', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    try {
      chooseAction(page.root, 'copy-id');
      await runAsync(async () => await Promise.resolve());
      expect(written).toEqual(['shared']);

      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      chooseAction(page.root, 'copy-id');
      await runAsync(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(JSON.stringify(page.toJSON())).toContain('this browser offers no clipboard here');
    } finally {
      run(() => page.unmount());
      if (original === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', original);
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
          onSessionChange={() => undefined}
          presentation={presentation}
          session={sessionView('shared')}
        />,
      );
      const node = page.root.findByProps({ className: 'kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col' });
      return { page, node };
    };

    const shipped = surface('pane', 'full');
    expect(shipped.node.props['data-chat-width']).toBe('full');
    // ONE surface holds both, which is what makes the two measures agree.
    expect(shipped.node.findAllByType(Transcript)).toHaveLength(1);
    expect(shipped.node.findAllByProps({ className: 'fy-composer' }).length).toBeGreaterThan(0);
    run(() => shipped.page.unmount());

    const narrowed = surface('pane', 'readable');
    expect(narrowed.node.props['data-chat-width']).toBe('readable');
    run(() => narrowed.page.unmount());
  });

  test.each([
    { subject: 'a cached copy', input: true, expected: 1 },
    { subject: 'the live copy', input: false, expected: 0 },
  ])('says "Updating…" over the transcript only for $subject', ({ input, expected }) => {
    // Arrange
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        session={sessionView('shared')}
        presentation="pane"
        updating={input}
      />,
    );

    // Act
    const actual = page.root.findAllByProps({ 'data-cache-updating': '' });

    // Assert
    expect(actual).toHaveLength(expected);
    run(() => page.unmount());
  });

  test.each([
    { subject: 'a delta in flight', updating: false, catchingUp: true, dot: 1, pill: 0 },
    { subject: 'a current cache', updating: false, catchingUp: false, dot: 0, pill: 0 },
    { subject: 'a stale cache with nothing in flight', updating: true, catchingUp: false, dot: 0, pill: 1 },
    { subject: 'the pill and the dot together', updating: true, catchingUp: true, dot: 0, pill: 1 },
  ])('shows the tiny catching-up dot only for $subject', ({ updating, catchingUp, dot, pill }) => {
    // Arrange
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        session={sessionView('shared')}
        presentation="pane"
        updating={updating}
        catchingUp={catchingUp}
      />,
    );

    // Act
    const dots = page.root.findAllByProps({ 'data-catching-up': '' });
    const pills = page.root.findAllByProps({ 'data-cache-updating': '' });

    // Assert
    expect(dots).toHaveLength(dot);
    expect(pills).toHaveLength(pill);
    run(() => page.unmount());
  });

  test('hands the transcript the reading position it was given, and none when there is none', () => {
    // Arrange
    const readingPosition = { read: () => null, write: () => undefined };
    const surface = (position?: typeof readingPosition) =>
      renderSessionChatPage(
        <SessionChatPage
          client={client([], sessionView('shared'))}
          connection={alpha}
          entries={[]}
          onSessionChange={() => undefined}
          session={sessionView('shared')}
          presentation="pane"
          {...(position === undefined ? {} : { readingPosition: position })}
        />,
      );

    // Act
    const given = surface(readingPosition);
    const absent = surface();

    // Assert
    expect(given.root.findByType(Transcript).props.readingPosition).toBe(readingPosition);
    expect(absent.root.findByType(Transcript).props.readingPosition).toBeUndefined();
    run(() => given.unmount());
    run(() => absent.unmount());
  });

  test('hands the composer its presentation so the phone gets the phone growth ceiling', () => {
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
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

  test('hands the composer the reader’s suggestion switches and Vim preference, mapped once above it', () => {
    const suggestions = {
      mentionSuggestions: false,
      ladderSuggestions: false,
      directReferenceSuggestions: true,
      skillSuggestions: false,
    };
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        composerSuggestions={suggestions}
        composerVimMode
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    try {
      // Passed through by identity: a page that rebuilt this object would make
      // the composer re-issue an open list's request on every render.
      expect(page.root.findByType(Composer).props.suggestions).toBe(suggestions);
      expect(page.root.findByType(Composer).props.vimMode).toBe(true);
    } finally {
      run(() => page.unmount());
    }
  });

  test('opens the native Codex picker through the mounted runtime sheet and shows the Console', async () => {
    const calls: Array<{ id: string; command: unknown; requestId: string | undefined }> = [];
    const codex = sessionView('shared', {
      config: { harness: 'codex' },
      state: { promptReady: true, status: 'awaiting_user' },
    });
    const runtimeClient: SessionChatClient = {
      ...client([], codex),
      runtime: async (id, command, requestId) => {
        calls.push({ id, command, requestId });
        return codex;
      },
    };
    const page = renderSessionChatPage(
      <SessionChatPage
        canControl
        client={runtimeClient}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={codex}
      />,
    );
    try {
      expect(page.root.findAllByProps({ 'data-workspace-console': '' })).toHaveLength(0);
      const modelChip = buttonWithLabelSpan(page.root, 'claude-opus-5');
      expect(modelChip.props.disabled).toBe(false);
      run(() => modelChip.props.onClick());
      await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 0)));

      const nativePicker = buttonWithLabelSpan(page.root, 'Use native picker in Terminal');
      expect(nativePicker.props.disabled).toBe(false);
      await runAsync(async () => {
        nativePicker.props.onClick();
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: 'shared', command: { action: 'model' } });
      expect(typeof calls[0]?.requestId).toBe('string');
      expect(page.root.findAllByProps({ 'data-workspace-console': '' })).toHaveLength(1);
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
        onRefresh={() => {
          refreshes += 1;
        }}
        onSessionChange={view => published.push(view)}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );

    await runAsync(async () => {
      barAction(page.root, 'Interrupt turn').props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual(['interrupt:shared']);
    expect(published).toEqual([next]);
    expect(refreshes).toBe(1);

    run(() => barAction(page.root, 'Stop session').props.onClick());
    expect(calls).toEqual(['interrupt:shared']);
    expect(buttonNamed(page.root, 'Confirm stop')).toBeDefined();
    await runAsync(async () => {
      buttonNamed(page.root, 'Confirm stop').props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual(['interrupt:shared', 'stop:shared:stopped from the PWA session workspace']);

    // The bar's own Rename is gone: renaming is a form in Actions now (see the Actions suite).
    expect(page.root.findAllByType('button').some(node => node.children.join('').startsWith('Rename'))).toBe(false);

    // Move to another login opens the migration sheet; its route is mounted.
    chooseAction(page.root, 'move-login');
    expect(page.root.findByType(MigrateSheet).props.open).toBe(true);
    run(() => page.root.findByType(MigrateSheet).props.onClose());
    expect(page.root.findByType(MigrateSheet).props.open).toBe(false);
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
        onSessionChange={() => undefined}
        presentation="pane"
        session={finished}
      />,
    );

    await runAsync(async () => {
      expect(barAction(page.root, 'Resume session').children.join('')).toBe('Start');
      barAction(page.root, 'Resume session').props.onClick();
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
            onSessionChange={() => undefined}
            presentation="pane"
            session={sessionView('shared')}
          />,
        ),
      ),
    );
    await runAsync(async () => {
      barAction(page.root, 'Interrupt turn').props.onClick();
      await Promise.resolve();
    });
    expect(JSON.stringify(page.toJSON())).toContain('Session action failed: daemon offline');
    run(() => page.unmount());
  });

  test('renders each supported pane surface and current-session task search', async () => {
    // THE SUMMARY AND THE PROSE ARE SEPARATE RECORDS ON PURPOSE.
    //
    // `ScopedTaskSummarySchema` is non-strict, so a fixture that hung
    // `description`/`ask`/`clarifications` on the summary would have them
    // silently stripped and would keep passing while proving nothing about
    // prose. Keeping the prose here, and answering `?q=` with the protocol's own
    // matcher over it, is what makes this page prove the daemon-side search
    // rather than an unfiltered stub that returns the row whatever is typed.
    const searchSummary = { ...taskSummary({ id: 'F6', title: 'Needle task' }), sessionId: 'shared' };
    const searchProse = {
      id: 'F6',
      title: 'Needle task',
      description: 'A task used to prove the current-session search action.',
      ask: { text: 'Find the needle' },
      clarifications: [],
    };
    const seen: Array<{ method: string; pathname: string; search: URLSearchParams }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? 'GET', pathname: url.pathname, search: url.searchParams });
      // `/fs/index` FIRST: it does not end with `/fs`, so the listing branch
      // would otherwise answer it with a directory and paint the search
      // unavailable — taking the file row, and this test's whole point, with it.
      if (url.pathname.endsWith('/fs/index'))
        return Response.json({
          v: 1,
          sessionId: 'shared',
          root: '/work/shared',
          files: [{ name: 'needle.ts', path: 'needle.ts' }],
          coverage: 'complete',
          skipped: [],
        });
      if (url.pathname.endsWith('/tasks')) {
        const query = url.searchParams.get('q');
        const rows =
          query === null || matchesSessionSearchQuery(sessionSearchTaskHaystack(searchProse), query)
            ? [searchSummary]
            : [];
        return Response.json({
          v: 1,
          sessionId: 'shared',
          tasks: rows,
          parseErrors: 0,
          updatedAt: '2026-08-06T00:00:00.000Z',
        });
      }
      if (url.pathname.endsWith('/fs')) return Response.json({ entries: [{ name: 'needle.ts', type: 'file' }] });
      return Response.json(url.pathname.endsWith('/changes') ? { repo: false, changes: [] } : { entries: [] });
    }) as typeof fetch;
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        readSnapshot={async () => 'paired snapshot'}
        session={sessionView('shared')}
      />,
    );
    try {
      // THE UNIT-TIER REQUEST LEDGER, taken before any pane is opened so every
      // request on it belongs to the page's own mount. Before this row a
      // twelve-task board cost thirteen task reads and a full breadth-first walk
      // of the session tree; both fan-outs are now zero, and zero is the
      // assertion rather than the description.
      await runAsync(async () => {
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      });
      const bare = seen.filter(row => row.method === 'GET' && row.pathname.endsWith('/tasks') && !row.search.has('q'));
      expect(bare).toHaveLength(1);
      expect(seen.filter(row => row.pathname.endsWith('/fs/index'))).toHaveLength(1);
      expect(seen.filter(row => row.method === 'GET' && /\/tasks\/[^/]+$/u.test(row.pathname))).toHaveLength(0);
      expect(seen.filter(row => row.pathname.endsWith('/fs'))).toHaveLength(0);

      const workspace = () => page.root.findByType(SessionWorkspace).props.workspace;
      run(() => workspace().openFilePicker());
      expect(page.root.findAllByType(FilesTab)).toHaveLength(1);
      await runAsync(async () => await Promise.resolve());

      run(() => workspace().showAgentTab('console'));
      expect(page.root.findAllByProps({ 'data-workspace-console': '' })).toHaveLength(1);
      await runAsync(async () => await Promise.resolve());
      expect(JSON.stringify(page.toJSON())).toContain('paired snapshot');

      // A `&task` reference opens this ferret's tasks in their sheet.
      run(() => page.root.findByType(ReferenceSurfaceProvider).props.surface.onTaskOpen?.('F6'));
      expect(page.root.findAllByType(SessionTasksSearchSurface)).toHaveLength(1);
      await runAsync(async () => {
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      });
      expect(page.root.findByType(ReferenceSurfaceProvider).props.surface.taskReferenceResolver?.('F6')).toBe(true);
      const input = page.root.findByProps({ 'data-session-utility': 'tasks' }).findByType('input');
      run(() => input.props.onChange({ target: { value: 'needle' } }));
      // The task half is network-bound now. Reading the popup on the very next
      // line would see the file row alone and count 1 — a failure that looks
      // like a missing result and is really a missing wait.
      //
      // GATED ON THE ANSWER, NOT ON A DURATION. A single sleep of the query debounce plus a margin is
      // enough on an idle machine and measurably is not under full-suite load, where the timer fires
      // late and the fetch still has to resolve behind it. Waiting for the response this test is
      // about removes the race instead of widening it — and the shared wait FAILS when its budget
      // runs out, so an answer that never arrives is reported as the expired wait it is rather than
      // as one popup row too few.
      const popupRows = () =>
        page.root.find(node => String(node.props.className).includes('z-[80]')).findAllByType('button');
      const answered = () => seen.some(row => row.pathname.endsWith('/tasks') && row.search.get('q') === 'needle');
      await settleUntil(
        () => answered() && popupRows().length === 2,
        'the narrowed task search to answer and both rows to render',
        runAsync,
      );

      const results = popupRows();
      expect(results).toHaveLength(2);
      // Exactly one narrowing request, and the daemon decided what it returned.
      expect(seen.filter(row => row.pathname.endsWith('/tasks') && row.search.get('q') === 'needle')).toHaveLength(1);
      // By KIND, not by position: results are ranked, so a file and a task can
      // trade places as the scoring changes.
      run(() => results.find(row => row.props['data-result-kind'] === 'file')?.props.onClick());

      // ONE TAB PER FILE (#35): a file tab renders ITS file, not the picker.
      await runAsync(async () => await Promise.resolve());
      expect(page.root.findAllByType(FileInstanceSurface)).toHaveLength(1);
      expect(page.root.findAllByType(FileInstanceSurface)[0]?.props.instance.key).toBe('needle.ts');
      expect(page.root.findAllByType(FilesTab)).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });

  test('Info opens the real session-scoped tasks and analytics sheets', async () => {
    const scope = daemonSessionScope(alpha, 'shared');
    const current = sessionView('shared');
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], current)}
        connection={alpha}
        context={contextDependencies()}
        entries={[]}
        initialInfo="usage"
        onSessionChange={() => undefined}
        presentation="pane"
        session={current}
      />,
      fakeDaemon().factory,
    );
    try {
      await flush();
      run(() => page.root.findByType(SessionInfo).props.onOpenAnalytics());
      const analytics = page.root.findByType(SessionAnalyticsSurface);
      expect(analytics.props.connection).toBe(alpha);
      expect(analytics.props.scope).toEqual(scope);
      const sheet = () => page.root.findAll(node => node.type === BottomSheet && node.props.closeLabel === 'Close')[0];
      expect(sheet()?.props.ariaLabel).toBe('Analytics for this session');
      run(() => page.root.findByType(SessionInfo).props.onOpenTasks());
      expect(page.root.findAllByType(SessionAnalyticsSurface)).toHaveLength(0);
      expect(page.root.findAllByType(SessionTasksSearchSurface)).toHaveLength(1);
      expect(sheet()?.props.ariaLabel).toBe('Tasks');
      run(() => sheet()?.props.onClose());
      expect(sheet()?.props.open).toBe(false);
      expect(sheet()?.props.ariaLabel).toBe('Session tool');
    } finally {
      run(() => page.unmount());
    }
  });

  test('a /skill reference opens Info › Context › Skills, and the composer’s catalog is read ONCE and proves it', async () => {
    const scope = daemonSessionScope(alpha, 'shared');
    const asked: string[] = [];
    const requested: string[] = [];
    const sharedClient: SessionChatClient = {
      ...client([], sessionView('shared')),
      request: async (path, schema) => {
        requested.push(path);
        return schema.parse({
          v: 1,
          sessionId: 'shared',
          items: [],
          resolved: [],
          count: 0,
          parseErrors: 0,
          updatedAt: '2026-08-06T00:00:00.000Z',
        });
      },
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/skills')) {
        asked.push(url);
        return Response.json({
          harness: 'claude',
          skills: [{ name: 'floop', description: 'Review until satisfied.', scope: 'global', origin: 'both' }],
        });
      }
      return route(input);
    }) as typeof fetch;
    const page = renderSessionChatPage(
      <SessionChatPage
        client={sharedClient}
        connection={alpha}
        context={contextDependencies()}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    try {
      await runAsync(async () => {
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
      });

      // Info starts shut: looking is something a person asks for.
      expect(page.root.findAllByType(SessionInfo)).toHaveLength(0);
      // A `/skill` reference opens Info on Context › Skills, listing every skill this ferret sees.
      run(() => page.root.findByType(ReferenceSurfaceProvider).props.surface.onSkillOpen?.('floop'));
      await runAsync(async () => {
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
      });
      expect(page.root.findByType(SessionTopBar).props.infoOpen).toBe(true);
      expect(page.root.findByType(SessionInfo).props.placement.tab).toBe('folder');
      const rail = () => page.root.findByType(ContextRailBody);
      expect(rail().props.tab).toBe('skills');
      expect(rail().props.agentName).toBe(sessionDisplayName(sessionView('shared')));
      expect(JSON.stringify(page.toJSON())).toContain('floop');
      expect(scope.sessionId).toBe('shared');
      // Insert puts the invocation into this agent's composer draft; a Docs row opens a Files tab.
      run(() => rail().props.onInsertSkill('/floop'));
      run(() => rail().props.onOpenFile('CLAUDE.md'));
      expect(page.root.findByType(FileInstanceSurface).props.instance.key).toBe('CLAUDE.md');
      // ONE catalog read: the composer and the transcript share the page's. (Context › Skills reads the
      // skills inventory instead, which says where each skill comes from.)
      expect(asked).toEqual(['https://alpha.example.test/v1/sessions/shared/skills']);
      // The composer bundle owns only Attention here. Tasks and skills come
      // from the workspace owners above, so a fully capable client still does
      // not issue duplicate reads for either family.
      expect(requested.filter(path => path !== '/v1/sessions/shared/attention')).toEqual([]);
      // …and the names it returned are what the transcript proves against, so a
      // `/floop` this pane just inserted is a live reference rather than prose.
      const provider = page.root.findByType(ReferenceSurfaceProvider);
      expect(provider.props.surface.skillReferenceResolver?.('floop')).toBe(true);
      expect(provider.props.surface.skillReferenceResolver?.('absent')).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test('lays the page out as the split workspace on a desktop and one tab at a time on a phone', () => {
    const desktop = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
      />,
    );
    try {
      expect(desktop.root.findByType(SessionWorkspace).props.formFactor).toBe('desktop');
      expect(desktop.root.findAllByType(WorkspaceView)).toHaveLength(1);
      // The chat is the agent pane's first tab, rendered as it always was.
      expect(desktop.root.findByType(WorkspaceView).findAllByType(Transcript)).toHaveLength(1);
      // No context dependencies: no Info, and no ⓘ that could only open an empty panel.
      expect(desktop.root.findByType(SessionWorkspace).props.info).toBeUndefined();
      expect(desktop.root.findByType(SessionTopBar).props.onToggleInfo).toBeUndefined();
    } finally {
      run(() => desktop.unmount());
    }
    const phone = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="sheet"
        session={sessionView('shared')}
      />,
    );
    try {
      expect(phone.root.findByType(SessionWorkspace).props.formFactor).toBe('phone');
      expect(phone.root.findAllByType(WorkspaceView)).toHaveLength(0);
      expect(phone.root.findAllByProps({ 'data-phone-workspace': '' })).toHaveLength(1);
    } finally {
      run(() => phone.unmount());
    }
  });

  test('opens a proved file, terminal and task reference in the workspace, not the old side pane', async () => {
    const layouts = new WorkspaceLayoutStore(NO_STORAGE);
    const scope = daemonSessionScope(alpha, 'shared');
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
        workspaceLayouts={layouts}
      />,
    );
    try {
      const surface = () => page.root.findByType(ReferenceSurfaceProvider).props.surface;
      run(() => surface().onCodeReferenceOpen?.({ path: 'src/app.ts', line: 4 }));
      expect(layouts.snapshot(scope).tabs['file:src/app.ts']?.label).toBe('app.ts');
      const file = page.root.findByType(FileInstanceSurface);
      expect(file.props.instance).toMatchObject({ key: 'src/app.ts', selection: { line: 4 }, revision: 1 });

      run(() =>
        surface().onSurfaceOpen?.({
          kind: 'surface',
          surface: 'terminal',
          key: 'a1b2c3d4e5f6',
          daemonId: alpha.daemonId,
          sessionId: 'shared',
        }),
      );
      expect(layouts.snapshot(scope).tabs['terminal:a1b2c3d4e5f6']).toBeDefined();
      // No deck on this page: the terminal tab says so rather than showing a dead shell.
      expect(JSON.stringify(page.toJSON())).toContain('Terminals are not available on this page.');

      run(() => surface().onTaskOpen?.('F1'));
      expect(page.root.findAllByType(SessionTasksSearchSurface)).toHaveLength(1);
      await runAsync(async () => await Promise.resolve());
    } finally {
      run(() => page.unmount());
    }
  });

  test('proves and opens %terminal: and %browser: chips by name, and moves the marker on the live feed', async () => {
    // Arrange — a daemon client answering the browser status and both control views, and a deck whose
    // `dev` shell is named.
    const layouts = new WorkspaceLayoutStore(NO_STORAGE);
    const scope = daemonSessionScope(alpha, 'shared');
    const pages = [
      { id: 'PAGE1', name: 'app', url: 'http://localhost:5173/login', title: 'Sign in' },
      { id: 'PAGE3', url: 'https://example.test/pr', title: 'The PR' },
    ];
    const answers: Record<string, unknown> = {
      '/v1/sessions/shared/browser': {
        sessionId: 'shared',
        state: 'running',
        pages,
        activePageId: 'PAGE1',
        url: pages[0]?.url,
        title: 'Sign in',
        pageState: 'ready',
        canGoBack: false,
        canGoForward: false,
        viewport: { width: 1280, height: 800 },
        viewers: 0,
        persistentProfile: true,
        idleTimeoutSeconds: 900,
        capacity: { running: 2, maximum: 60 },
      },
      '/v1/sessions/shared/surfaces/terminals/control': {
        sessionId: 'shared',
        driving: [],
        takeovers: [],
        handed: [],
        opened: [],
        asked: [],
      },
      '/v1/sessions/shared/surfaces/browser/control': {
        sessionId: 'shared',
        driving: [],
        takeovers: [],
        handed: [],
        opened: [],
        asked: [],
      },
    };
    const daemonClient = async () =>
      ({
        request: async (path: string, schema: { parse: (value: unknown) => unknown }) => schema.parse(answers[path]),
      }) as unknown as FyApiClient;
    const deck = fakeDeck(async () => terminalListing([terminalView('a1b2c3d4e5f6', { name: 'dev' })]));
    const hub = createSurfaceEventHub();
    const page = render(
      <DaemonClientProvider client={daemonClient}>
        {withSessionSearch(
          <SessionChatPage
            client={client([], sessionView('shared'))}
            connection={alpha}
            deck={deck.dependencies}
            entries={[]}
            formFactor="desktop"
            onSessionChange={() => undefined}
            presentation="pane"
            session={sessionView('shared')}
            surfaceEvents={hub}
            workspaceLayouts={layouts}
            workspaceRails={new WorkspaceRailPreferenceStore(NO_STORAGE)}
          />,
        )}
      </DaemonClientProvider>,
    );
    try {
      const surface = () => page.root.findByType(ReferenceSurfaceProvider).props.surface;
      const resolve = (kind: 'terminal' | 'browser', key: string) =>
        surface().surfaceReferenceResolver?.({ kind: 'surface', surface: kind, key });
      await settleUntil(
        () => resolve('browser', 'app')?.state === 'open' && resolve('terminal', 'dev')?.state === 'open',
        'the page list and the terminal listing to prove their chips',
        runAsync,
      );
      expect(resolve('browser', 'gone')).toEqual({ state: 'closed' });
      const open = (kind: 'terminal' | 'browser', key: string) =>
        run(() =>
          surface().onSurfaceOpen?.({
            kind: 'surface',
            surface: kind,
            key,
            daemonId: alpha.daemonId,
            sessionId: 'shared',
          }),
        );

      // Act + Assert — a named shell opens its tab by id, labelled with its name.
      open('terminal', 'dev');
      expect(layouts.snapshot(scope).tabs['terminal:a1b2c3d4e5f6']?.label).toBe('dev');
      open('terminal', 'a1b2c3d4e5f6');
      expect(layouts.snapshot(scope).focused).toBeDefined();
      // A named page opens by name; an unnamed one by id, labelled by its title; an unknown key as itself.
      open('browser', 'app');
      expect(layouts.snapshot(scope).tabs['browser:app']?.label).toBe('app');
      open('browser', 'PAGE3');
      expect(layouts.snapshot(scope).tabs['browser:PAGE3']?.label).toBe('The PR');
      open('browser', 'gone');
      expect(layouts.snapshot(scope).tabs['browser:gone']).toBeDefined();

      // The live feed reaches the driving seam: a takeover shows at once.
      run(() =>
        hub.publish({
          sequence: 4,
          time: '2026-10-16T10:00:00.000Z',
          sessionId: 'shared',
          type: 'surface.takeover',
          source: 'daemon',
          data: {
            surface: 'browser',
            id: 'PAGE1',
            name: 'app',
            by: { by: 'local' },
            since: '2026-10-16T10:00:00.000Z',
          },
        }),
      );
      expect(page.root.findByType(SessionWorkspace).props.driving.takenOver('browser:app')).toBe(true);
      await runAsync(async () => await Promise.resolve());
    } finally {
      run(() => page.unmount());
    }
  });

  test('mounts the daemon-bound structured form, but keeps damaged question state unavailable', async () => {
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
    const published: SessionView[] = [];
    let refreshed = 0;
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client(calls, pending)}
        connection={alpha}
        entries={[]}
        onRefresh={() => {
          refreshed += 1;
        }}
        onSessionChange={view => published.push(view)}
        presentation="pane"
        session={pending}
      />,
    );
    try {
      // This is the real form, not a facade: the client contract includes the
      // mounted answer route and the daemon binds the exact tool-use id again.
      expect(page.root.findAllByType(QuestionForm)).toHaveLength(1);
      expect(page.root.findAllByProps({ className: 'fy-composer' })).toHaveLength(0);
      expect(page.root.findAllByProps({ 'data-question-unavailable': '' })).toHaveLength(0);
      const form = page.root.findByType(QuestionForm);
      await form.props.api.answer(
        alpha,
        'shared',
        'ask-1',
        ['Yes'],
        undefined,
        undefined,
        [{ kind: 'selection', labels: ['Yes'] }],
        'answer-1',
      );
      expect(calls).toEqual(['answer:ask-1']);
      expect(published).toEqual([pending]);
      expect(refreshed).toBe(1);
      await expect(
        form.props.api.answer(
          daemonConnection({ daemonId: 'other', baseUrl: 'https://other.example.test', deviceId: 'other-token' }),
          'shared',
          'ask-1',
          ['Yes'],
        ),
      ).rejects.toThrow('different daemon pairing');

      // Interrupt is the one action that CAN clear the turn, so it stays live.
      await runAsync(async () => {
        barAction(page.root, 'Interrupt turn').props.onClick();
        await Promise.resolve();
      });
      expect(calls).toEqual(['answer:ask-1', 'interrupt:shared']);

      // A status with no validated payload is damaged evidence, not a reason to
      // invent a form or send an unbound answer.
      run(() =>
        page.update(
          withSessionSearch(
            <SessionChatPage
              client={client([], pending)}
              connection={alpha}
              entries={[]}
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

  test('answers a permission prompt above the Composer through the daemon, and sends a deny note as a message', async () => {
    const permissionRequest: PermissionRequest = {
      id: '0123456789abcdef',
      harness: 'claude',
      tool: 'Read',
      action: 'read',
      what: '/etc/hostname',
      question: 'Do you want to proceed?',
      options: [
        { number: 1, label: 'Yes', kind: 'allow' },
        { number: 2, label: 'No', kind: 'deny' },
      ],
      selected: 1,
    };
    const parked = sessionView('shared', {
      config: { teammate: 'hadi' },
      state: { status: 'running', turnState: 'needs-input', permissionRequest },
    });
    const posted: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/permission')) {
        posted.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return Response.json({ requestId: permissionRequest.id, cleared: true });
      }
      return route(input);
    }) as typeof fetch;
    const sends: unknown[][] = [];
    const chat = {
      ...(client([], parked) as unknown as Record<string, unknown>),
      send: async (...args: unknown[]) => {
        sends.push(args);
        return { accepted: true };
      },
    } as unknown as SessionChatClient;
    let refreshed = 0;
    const mountFor = (session: SessionView, canControl = true) => (
      <SessionChatPage
        canControl={canControl}
        client={chat}
        connection={alpha}
        entries={[]}
        onRefresh={() => {
          refreshed += 1;
        }}
        onSessionChange={() => undefined}
        presentation="pane"
        session={session}
      />
    );
    const page = renderSessionChatPage(mountFor(parked));
    try {
      const card = page.root.findByType(ApprovalCard);
      expect(card.props.agentName).toBe('Hadi');
      expect(card.props.request).toEqual(permissionRequest);
      // Above the Composer, inside the same input column.
      const column = page.root.findByProps({ className: 'fy-chat-input__column' });
      const kinds = column.children.map(child => (typeof child === 'string' ? child : child.type));
      expect(kinds.indexOf(ApprovalCard)).toBeLessThan(kinds.indexOf(Composer));

      const scope = daemonSessionScope(alpha, 'shared');
      expect(await card.props.api.answer(alpha, scope, { kind: 'deny', requestId: permissionRequest.id })).toEqual({
        requestId: permissionRequest.id,
        cleared: true,
      });
      expect(posted).toEqual([
        {
          url: 'https://alpha.example.test/v1/sessions/shared/permission',
          body: { kind: 'deny', requestId: permissionRequest.id },
        },
      ]);
      await card.props.api.note(alpha, scope, 'read the cached copy');
      expect(sends).toEqual([['shared', { message: 'read the cached copy', now: false }]]);
      await expect(
        card.props.api.note(
          daemonConnection({ daemonId: 'other', baseUrl: 'https://other.example.test', deviceId: 'other-token' }),
          scope,
          'x',
        ),
      ).rejects.toThrow('different daemon pairing');
      card.props.onSettled();
      expect(refreshed).toBe(1);

      // Nothing to answer from a device that cannot control the session, or once it is over.
      run(() => page.update(withSessionSearch(mountFor(parked, false))));
      expect(page.root.findAllByType(ApprovalCard)).toHaveLength(0);
      run(() =>
        page.update(
          withSessionSearch(
            mountFor(
              sessionView('shared', { state: { status: 'completed', turnState: 'needs-input', permissionRequest } }),
            ),
          ),
        ),
      );
      expect(page.root.findAllByType(ApprovalCard)).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });

  test('answers a harness dialog above the Composer through the daemon, and never beside a permission prompt', async () => {
    const harnessDialog: HarnessDialog = {
      id: '0123456789abcdef',
      harness: 'codex',
      kind: 'hooks-review',
      title: 'Hooks need review',
      options: [
        { number: 1, label: 'Review hooks', grantsTrust: false },
        { number: 2, label: 'Trust all and continue', grantsTrust: true },
      ],
      selected: 1,
      escape: 'skip',
    };
    const parked = sessionView('shared', {
      config: { teammate: 'hadi' },
      state: { status: 'running', turnState: 'needs-input', harnessDialog },
    });
    const posted: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/dialog')) {
        posted.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return Response.json({ dialogId: harnessDialog.id, cleared: true });
      }
      return route(input);
    }) as typeof fetch;
    let refreshed = 0;
    const mountFor = (session: SessionView, canControl = true) => (
      <SessionChatPage
        canControl={canControl}
        client={client([], parked)}
        connection={alpha}
        entries={[]}
        onRefresh={() => {
          refreshed += 1;
        }}
        onSessionChange={() => undefined}
        presentation="pane"
        session={session}
      />
    );
    const page = renderSessionChatPage(mountFor(parked));
    try {
      const card = page.root.findByType(DialogCard);
      expect(card.props.agentName).toBe('Hadi');
      expect(card.props.dialog).toEqual(harnessDialog);
      const column = page.root.findByProps({ className: 'fy-chat-input__column' });
      const kinds = column.children.map(child => (typeof child === 'string' ? child : child.type));
      expect(kinds.indexOf(DialogCard)).toBeLessThan(kinds.indexOf(Composer));

      const scope = daemonSessionScope(alpha, 'shared');
      expect(await card.props.api.answer(alpha, scope, { kind: 'escape', dialogId: harnessDialog.id })).toEqual({
        dialogId: harnessDialog.id,
        cleared: true,
      });
      expect(posted).toEqual([
        {
          url: 'https://alpha.example.test/v1/sessions/shared/dialog',
          body: { kind: 'escape', dialogId: harnessDialog.id },
        },
      ]);
      card.props.onSettled();
      expect(refreshed).toBe(1);

      // Nothing to answer from a device that cannot control the session, or once it is over.
      run(() => page.update(withSessionSearch(mountFor(parked, false))));
      expect(page.root.findAllByType(DialogCard)).toHaveLength(0);
      run(() =>
        page.update(
          withSessionSearch(
            mountFor(
              sessionView('shared', { state: { status: 'completed', turnState: 'needs-input', harnessDialog } }),
            ),
          ),
        ),
      );
      expect(page.root.findAllByType(DialogCard)).toHaveLength(0);

      // A permission prompt owns the pane: the dialog card steps aside.
      const permissionRequest: PermissionRequest = {
        id: 'fedcba9876543210',
        harness: 'codex',
        tool: 'Shell',
        action: 'run',
        what: 'ls',
        question: 'Run?',
        options: [
          { number: 1, label: 'Yes', kind: 'allow' },
          { number: 2, label: 'No', kind: 'deny' },
        ],
        selected: 1,
      };
      run(() =>
        page.update(
          withSessionSearch(
            mountFor(
              sessionView('shared', {
                state: { status: 'running', turnState: 'needs-input', harnessDialog, permissionRequest },
              }),
            ),
          ),
        ),
      );
      expect(page.root.findAllByType(DialogCard)).toHaveLength(0);
      expect(page.root.findAllByType(ApprovalCard)).toHaveLength(1);
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
        .filter(node => textOf(node).includes('daemon did not answer'));
      expect(statuses).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });

  test('says nothing about an outage while the machine is reconnecting', () => {
    const outage =
      'Session workspace issue: Transcript: could not reach fyd (No configured connection worked: direct was not reachable (1006); hosted relay was not reachable (1006))';
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        connectionState={{
          kind: 'reconnecting',
          since: 0,
          attempt: 2,
          nextAttemptAt: null,
          failures: [{ label: 'Direct', detail: 'direct was not reachable (1006)' }],
          cause: 'unknown',
          stalled: false,
        }}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        refreshError={outage}
        session={sessionView('shared')}
      />,
    );
    try {
      expect(JSON.stringify(page.toJSON())).not.toContain('could not reach fyd');
      expect(page.root.findAllByProps({ 'data-session-issue': '' })).toHaveLength(0);
      expect(page.root.findByType(Composer).props.connectionLive).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test('shows an unprovable transcript as its own notice, with Check again and a confirmed Restart', async () => {
    let refreshed = 0;
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        connectionState={{ kind: 'connected' }}
        entries={[]}
        onRefresh={() => {
          refreshed += 1;
        }}
        onSessionChange={() => undefined}
        presentation="pane"
        refreshError="Session workspace issue: Transcript: session shared has no transcript this daemon can prove is its own"
        session={sessionView('shared')}
        transcriptUnbound
      />,
    );
    try {
      const notice = page.root.findByProps({ 'data-transcript-unbound': '' });
      expect(textOf(notice)).toContain('Console tab');
      expect(textOf(notice)).toContain('Restart CLI…');
      expect(page.root.findAllByProps({ 'data-session-issue': '' })).toHaveLength(0);
      await runAsync(async () => {
        notice.find(node => node.type === 'button' && textOf(node) === 'Check again').props.onClick();
      });
      expect(refreshed).toBe(1);
    } finally {
      run(() => page.unmount());
    }
  });

  test('keeps a refresh error that is not an outage to one line, with the whole sentence one tap away', () => {
    const page = renderSessionChatPage(
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        connectionState={{ kind: 'connected' }}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        refreshError="Workspace refresh issue: the daemon did not answer."
        session={sessionView('shared')}
      />,
    );
    try {
      const issue = page.root.findByProps({ 'data-session-issue': '' });
      expect(issue.type).toBe('details');
      expect(textOf(issue)).toBe('Workspace refresh issue: the daemon did not answer.');
      expect(issue.findByType('summary').props.className).toContain('truncate');
      expect(page.root.findByType(Composer).props.connectionLive).toBe(true);
    } finally {
      run(() => page.unmount());
    }
  });

  /**
   * ROW 17's SURFACE, IN THE SHIPPED WORKSPACE — not in a fixture.
   *
   * The Agenda board had no host at all before this: `DaemonAgendaClient`,
   * the hooks and the board were constructed only by tests. These cases assert
   * the production journey, because "the component renders in isolation" is
   * exactly the evidence that was mistaken for a shipped feature before.
   */
  describe('Attention', () => {
    const agendaItem = {
      id: 'A3',
      source: 'agent-raised',
      sourceRef: null,
      sourceSeq: 1,
      subject: 'Approve the pairing request',
      why: 'The device needs a signed pairing record.',
      waitingSince: '2026-07-31T11:30:00.000Z',
      howToResolve: 'Approve to let this browser reach the daemon.',
      ask: { kind: 'permission' },
      raisedBy: 'agent',
      raisedBySession: 'shared',
      raisedByName: 'zoe',
    };
    const resolvedItem = {
      ...agendaItem,
      id: 'A2',
      subject: 'Pick the release branch',
      resolvedAt: '2026-07-31T11:20:00.000Z',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: null,
      disposition: 'resolved',
      response: { kind: 'permission', decision: 'approve' },
    };
    const agendaModel = (items: readonly unknown[] = [agendaItem], resolved: readonly unknown[] = []) =>
      ({
        client: {
          respond: async () => undefined,
          resolve: async () => undefined,
          dismiss: async () => undefined,
          needsInfo: async () => undefined,
          discuss: async () => undefined,
          progress: async () => undefined,
        },
        snapshot: {
          v: 1,
          sessionId: 'shared',
          items,
          resolved,
          count: items.length,
          parseErrors: 0,
          updatedAt: '2026-07-31T12:00:00.000Z',
        },
        status: 'ready',
      }) as unknown as SessionAgendaModel;

    /** A session whose ferret works in agenda mode: only then does its chat draw an agenda. */
    const agendaSession = (id = 'shared') => sessionView(id, { state: { attention: { agendaMode: true } as never } });

    const chatPage = (props: Partial<ComponentProps<typeof SessionChatPage>> = {}) => (
      <SessionChatPage
        client={client([], sessionView('shared'))}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={sessionView('shared')}
        {...props}
      />
    );
    const agendaPage = (props: Partial<ComponentProps<typeof SessionChatPage>> = {}) =>
      chatPage({ session: agendaSession(), attention: agendaModel(), ...props });
    const update = (page: ReturnType<typeof renderSessionChatPage>, element: ReactElement) =>
      run(() => page.update(withSessionSearch(element as ReactElement<ComponentProps<typeof SessionChatPage>>)));

    const lines = (root: ReactTestInstance) =>
      root.findAll(node => node.type === 'div' && node.props['data-agenda-line'] !== undefined);
    const drawers = (root: ReactTestInstance) =>
      root.findAll(node => node.type === 'section' && node.props['data-agenda-drawer'] !== undefined);
    const cards = (root: ReactTestInstance) =>
      root.findAll(node => node.type === 'section' && node.props['data-agenda-view'] !== undefined);
    const column = (root: ReactTestInstance) =>
      root.find(node => node.type === 'div' && node.props.className === 'fy-chat-input__column');
    const log = (root: ReactTestInstance) =>
      root.find(node => node.type === 'div' && node.props.className === 'fy-chat-log');
    const surface = (root: ReactTestInstance) =>
      root.find(node => node.type === 'div' && node.props['data-chat-width'] !== undefined);
    const chatInput = (root: ReactTestInstance) =>
      root.find(node => node.type === 'div' && node.props.className === 'fy-chat-input');
    const names = (parent: ReactTestInstance): readonly string[] =>
      parent.children.flatMap(child => (typeof child === 'string' ? [] : [String(child.type)]));
    const press = (root: ReactTestInstance) =>
      run(() =>
        root
          .find(node => node.type === 'button' && node.props['data-agenda-line-toggle'] !== undefined)
          .props.onClick(),
      );

    test('draws the agenda as one line above the composer — no sheet, strip or dialog — when the ferret works in agenda mode', () => {
      const page = renderSessionChatPage(agendaPage());
      try {
        expect(needsYouButtons(page.root)).toHaveLength(0);
        expect(lines(page.root)).toHaveLength(1);
        expect(page.root.findByType(AgendaLine).props.counts).toEqual({
          blocking: 0,
          needYou: 1,
          withFerret: 0,
        });
        expect(page.root.findAll(node => node.props?.role === 'dialog')).toHaveLength(0);
        // The line sits in the input column, ahead of the composer; nothing else is under it.
        const col = column(page.root);
        expect(col.findAllByType(AgendaLine)).toHaveLength(1);
        expect(col.findAllByType(Composer)).toHaveLength(1);
        expect(drawers(page.root)).toHaveLength(0);
        expect(cards(page.root)).toHaveLength(0);
      } finally {
        run(() => page.unmount());
      }
    });

    test('reads agenda mode from the `agenda` summary, which wins over `attention`', () => {
      const only = sessionView('shared', { state: { agenda: { agendaMode: true } as never } });
      const page = renderSessionChatPage(chatPage({ session: only, attention: agendaModel() }));
      const stale = sessionView('shared', {
        state: { agenda: { agendaMode: false } as never, attention: { agendaMode: true } as never },
      });
      const off = renderSessionChatPage(chatPage({ session: stale, attention: agendaModel() }));
      try {
        expect(lines(page.root)).toHaveLength(1);
        expect(lines(off.root)).toHaveLength(0);
      } finally {
        run(() => page.unmount());
        run(() => off.unmount());
      }
    });

    test('draws no agenda for a ferret that is not in agenda mode, whatever its board holds', () => {
      const page = renderSessionChatPage(chatPage({ attention: agendaModel() }));
      try {
        expect(lines(page.root)).toHaveLength(0);
        expect(drawers(page.root)).toHaveLength(0);
        expect(cards(page.root)).toHaveLength(0);
        // The ledger still proves a `!A3`, so a link in older chat stays a link.
        const surface = page.root.findByType(ReferenceSurfaceProvider).props.surface;
        expect(surface.agendaReferenceResolver('A3')).toBe(true);
      } finally {
        run(() => page.unmount());
      }
    });

    test('keeps plain notifications out of the agenda', () => {
      const page = renderSessionChatPage(agendaPage({ attention: agendaModel([{ ...agendaItem, notice: true }]) }));
      try {
        expect(lines(page.root)).toHaveLength(0);
      } finally {
        run(() => page.unmount());
      }
    });

    test('keeps the resolved history in the header menu as "N resolved", and shows no row when there is none', () => {
      const withHistory = renderSessionChatPage(agendaPage({ attention: agendaModel([], [resolvedItem]) }));
      try {
        expect(actionLabels(withHistory.root)).toContain('1 resolved');
        expect(lines(withHistory.root)).toHaveLength(0);
        expect(withHistory.root.findAll(node => node.props?.['data-agenda-record'] !== undefined)).toHaveLength(0);
      } finally {
        run(() => withHistory.unmount());
      }
      const without = renderSessionChatPage(agendaPage({ attention: agendaModel([], []) }));
      try {
        expect(actionLabels(without.root).some(label => label.endsWith('resolved'))).toBe(false);
      } finally {
        run(() => without.unmount());
      }
    });

    test('renders no agenda surface at all for a host that has not subscribed', () => {
      const page = renderSessionChatPage(chatPage({ session: agendaSession() }));
      try {
        // Absence, not an empty badge: a "0" here would be a claim this build
        // cannot make, because nothing has read the ledger.
        expect(needsYouButtons(page.root)).toHaveLength(0);
        expect(actionLabels(page.root)).not.toContain('Attention');
        expect(lines(page.root)).toHaveLength(0);
        const surface = page.root.findByType(ReferenceSurfaceProvider).props.surface;
        expect(surface.agendaReferenceResolver).toBeUndefined();
        expect(surface.onAgendaOpen).toBeUndefined();
      } finally {
        run(() => page.unmount());
      }
    });

    test('proves every id on this session’s ledger and opens an open one as its card, a resolved one in the list', () => {
      const page = renderSessionChatPage(agendaPage({ attention: agendaModel([agendaItem], [resolvedItem]) }));
      try {
        const surface = page.root.findByType(ReferenceSurfaceProvider).props.surface;
        expect(surface.agendaReferenceResolver('A3')).toBe(true);
        // Answered, but still on the record — older chat keeps its link.
        expect(surface.agendaReferenceResolver('A2')).toBe(true);
        // On no ledger here: Markdown leaves it as prose.
        expect(surface.agendaReferenceResolver('A9')).toBe(false);

        run(() => surface.onAgendaOpen('A3', null));
        expect(cards(page.root)).toHaveLength(1);
        expect(page.root.findByType(AgendaItemView).props.item.id).toBe('A3');

        run(() => page.root.findByType(AgendaItemView).props.onClose());
        expect(cards(page.root)).toHaveLength(0);

        run(() => page.root.findByType(ReferenceSurfaceProvider).props.surface.onAgendaOpen('A2', null));
        expect(actionLabels(page.root)).toContain('1 resolved');
        expect(cards(page.root)).toHaveLength(0);
      } finally {
        run(() => page.unmount());
      }
    });

    test('proves nothing while the board is unread: unread is not empty', () => {
      const unread = { ...agendaModel(), snapshot: null, status: 'loading' } as unknown as SessionAgendaModel;
      const page = renderSessionChatPage(agendaPage({ attention: unread }));
      try {
        const surface = page.root.findByType(ReferenceSurfaceProvider).props.surface;
        expect(surface.agendaReferenceResolver).toBeUndefined();
        expect(surface.onAgendaOpen).toBeUndefined();
        expect(lines(page.root)).toHaveLength(0);
      } finally {
        run(() => page.unmount());
      }
    });

    test('lands in the chat AT the item a link names, and re-targets when the link changes', () => {
      const board = agendaModel([agendaItem, { ...agendaItem, id: 'A5' }], [resolvedItem]);
      const page = renderSessionChatPage(agendaPage({ attention: board, agendaTarget: 'A3' }));
      try {
        expect(page.root.findByType(AgendaItemView).props.item.id).toBe('A3');
        // The only dialog is the item view itself, laid over the chat column rather than over the page.
        expect(
          page.root.findAll(node => node.props?.role === 'dialog').map(node => node.props['data-agenda-view']),
        ).toEqual(['A3']);

        update(page, agendaPage({ attention: board, agendaTarget: 'A5' }));
        expect(page.root.findByType(AgendaItemView).props.item.id).toBe('A5');
      } finally {
        run(() => page.unmount());
      }
    });

    test('a new navigation to the SAME item re-opens its card after it was closed', () => {
      const props = {
        attention: agendaModel([agendaItem, { ...agendaItem, id: 'A5' }]),
        agendaTarget: 'A3' as const,
      };
      const page = renderSessionChatPage(agendaPage({ ...props, agendaTargetKey: 'entry-1' }));
      try {
        run(() => page.root.findByType(AgendaItemView).props.onClose());
        expect(cards(page.root)).toHaveLength(0);

        update(page, agendaPage({ ...props, agendaTargetKey: 'entry-2' }));
        expect(page.root.findByType(AgendaItemView).props.item.id).toBe('A3');
      } finally {
        run(() => page.unmount());
      }
    });

    test('never carries one session’s open card into another session', () => {
      const page = renderSessionChatPage(agendaPage());
      try {
        run(() => page.root.findByType(ReferenceSurfaceProvider).props.surface.onAgendaOpen('A3', null));
        expect(cards(page.root)).toHaveLength(1);

        update(page, agendaPage({ session: agendaSession('other') }));
        expect(cards(page.root)).toHaveLength(0);
      } finally {
        run(() => page.unmount());
      }
    });

    test('a link into another session opens that session’s card at its item', () => {
      const page = renderSessionChatPage(agendaPage());
      try {
        update(page, agendaPage({ agendaTarget: 'A3', session: agendaSession('other') }));
        // The reset for the new session runs first; the link's target wins.
        expect(page.root.findByType(AgendaItemView).props.item.id).toBe('A3');
      } finally {
        run(() => page.unmount());
      }
    });

    test('opens the drawer upward from the line, and a row title opens the item over the whole chat column', () => {
      const page = renderSessionChatPage(agendaPage());
      try {
        const composerBefore = names(column(page.root)).at(-1);
        press(page.root);
        expect(drawers(page.root)).toHaveLength(1);
        // Siblings of the composer, drawn before it: the drawer and the line never wrap it.
        expect(column(page.root).findAllByType(AgendaDrawer)).toHaveLength(1);
        expect(page.root.findByType(AgendaLine).props.open).toBe(true);

        run(() => page.root.findByType(AgendaRow).props.onOpen());
        expect(drawers(page.root)).toHaveLength(0);
        expect(cards(page.root)).toHaveLength(1);
        // Focus mode: the item is a direct child of the chat surface, over the log AND the composer.
        const last = surface(page.root).children.at(-1);
        expect(typeof last === 'string' ? 0 : last?.findAllByType(AgendaItemView).length).toBe(1);
        expect(surface(page.root).findAllByType(AgendaItemView)).toHaveLength(1);
        expect(log(page.root).findAllByType(AgendaItemView)).toHaveLength(0);
        expect(column(page.root).findAllByType(AgendaItemView)).toHaveLength(0);
        // The chat stays mounted underneath, so its scroll position is kept.
        expect(column(page.root).findAllByType(Composer)).toHaveLength(1);
        expect(names(column(page.root)).at(-1)).toBe(composerBefore);
      } finally {
        run(() => page.unmount());
      }
    });

    test('covers the messages and the composer while an item shows, and gives them back when it closes', () => {
      const page = renderSessionChatPage(agendaPage());
      try {
        expect(surface(page.root).props['data-agenda-focus']).toBeUndefined();
        expect(log(page.root).props.inert).toBeUndefined();
        expect(chatInput(page.root).props.inert).toBeUndefined();
        run(() => page.root.findByType(ReferenceSurfaceProvider).props.surface.onAgendaOpen('A3', null));
        expect(surface(page.root).props['data-agenda-focus']).toBe(true);
        expect(log(page.root).props.inert).toBe(true);
        expect(chatInput(page.root).props.inert).toBe(true);
        run(() => page.root.findByType(AgendaItemView).props.onClose());
        expect(surface(page.root).props['data-agenda-focus']).toBeUndefined();
        expect(log(page.root).props.inert).toBeUndefined();
        expect(chatInput(page.root).props.inert).toBeUndefined();
      } finally {
        run(() => page.unmount());
      }
    });

    test('puts a scrim over the chat only while the drawer is open', () => {
      const page = renderSessionChatPage(agendaPage());
      try {
        const scrims = () => log(page.root).findAll(node => node.props['data-agenda-scrim'] !== undefined);
        expect(scrims()).toHaveLength(0);
        press(page.root);
        expect(scrims()).toHaveLength(1);
        run(() => scrims()[0]?.props.onClick());
        expect(drawers(page.root)).toHaveLength(0);
      } finally {
        run(() => page.unmount());
      }
    });

    test('draws what is running on the agenda line instead of at the foot of the transcript', () => {
      const working = sessionView('shared', {
        state: { attention: { agendaMode: true } as never, turnState: 'working' as never },
      });
      const page = renderSessionChatPage(agendaPage({ session: working }));
      try {
        expect(page.root.findByType(Transcript).props.liveInRow).toBe(true);
        const row = lines(page.root)[0];
        expect(row?.findAll(node => node.props['data-agenda-live'] !== undefined)).toHaveLength(1);
        expect(row?.props['data-shared']).toBe('');
        expect(
          log(page.root).findAll(node => node.type === 'div' && node.props.className === 'fy-live-activity'),
        ).toHaveLength(0);
      } finally {
        run(() => page.unmount());
      }
    });

    test('leaves what is running at the foot of the transcript when there is no agenda line', () => {
      const working = sessionView('shared', { state: { turnState: 'working' as never } });
      const page = renderSessionChatPage(chatPage({ session: working }));
      try {
        expect(page.root.findByType(Transcript).props.liveInRow).toBe(false);
      } finally {
        run(() => page.unmount());
      }
    });

    test('never moves the composer in the chat: it stays the input column’s last child whether the line or the drawer is open', () => {
      const closedBoard = agendaModel([], []);
      const page = renderSessionChatPage(agendaPage({ attention: closedBoard }));
      try {
        const lastChildIsComposer = () => {
          const last = column(page.root).children.at(-1);
          return typeof last !== 'string' && last?.type === Composer;
        };
        expect(lastChildIsComposer()).toBe(true);
        expect(column(page.root).findAllByType(Composer)).toHaveLength(1);

        update(page, agendaPage());
        expect(lines(page.root)).toHaveLength(1);
        expect(lastChildIsComposer()).toBe(true);

        press(page.root);
        expect(drawers(page.root)).toHaveLength(1);
        expect(lastChildIsComposer()).toBe(true);
      } finally {
        run(() => page.unmount());
      }
    });

    test('sends the next message about the items chipped to it, then clears the chips', async () => {
      const sent: string[] = [];
      const spy = {
        ...client([], agendaSession()),
        send: async (_id: string, body: { message: string }) => {
          sent.push(body.message);
        },
      };
      const page = renderSessionChatPage(agendaPage({ client: spy as never }));
      try {
        const send = (text: string) =>
          page.root.findByType(Composer).props.api.send('shared', { message: text, now: false });
        // No chip: the message goes out exactly as typed.
        await send('plain');
        press(page.root);
        run(() => page.root.findByType(AgendaRow).props.onOpen());
        run(() => page.root.findByType(AgendaItemView).props.onReply(''));
        expect(page.root.findByType(AgendaReferenceChips).props.items.map((item: { id: string }) => item.id)).toEqual([
          'A3',
        ]);
        await send('ship it');
        run(() => page.root.findByType(Composer).props.onSent());
        expect(page.root.findAllByType(AgendaReferenceChips).every(chips => chips.props.items.length === 0)).toBe(true);
        await send('later');
        expect(sent).toEqual(['plain', '!A3 ship it', 'later']);
      } finally {
        run(() => page.unmount());
      }
    });

    test('counts a held answer down on the line when the host passes agendaReplies', () => {
      const replies = {
        secondsLeft: 8,
        pending: ['A3'],
        heldForTurn: false,
        heldForComposer: false,
        sending: false,
        sendNow: () => undefined,
      };
      const page = renderSessionChatPage(agendaPage({ agendaReplies: replies }));
      try {
        const slot = page.root.findByType(AgendaLine).props.repliesSlot;
        expect(slot.props.secondsLeft).toBe(8);
        expect(slot.props.onSendNow).toBe(replies.sendNow);
      } finally {
        run(() => page.unmount());
      }
    });

    test('the `!` menu reads the live board, so a newly raised item is offered without a reload', () => {
      const page = renderSessionChatPage(agendaPage());
      try {
        const offered = () =>
          (page.root.findByType(Composer).props.autocompleteAgenda as readonly { id: string }[]).map(item => item.id);
        expect(offered()).toEqual(['A3']);

        update(page, agendaPage({ attention: agendaModel([agendaItem, { ...agendaItem, id: 'A7' }]) }));
        expect(offered()).toEqual(['A3', 'A7']);
      } finally {
        run(() => page.unmount());
      }
    });
  });
});

/**
 * A BRAND-NEW SESSION, IDLE AT ITS PROMPT.
 *
 * The daemon writes `running` the moment a session launches, whether or not anything was asked of it,
 * so `running` alone made the page claim `Running` with a `Working…` spinner over an empty
 * conversation, quota dashes and a blank effort chip. Each case drives the page with a pane frame of
 * the harness sitting at its prompt — or doing real work — exactly as the live read returns it.
 */
describe('SessionChatPage on a brand-new idle session', () => {
  const CLAUDE_IDLE = [
    '╭──────────────────────────────╮',
    '│ > ',
    '╰──────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n');
  const CODEX_IDLE = ['› Ask Codex to do anything', '', '  100% context left · ? for shortcuts'].join('\n');
  const CLAUDE_WORKING = [
    '⏺ Reading the brief.',
    '',
    '✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)',
    '',
    '│ > ',
  ].join('\n');
  const CODEX_WORKING = ['• Working (5s • Esc to interrupt)', '', '› '].join('\n');

  const paneQueries: string[] = [];

  /** Answers the live pane read with `frame` (or a failure), and everything else as the shared fixture does. */
  const paneAnswers = (frame: string | null): string[] => {
    const reads: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), 'https://fixture.example.test');
      if (url.pathname.endsWith('/snapshot') && url.searchParams.get('live') === 'true') {
        reads.push(url.pathname);
        paneQueries.push(url.search);
        return frame === null ? new Response('gone', { status: 503 }) : new Response(frame);
      }
      return route(input);
    }) as typeof fetch;
    return reads;
  };

  const fresh = (harness: 'claude' | 'codex', state: Partial<SessionView['state']> = {}): SessionView =>
    sessionView(`fresh-${harness}`, {
      config: {
        harness,
        agent: harness === 'claude' ? 'claude-auto-gabriela' : 'codex-auto-gabriela',
        model: harness === 'claude' ? 'claude-opus-5[1m]' : 'gpt-5.6-codex',
        launchReasoningEffort: harness === 'claude' ? 'high' : 'medium',
        harnessFlags: [],
      },
      state: { status: 'running', turn: 0, ...state },
    });

  const mountPage = (view: SessionView, usage?: DaemonUsageStore, liveActivity?: LiveActivityFeed) =>
    renderSessionChatPage(
      <SessionChatPage
        client={{ ...client([], view), runtime: async () => view }}
        connection={alpha}
        entries={[]}
        onSessionChange={() => undefined}
        presentation="pane"
        session={view}
        {...(usage === undefined ? {} : { usage })}
        {...(liveActivity === undefined ? {} : { liveActivity })}
      />,
    );

  const liveLines = (root: ReactTestInstance): readonly ReactTestInstance[] =>
    root.findAll(node => node.type === 'div' && node.props.className === 'fy-live-activity');

  const statusWord = (root: ReactTestInstance): string =>
    textOf(root.find(node => node.type === 'span' && node.props.className === 'fy-session-bar__word'));

  for (const [harness, idle] of [
    ['claude', CLAUDE_IDLE],
    ['codex', CODEX_IDLE],
  ] as const) {
    test(`${harness}: reads Ready with no spinner, the launch runtime, and no queue`, async () => {
      // Arrange
      const reads = paneAnswers(idle);
      const view = fresh(harness);

      // Act
      const page = mountPage(view);

      try {
        // Assert — turn zero is ready before the first frame lands, and stays ready once it has.
        expect(page.root.findByType(SessionTopBar).props.turn).toBe('your-turn');
        await settleUntil(() => reads.length > 0, 'the live pane read', runAsync);
        await runAsync(async () => await Promise.resolve());
        expect(page.root.findByType(SessionTopBar).props.turn).toBe('your-turn');
        expect(statusWord(page.root)).toBe('your turn');
        expect(page.root.findByType(Transcript).props.busy).toBe(false);
        expect(liveLines(page.root)).toHaveLength(0);
        expect(page.root.findByType(Composer).props.busy).toBe(false);
        const model = harness === 'claude' ? 'claude-opus-5[1m]' : 'gpt-5.6-codex';
        expect(buttonWithLabelSpan(page.root, model).props['aria-label']).toBe(`Switch model — launched on ${model}`);
        expect(buttonWithLabelSpan(page.root, harness === 'claude' ? 'high' : 'medium')).toBeDefined();
      } finally {
        run(() => page.unmount());
      }
    });
  }

  for (const [harness, frame, verb] of [
    ['claude', CLAUDE_WORKING, 'Pontificating…'],
    ['codex', CODEX_WORKING, 'Working…'],
  ] as const) {
    test(`${harness}: keeps the harness's own live line while a turn really runs`, async () => {
      // Arrange — the first turn was sent, and the pane shows the harness at work.
      paneAnswers(frame);
      const view = fresh(harness, { turn: 1, promptReady: false });

      // Act
      const page = mountPage(view);

      try {
        // Assert
        await settleUntil(
          () => page.root.findByType(Transcript).props.activity !== null,
          'the harness status line',
          runAsync,
        );
        expect(page.root.findByType(Transcript).props.activity.verb).toBe(verb);
        expect(page.root.findByType(Transcript).props.busy).toBe(true);
        expect(liveLines(page.root)).toHaveLength(1);
        expect(page.root.findByType(SessionTopBar).props.turn).toBe('working');
        expect(statusWord(page.root)).toBe('working');
      } finally {
        run(() => page.unmount());
      }
    });
  }

  test('the live line reads only the visible screen, never the whole scrollback', async () => {
    // Arrange
    paneQueries.length = 0;
    const reads = paneAnswers(CLAUDE_WORKING);
    const page = mountPage(fresh('claude', { turn: 3, turnState: 'working' }));

    try {
      // Act
      await settleUntil(() => reads.length > 0, 'the live pane read', runAsync);

      // Assert
      expect(paneQueries.length).toBeGreaterThan(0);
      expect(new Set(paneQueries)).toEqual(new Set(['?live=true&scope=screen']));
    } finally {
      run(() => page.unmount());
    }
  });

  test('a finished turn reads Ready once the pane shows the prompt again', async () => {
    // Arrange — the daemon still records the send's `promptReady: false`; only the pane knows better.
    const reads = paneAnswers(CLAUDE_IDLE);
    const page = mountPage(fresh('claude', { turn: 3, promptReady: false }));

    try {
      // Assert — working until the frame is read, ready after.
      expect(page.root.findByType(Transcript).props.busy).toBe(true);
      await settleUntil(
        () => page.root.findByType(SessionTopBar).props.turn === 'your-turn',
        'the idle frame',
        runAsync,
      );
      expect(reads.length).toBeGreaterThan(0);
      expect(page.root.findByType(Transcript).props.busy).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test('an unreadable pane on a session with a turn in flight keeps the old Working… line', async () => {
    // Arrange
    const reads = paneAnswers(null);
    const page = mountPage(fresh('codex', { turn: 2 }));

    try {
      await settleUntil(() => reads.length > 0, 'the failed pane read', runAsync);
      await runAsync(async () => await Promise.resolve());

      // Assert — no evidence either way is not evidence of idleness.
      expect(page.root.findByType(SessionTopBar).props.turn).toBe('working');
      expect(page.root.findByType(Transcript).props.busy).toBe(true);
      expect(textOf(must(liveLines(page.root)[0]))).toBe('Working…');
    } finally {
      run(() => page.unmount());
    }
  });

  test("the daemon's turn fact decides the spinner: working spins with the harness's own line", async () => {
    // Arrange — the daemon says working; the pane shows the harness at it.
    const reads = paneAnswers(CLAUDE_WORKING);
    const page = mountPage(fresh('claude', { turn: 2, turnState: 'working', turnStateAt: '2026-10-16T08:00:00.000Z' }));

    try {
      await settleUntil(() => page.root.findByType(Transcript).props.activity !== null, 'the status line', runAsync);
      // Assert
      expect(reads.length).toBeGreaterThan(0);
      expect(page.root.findByType(Transcript).props.busy).toBe(true);
      expect(page.root.findByType(Composer).props.busy).toBe(true);
      expect(statusWord(page.root)).toBe('working');
    } finally {
      run(() => page.unmount());
    }
  });

  test('hands the working turn’s start and the stream’s latest live sample to the transcript', async () => {
    // Arrange — the daemon says working since a known instant; the host's hub carries samples for it.
    paneAnswers(CLAUDE_WORKING);
    const turn = '2026-10-16T08:00:00.000Z';
    const hub = createLiveActivityHub();
    const page = mountPage(fresh('claude', { turn: 2, turnState: 'working', turnStateAt: turn }), undefined, hub);

    try {
      await settleUntil(() => page.root.findByType(Transcript).props.activity !== null, 'the status line', runAsync);
      expect(page.root.findByType(Transcript).props.turnStartedAt).toBe(turn);
      expect(page.root.findByType(Transcript).props.live).toBeNull();

      // Act — the stream publishes a sample for this turn.
      const sample = {
        sessionId: 'fresh-claude',
        at: '2026-10-16T08:00:05.000Z',
        turnStartedAt: turn,
        inputTokens: 48_000,
      };
      run(() => hub.publish(sample));

      // Assert — the page re-renders with it, and the line prints its input count beside the pane’s own output reading.
      expect(page.root.findByType(Transcript).props.live).toEqual(sample);
      const figures = page.root.findByProps({ className: 'fy-live-activity-detail' });
      expect(figures.props['data-live-input']).toBe('48000');
      expect(figures.props['data-live-output']).toBe('1200');
      expect(textOf(figures)).toContain('↓ 1.2k · ↑ 48k');
    } finally {
      run(() => page.unmount());
    }
  });

  test('gives the transcript no turn start when the session is not working, whatever the daemon last wrote', async () => {
    // Arrange
    paneAnswers(CLAUDE_WORKING);
    const page = mountPage(
      fresh('claude', { turn: 2, turnState: 'your-turn', turnStateAt: '2026-10-16T08:00:00.000Z' }),
      undefined,
      createLiveActivityHub(),
    );

    try {
      // Assert
      expect(page.root.findByType(Transcript).props.turnStartedAt).toBeNull();
    } finally {
      run(() => page.unmount());
    }
  });

  for (const [turnState, word] of [
    ['your-turn', 'your turn'],
    ['needs-input', 'needs input'],
  ] as const) {
    test(`the daemon's ${turnState} stops the spinner at once and reads no pane at all`, async () => {
      // Arrange — even a pane that would say otherwise is never asked: the daemon owns this fact.
      const reads = paneAnswers(CLAUDE_WORKING);
      const page = mountPage(fresh('codex', { turn: 2, turnState, turnStateAt: '2026-10-16T08:00:00.000Z' }));

      try {
        await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 30)));
        // Assert
        expect(reads).toHaveLength(0);
        expect(page.root.findByType(Transcript).props.busy).toBe(false);
        expect(liveLines(page.root)).toHaveLength(0);
        expect(page.root.findByType(Composer).props.busy).toBe(false);
        expect(page.root.findByType(SessionTopBar).props.turn).toBe(turnState);
        expect(statusWord(page.root)).toBe(word);
      } finally {
        run(() => page.unmount());
      }
    });
  }

  test("shows the account's real quota from the daemon's usage feed, and says unknown without one", async () => {
    // Arrange
    paneAnswers(CLAUDE_IDLE);
    const view = fresh('claude');
    const usage = new DaemonUsageStore({
      usage: async () => ({
        stale: false,
        accounts: [{ agent: 'claude-auto-gabriela', fiveHourPercent: 12, weeklyPercent: 40 }],
      }),
    });

    // Act
    const known = mountPage(view, usage);
    const unknown = mountPage(view);

    try {
      // Assert
      await settleUntil(
        () => known.root.findByType(Composer).props.quota !== null,
        'the usage feed to resolve the account',
        runAsync,
      );
      expect(known.root.findByType(Composer).props.quota).toMatchObject({ fiveHourPercent: 12, weeklyPercent: 40 });
      const token = known.root.findByProps({ className: 'fy-composer-quota' });
      expect(token.props['data-quota']).toBe('known');
      expect(unknown.root.findByType(Composer).props.quota).toBeNull();
      expect(unknown.root.findByProps({ className: 'fy-composer-quota' }).props['data-quota']).toBe('unknown');
    } finally {
      run(() => known.unmount());
      run(() => unknown.unmount());
    }
  });
});

const must = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value');
  return value;
};

describe('SessionChatPage Info and Actions', () => {
  const chatPage = (props: Partial<ComponentProps<typeof SessionChatPage>> = {}) => (
    <SessionChatPage
      client={client([], sessionView('shared'))}
      connection={alpha}
      context={contextDependencies()}
      entries={[]}
      onSessionChange={() => undefined}
      presentation="pane"
      session={sessionView('shared')}
      {...props}
    />
  );

  test('ⓘ opens Info beside the split on a desktop, at the remembered width and never under 360px', async () => {
    const rails = new WorkspaceRailPreferenceStore(NO_STORAGE);
    rails.setWidth('right', 420);
    const page = renderSessionChatPage(chatPage({ workspaceRails: rails }), fakeDaemon().factory);
    try {
      const bar = () => page.root.findByType(SessionTopBar);
      expect(bar().props.infoOpen).toBe(false);
      expect(page.root.findAllByProps({ 'data-info-frame': '' })).toHaveLength(0);

      run(() => bar().props.onToggleInfo());
      await flush();
      expect(bar().props.infoOpen).toBe(true);
      const frame = page.root.findByProps({ 'data-info-frame': '' });
      expect(frame.props.style.width).toBe('420px');
      expect(frame.findByType(SessionInfo).props.presentation).toBe('panel');
      // A desktop draws no Info sheet at all.
      expect(
        page.root.findAll(node => node.type === BottomSheet && node.props.closeLabel === 'Close Info'),
      ).toHaveLength(0);

      run(() => bar().props.onToggleInfo());
      expect(bar().props.infoOpen).toBe(false);
      expect(page.root.findAllByProps({ 'data-info-frame': '' })).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }

    // A rail remembered narrower than Info's floor still opens Info at 360px.
    const narrow = new WorkspaceRailPreferenceStore(NO_STORAGE);
    const second = renderSessionChatPage(
      chatPage({ initialInfo: 'overview', workspaceRails: narrow }),
      fakeDaemon().factory,
    );
    try {
      expect(second.root.findByProps({ 'data-info-frame': '' }).props.style.width).toBe('360px');
    } finally {
      run(() => second.unmount());
    }
  });

  test('on a phone Info is a bottom sheet at half height, and its header toggles full height', async () => {
    const page = renderSessionChatPage(chatPage({ presentation: 'sheet' }), fakeDaemon().factory);
    try {
      const sheet = () => page.root.find(node => node.type === BottomSheet && node.props.closeLabel === 'Close Info');
      expect(sheet().props.open).toBe(false);
      run(() => page.root.findByType(SessionTopBar).props.onToggleInfo());
      await flush();
      expect(sheet().props.open).toBe(true);
      expect(sheet().props.height).toContain('56dvh');
      expect(sheet().findByType(SessionInfo).props.presentation).toBe('sheet');
      expect(page.root.findAllByProps({ 'data-info-frame': '' })).toHaveLength(0);

      run(() => page.root.findByProps({ 'data-info-size': 'half' }).props.onClick());
      expect(sheet().props.height).toBe('calc(var(--app-h, 100dvh) - 28px)');
      run(() => page.root.findByProps({ 'data-info-size': 'full' }).props.onClick());
      expect(sheet().props.height).toContain('56dvh');

      run(() => page.root.findByProps({ 'data-info-close': '' }).props.onClick());
      expect(page.root.findByType(SessionTopBar).props.infoOpen).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test("Rename renames through the daemon client, and Info's pencil opens the same form", async () => {
    const daemon = fakeDaemon();
    const published: SessionView[] = [];
    const page = renderSessionChatPage(chatPage({ onSessionChange: view => published.push(view) }), daemon.factory);
    try {
      chooseAction(page.root, 'rename');
      expect(page.root.findByType(ActionsMenu).props.form).toBe('rename');
      // A form closes the menu and opens in a popover under Actions on a desktop.
      expect(actionsTrigger(page.root).props['aria-expanded']).toBe(false);
      expect(page.root.findAllByProps({ 'data-session-action-popover': '' })).toHaveLength(1);
      const form = page.root.findByType(RenameForm);
      await runAsync(async () => {
        await form.props.rename({ name: 'Sign-in fix' });
      });
      expect(daemon.calls).toEqual(['rename:shared:Sign-in fix:undefined:undefined']);
      expect(published.at(-1)?.config.label).toBe('Sign-in fix');
      run(() => page.root.findByType(ActionsMenu).props.onFormChange(null));
      expect(page.root.findAllByType(RenameForm)).toHaveLength(0);

      run(() => page.root.findByType(SessionTopBar).props.onToggleInfo());
      await flush();
      run(() => page.root.findByProps({ 'data-info-rename': '' }).props.onClick());
      expect(page.root.findByType(ActionsMenu).props.form).toBe('rename');
      expect(page.root.findAllByType(RenameForm)).toHaveLength(1);
    } finally {
      run(() => page.unmount());
    }
  });

  test('a read-only connection is offered only Copy session id, and no rename pencil', async () => {
    const page = renderSessionChatPage(chatPage({ canControl: false, initialInfo: 'overview' }), fakeDaemon().factory);
    try {
      await flush();
      expect(actionLabels(page.root)).toEqual(['Copy session id']);
      expect(page.root.findByType(SessionInfo).props.onRename).toBeUndefined();
      expect(page.root.findAllByProps({ 'data-info-rename': '' })).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });

  test('Fork forks through the latest message on the same login, names the fork and opens it', async () => {
    const daemon = fakeDaemon();
    const navigated: string[] = [];
    const page = renderSessionChatPage(chatPage({ onNavigate: to => navigated.push(to) }), daemon.factory);
    try {
      chooseAction(page.root, 'fork');
      const form = page.root.findByType(ForkForm);
      let outcome: unknown;
      await runAsync(async () => {
        outcome = await form.props.fork('Kit');
      });
      expect(daemon.calls).toEqual([
        'messages:shared',
        `fork:shared:point-9:${sessionView('shared').config.agent}`,
        'rename:forked:undefined:kit:undefined',
      ]);
      run(() => form.props.onForked(outcome));
      expect(navigated).toEqual([daemonSessionPath(alpha.daemonId, 'forked')]);
    } finally {
      run(() => page.unmount());
    }

    // Without a navigator the fork still lands; there is just nowhere to take the reader.
    const quiet = renderSessionChatPage(chatPage(), fakeDaemon().factory);
    try {
      chooseAction(quiet.root, 'fork');
      expect(() =>
        quiet.root.findByType(ForkForm).props.onForked({ session: { id: 'forked' }, plan: {} }),
      ).not.toThrow();
    } finally {
      run(() => quiet.unmount());
    }
  });

  test('Restart CLI asks inline, then migrates to the same login with resume and publishes the view', async () => {
    const daemon = fakeDaemon();
    const published: SessionView[] = [];
    const page = renderSessionChatPage(chatPage({ onSessionChange: view => published.push(view) }), daemon.factory);
    try {
      chooseAction(page.root, 'restart');
      expect(daemon.calls).toEqual([]);
      expect(textOf(page.root.findByProps({ 'data-menu-confirm': 'restart' }))).toContain('resumes the conversation');
      await runAsync(async () => {
        page.root.findByProps({ 'data-menu-confirm-yes': '' }).props.onClick();
        await Promise.resolve();
      });
      await flush();
      const agent = sessionView('shared').config.agent;
      expect(daemon.calls).toEqual([`migrate:shared:${agent}:undefined:false:true`]);
      expect(published.at(-1)?.config.id).toBe('shared');
    } finally {
      run(() => page.unmount());
    }
  });

  test('offers Move to Codex… only where the machine has a Codex account, and publishes the moved view', async () => {
    const codex = {
      id: 'codex-a',
      wrapper: 'codex-a',
      displayName: 'Codex A',
      kind: 'codex',
      agent: true,
      credentialId: 'login-a',
      defaultModel: null,
      models: [],
      available: true,
      unavailableReason: null,
    };
    const picker = (accounts: unknown[]) =>
      new DaemonAccountPickerStore({
        catalog: async () => ({ accounts }) as never,
        health: async () => ({ health: new Map(), error: null }),
        checkHealth: async () => ({ health: new Map(), error: null }),
      });
    const none = renderSessionChatPage(chatPage({ accountPicker: picker([]) }));
    try {
      await flush();
      expect(actionLabels(none.root)).not.toContain('Move to Codex…');
      expect(none.root.findAllByType(ConvertSheet)).toHaveLength(0);
    } finally {
      run(() => none.unmount());
    }
    const published: SessionView[] = [];
    const page = renderSessionChatPage(
      chatPage({ accountPicker: picker([codex]), onSessionChange: view => published.push(view) }),
    );
    try {
      await flush();
      expect(actionLabels(page.root)).toContain('Move to Codex…');
      chooseAction(page.root, 'move-harness');
      expect(page.root.findByType(ConvertSheet).props.open).toBe(true);
      run(() => page.root.findByType(ConvertSheet).props.onMoved(sessionView('shared'), 'Moved to Codex (Codex A).'));
      expect(published.at(-1)?.config.id).toBe('shared');
      run(() => page.root.findByType(ConvertSheet).props.onClose());
      expect(page.root.findByType(ConvertSheet).props.open).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test('Go back to the earlier conversation asks inline, then restarts on it and publishes the view', async () => {
    const daemon = fakeDaemon();
    const published: SessionView[] = [];
    const page = renderSessionChatPage(chatPage({ onSessionChange: view => published.push(view) }), daemon.factory);
    try {
      chooseAction(page.root, 'earlier-conversation');
      expect(daemon.calls).toEqual([]);
      await runAsync(async () => {
        page.root.findByProps({ 'data-menu-confirm-yes': '' }).props.onClick();
        await Promise.resolve();
      });
      await flush();
      expect(daemon.requests.at(-1)).toMatchObject({ conversation: 'previous' });
      expect(String(daemon.requests.at(-1)?.requestId)).toStartWith('earlier-shared-');
      expect(published.at(-1)?.config.id).toBe('shared');
    } finally {
      run(() => page.unmount());
    }
  });

  test('a failed action is said on the page’s one alert line', async () => {
    const daemon = fakeDaemon({ migrate: new Error('in-flight work would be lost') });
    const page = renderSessionChatPage(chatPage(), daemon.factory);
    try {
      chooseAction(page.root, 'restart');
      await runAsync(async () => {
        page.root.findByProps({ 'data-menu-confirm-yes': '' }).props.onClick();
        await Promise.resolve();
      });
      await flush();
      expect(JSON.stringify(page.toJSON())).toContain(
        'Session action failed: Restart CLI failed: in-flight work would be lost',
      );
    } finally {
      run(() => page.unmount());
    }
  });

  test('a Restart CLI refused because ps failed says so plainly and keeps the daemon words behind Details', async () => {
    const daemon = fakeDaemon({
      migrate: new FyHttpError(
        'refused: the process table could not be read: ps exited 1: ps: etimes: keyword not found',
        409,
        'migration_refused',
      ),
    });
    const page = renderSessionChatPage(chatPage(), daemon.factory);
    try {
      chooseAction(page.root, 'restart');
      await runAsync(async () => {
        page.root.findByProps({ 'data-menu-confirm-yes': '' }).props.onClick();
        await Promise.resolve();
      });
      await flush();
      const alert = JSON.stringify(page.toJSON());
      expect(alert).toContain(
        "Session action failed: Restart CLI failed: Couldn't check the agent's processes on this machine (ps failed). Nothing was restarted.",
      );
      expect(alert).toContain('Details');
      expect(alert).toContain('ps: etimes: keyword not found');
    } finally {
      run(() => page.unmount());
    }
  });

  const pausedRestart = (blockedBy: 'unknown' | 'destructive' | 'unreadable' = 'unknown') =>
    new FyHttpError('refused: raw daemon words', 409, 'migration_refused', {
      error: 'refused: raw daemon words',
      code: 'migration_refused',
      inflight: {
        status: 'running',
        turn: 13,
        blockedBy,
        restartsWithCli: 2,
        items: [
          {
            kind: 'process',
            verdict: 'unknown',
            title: 'A program Ferretry doesn’t recognise is running',
            detail: 'fy-helper --watch ./src',
            age: '24h',
            blocks: true,
          },
        ],
      },
    });
  const refusalPanel = (root: ReactTestInstance): ReactTestInstance | undefined =>
    root.findAll(node => node.type === 'section' && node.props['data-restart-refusal'] !== undefined)[0];
  const startRestart = async (page: ReturnType<typeof renderSessionChatPage>): Promise<void> => {
    chooseAction(page.root, 'restart');
    await runAsync(async () => {
      page.root.findByProps({ 'data-menu-confirm-yes': '' }).props.onClick();
      await Promise.resolve();
    });
    await flush();
  };
  const press = async (page: ReturnType<typeof renderSessionChatPage>, marker: string): Promise<void> => {
    await runAsync(async () => {
      page.root.findByProps({ [marker]: '' }).props.onClick();
      await Promise.resolve();
    });
    await flush();
  };

  test('a Restart CLI the daemon pauses says what is running and waits, instead of failing', async () => {
    const daemon = fakeDaemon({ migrate: pausedRestart() });
    const page = renderSessionChatPage(chatPage(), daemon.factory);
    try {
      await startRestart(page);
      const panel = refusalPanel(page.root);
      const text = textOf(must(panel));
      expect(text).toContain('Restart paused — Ferretry can’t tell if what the agent is running is safe to stop.');
      expect(text).toContain('Nothing was restarted.');
      expect(text).toContain('A program Ferretry doesn’t recognise is running');
      expect(text).toContain('fy-helper --watch ./src');
      expect(text).toContain('2 helper processes belong to the agent and restart with it.');
      const rendered = JSON.stringify(page.toJSON());
      expect(rendered).not.toContain('Session action failed');
      expect(rendered).not.toContain('raw daemon words');
      expect(daemon.requests).toHaveLength(1);

      // Cancel is the safe answer: the panel goes and nothing is asked again.
      await press(page, 'data-restart-refusal-cancel');
      expect(refusalPanel(page.root)).toBeUndefined();
      expect(daemon.requests).toHaveLength(1);
    } finally {
      run(() => page.unmount());
    }
  });

  test('Restart anyway asks again with forceInflight under a fresh request id, and publishes the view', async () => {
    const daemon = fakeDaemon({ migrate: [pausedRestart(), undefined] });
    const published: SessionView[] = [];
    const page = renderSessionChatPage(chatPage({ onSessionChange: view => published.push(view) }), daemon.factory);
    try {
      await startRestart(page);
      await press(page, 'data-restart-refusal-anyway');
      expect(daemon.requests.map(request => request.forceInflight)).toEqual([undefined, true]);
      expect(daemon.requests[1]?.requestId).not.toBe(daemon.requests[0]?.requestId);
      expect(refusalPanel(page.root)).toBeUndefined();
      expect(published.at(-1)?.config.id).toBe('shared');
    } finally {
      run(() => page.unmount());
    }
  });

  test('a restart that reaches the page through Add MCP is also held for the same confirm', async () => {
    const daemon = fakeDaemon({ migrate: pausedRestart('destructive') });
    const page = renderSessionChatPage(chatPage(), daemon.factory);
    try {
      chooseAction(page.root, 'add-mcp');
      const reload = page.root.findByType(AddMcpForm).props.ports.reload as () => Promise<void>;
      let thrown: unknown;
      await runAsync(async () => {
        thrown = await reload().catch((reason: unknown) => reason);
      });
      await flush();
      expect((thrown as Error).message).toBe(
        'Restart paused — the agent is running something that could be left half-done if it is stopped. Nothing was restarted.',
      );
      expect(refusalPanel(page.root)).toBeDefined();
    } finally {
      run(() => page.unmount());
    }
  });

  test('Stop and Resume run through the page client from Actions', async () => {
    const calls: string[] = [];
    const page = renderSessionChatPage(
      chatPage({
        client: client(calls, sessionView('shared')),
        session: sessionView('shared', { state: { status: 'completed' } }),
      }),
    );
    try {
      // A finished ferret is resumed, not restarted or stopped.
      expect(actionLabels(page.root)).toContain('Resume ferret');
      expect(actionLabels(page.root)).not.toContain('Restart CLI');
      chooseAction(page.root, 'resume');
      await flush();
      expect(calls).toEqual(['resume:shared']);
    } finally {
      run(() => page.unmount());
    }
  });

  test('Add MCP server reads, previews and adds through the session MCP routes, and reloads ferrets on that login', async () => {
    const daemon = fakeDaemon();
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return route(input);
    }) as typeof fetch;
    const current = sessionView('shared');
    const agent = current.config.agent;
    const sessions = [
      current,
      sessionView('peer'),
      sessionView('stranger', { config: { agent: 'codex-other' } }),
      sessionView('done', { state: { status: 'completed' } }),
    ];
    const page = renderSessionChatPage(chatPage({ daemonSessions: sessions, project: 'ferretry' }), daemon.factory);
    try {
      chooseAction(page.root, 'add-mcp');
      const form = page.root.findByType(AddMcpForm);
      expect(form.props).toMatchObject({ login: agent, project: 'ferretry' });
      const ports = form.props.ports;
      expect(ports.signIn.machineName).toBe('alpha box');
      expect((await ports.listing(new AbortController().signal)).project.path).toBe('/work/shared/.mcp.json');
      const request = { name: 'acme', server: { transport: 'command', command: 'npx', args: ['acme'], env: {} } };
      await ports.preview('project', request).catch(() => null);
      await ports.add('project', request).catch(() => null);
      expect(seen.filter(line => line.includes('/v1/sessions/shared/mcp')).length).toBeGreaterThanOrEqual(3);
      expect(seen.some(line => line.startsWith('POST /v1/sessions/shared/mcp'))).toBe(true);

      await runAsync(async () => await ports.reload());
      await runAsync(async () => await ports.reloadOthers());
      // Only the live ferrets on the same login are relaunched: never a stranger or a finished one.
      expect(daemon.calls).toEqual([
        `migrate:shared:${agent}:undefined:false:true`,
        `migrate:peer:${agent}:undefined:false:true`,
      ]);
    } finally {
      run(() => page.unmount());
    }

    // No fleet read and no MCP sign-in host: the form offers neither reload-others nor sign-in.
    const bare = renderSessionChatPage(chatPage({ context: undefined }), fakeDaemon().factory);
    try {
      chooseAction(bare.root, 'add-mcp');
      expect(bare.root.findByType(AddMcpForm).props.ports.reloadOthers).toBeUndefined();
      expect(bare.root.findByType(AddMcpForm).props.ports.signIn).toBeUndefined();
    } finally {
      run(() => bare.unmount());
    }
  });

  test('actionContributions add a row to its group, built against the same context as the core rows', () => {
    const ran: string[] = [];
    const warden: SessionActionContribution<CoreActionContext> = {
      group: 'warden',
      order: 10,
      build: context => ({
        kind: 'run',
        id: 'ask-warden',
        label: 'Ask the Warden to investigate',
        icon: Copy,
        run: () => {
          ran.push(context.view.config.id);
        },
      }),
    };
    const page = renderSessionChatPage(chatPage({ actionContributions: [warden] }));
    try {
      const labels = actionLabels(page.root);
      expect(labels.indexOf('Ask the Warden to investigate')).toBe(labels.indexOf('Restart CLI') - 1);
      openActions(page.root);
      const group = page.root.find(node => node.props.role === 'group' && node.props['aria-label'] === 'Warden');
      expect(group.findAllByProps({ 'data-session-action-item': 'ask-warden' })).toHaveLength(1);
      chooseAction(page.root, 'ask-warden');
      expect(ran).toEqual(['shared']);
    } finally {
      run(() => page.unmount());
    }
  });

  test('a form’s notice shows as the page’s toast, and a session change clears it', () => {
    const noticing: SessionActionContribution<CoreActionContext> = {
      group: 'warden',
      order: 10,
      build: () => ({
        kind: 'form',
        id: 'notice-form',
        label: 'Notice…',
        title: 'Notice',
        icon: Copy,
        render: host => (
          <button data-notify="" onClick={() => host.notify('Investigation queued.')} type="button">
            go
          </button>
        ),
      }),
    };
    const page = renderSessionChatPage(chatPage({ actionContributions: [noticing] }));
    try {
      expect(page.root.findByType(ActionToast).props.notice).toBeNull();
      chooseAction(page.root, 'notice-form');
      run(() => page.root.findByProps({ 'data-notify': '' }).props.onClick());
      expect(page.root.findByType(ActionToast).props.notice).toBe('Investigation queued.');
      run(() => page.root.findByType(ActionToast).props.onDismiss());
      expect(page.root.findByType(ActionToast).props.notice).toBeNull();

      chooseAction(page.root, 'notice-form');
      run(() => page.root.findByProps({ 'data-notify': '' }).props.onClick());
      run(() =>
        page.update(
          withSessionSearch(
            chatPage({
              actionContributions: [noticing],
              formFactor: 'desktop',
              session: sessionView('other'),
              workspaceLayouts: new WorkspaceLayoutStore(NO_STORAGE),
              workspaceRails: new WorkspaceRailPreferenceStore(NO_STORAGE),
            }),
          ),
        ),
      );
      expect(page.root.findByType(ActionToast).props.notice).toBeNull();
    } finally {
      run(() => page.unmount());
    }
  });

  test('Info › Runtime draws the composer’s own model and effort pickers when the host hands none', async () => {
    const ready = sessionView('shared');
    const page = renderSessionChatPage(
      chatPage({ client: { ...client([], ready), runtime: async () => ready }, initialInfo: 'runtime' }),
      fakeDaemon().factory,
    );
    try {
      await flush();
      const pickers = page.root.findByType(SessionInfo).props.runtimeControls;
      expect(pickers?.type).toBe(ComposerRuntime);
      // The same pickers, twice: the composer's status line and Info › Runtime's "Change" row.
      expect(page.root.findAllByType(ComposerRuntime)).toHaveLength(2);
    } finally {
      run(() => page.unmount());
    }

    // A daemon without the runtime route offers no pickers in either place.
    const bare = renderSessionChatPage(chatPage({ initialInfo: 'runtime' }), fakeDaemon().factory);
    try {
      await flush();
      expect(bare.root.findByType(SessionInfo).props.runtimeControls).toBeUndefined();
      expect(bare.root.findAllByType(ComposerRuntime)).toHaveLength(0);
    } finally {
      run(() => bare.unmount());
    }
  });

  test('Info › Runtime is handed the host’s passive-learning flag, and no Learning row without one', async () => {
    for (const [infoLearning, expected] of [
      [true, true],
      [false, false],
      [null, null],
      [undefined, undefined],
    ] as const) {
      const page = renderSessionChatPage(
        chatPage({ initialInfo: 'runtime', ...(infoLearning === undefined ? {} : { infoLearning }) }),
        fakeDaemon().factory,
      );
      try {
        await flush();
        expect(page.root.findByType(SessionInfo).props.learning).toBe(expected);
      } finally {
        run(() => page.unmount());
      }
    }
  });

  test('the header’s switch marks carry the host’s answers, and a tap only for a reader who may control it', async () => {
    const taps: string[] = [];
    const switches = { hypermedia: true, pack: false, onToggle: (section: string) => taps.push(section) };
    for (const canControl of [true, false]) {
      const page = renderSessionChatPage(chatPage({ infoLearning: true, switches, canControl }), fakeDaemon().factory);
      try {
        await flush();
        const marks = page.root.findByType(SessionTopBar).props.switches;
        expect(marks).toMatchObject({ learning: true, hypermedia: true, pack: false });
        expect(marks.onToggle === undefined).toBe(!canControl);
        marks.onToggle?.('hypermedia', false);
      } finally {
        run(() => page.unmount());
      }
    }
    expect(taps).toEqual(['hypermedia']);
    // A host that hands none leaves the bar to read the record itself.
    const bare = renderSessionChatPage(chatPage({}), fakeDaemon().factory);
    try {
      await flush();
      expect(bare.root.findByType(SessionTopBar).props.switches).toBeUndefined();
    } finally {
      run(() => bare.unmount());
    }
  });

  test('Info reads through the page ports, and every Info link opens where the page keeps it', async () => {
    const daemon = fakeDaemon();
    const layouts = new WorkspaceLayoutStore(NO_STORAGE);
    const scope = daemonSessionScope(alpha, 'shared');
    const navigated: string[] = [];
    const current = sessionView('shared');
    const sessions = [current, sessionView('child')];
    const page = renderSessionChatPage(
      chatPage({
        daemonSessions: sessions,
        infoRuntimeControls: <span data-runtime-slot="">pickers</span>,
        initialInfo: 'overview',
        onNavigate: to => navigated.push(to),
        workspaceLayouts: layouts,
      }),
      daemon.factory,
    );
    try {
      await flush();
      const info = () => page.root.findByType(SessionInfo);
      expect(info().props.sessions).toBe(sessions);
      // Overview reads the worktrees through the typed client.
      expect(daemon.calls).toContain('request:/v1/worktrees');
      const { ports } = info().props;
      await ports.verdicts(new AbortController().signal);
      expect(daemon.calls).toContain('verdicts');
      await ports.analytics(new AbortController().signal).catch(() => null);
      // Every server this ferret sees, from the daemon's inventory: only Ferretry's own tools server here.
      expect(
        (await ports.folder.loadMcp(new AbortController().signal)).servers.map(
          (server: { scope: string; name: string }) => `${server.scope}:${server.name}`,
        ),
      ).toEqual(['ferretry:ferretry']);
      expect(ports.folder.sessionId).toBe('shared');
      expect(ports.folder.machineName).toBe('alpha box');
      expect(ports.folder.agentName).toBe(sessionDisplayName(current));
      expect(ports.folder.mcpSignIn.machineName).toBe('alpha box');
      run(() => ports.folder.onInsertSkill('/floop'));

      const tabs = () => Object.keys(layouts.snapshot(scope).tabs);
      run(() => ports.folder.onOpenFile('README.md'));
      expect(tabs()).toContain('file:README.md');
      run(() => ports.folder.renderFiles().props.onOpenFile('src/app.ts', { line: 3 }));
      expect(tabs()).toContain('file:src/app.ts');
      run(() => info().props.onOpenTerminal('a1b2c3d4e5f6', 'dev'));
      expect(layouts.snapshot(scope).tabs['terminal:a1b2c3d4e5f6']?.label).toBe('dev');
      run(() => info().props.onOpenPage({ id: 'PAGE3', url: 'https://example.test/pr', title: 'The PR' }));
      expect(tabs()).toContain('browser:PAGE3');
      run(() => info().props.onOpenPage({ id: 'PAGE1', name: 'app', url: 'https://example.test/', title: 'App' }));
      expect(tabs()).toContain('browser:app');
      run(() => info().props.onOpenSession('child'));
      expect(navigated).toEqual([daemonSessionPath(alpha.daemonId, 'child')]);

      // Folder › MCP's "Add…" opens the Add MCP server form.
      run(() => ports.folder.onAddMcp());
      expect(page.root.findByType(ActionsMenu).props.form).toBe('add-mcp');

      // Info › Runtime carries the host's model and effort pickers.
      run(() => info().props.placement.setTab('runtime'));
      await flush();
      expect(page.root.findAllByProps({ 'data-runtime-slot': '' })).toHaveLength(1);
    } finally {
      run(() => page.unmount());
    }
  });

  test('a session change clears an open form and the migration sheet', () => {
    const page = renderSessionChatPage(chatPage());
    try {
      chooseAction(page.root, 'rename');
      expect(page.root.findAllByType(RenameForm)).toHaveLength(1);
      chooseAction(page.root, 'move-login');
      expect(page.root.findByType(MigrateSheet).props.open).toBe(true);
      run(() =>
        page.update(
          withSessionSearch(
            chatPage({
              formFactor: 'desktop',
              session: sessionView('other'),
              workspaceLayouts: new WorkspaceLayoutStore(NO_STORAGE),
              workspaceRails: new WorkspaceRailPreferenceStore(NO_STORAGE),
            }),
          ),
        ),
      );
      expect(page.root.findByType(ActionsMenu).props.form).toBeNull();
      expect(page.root.findAllByType(RenameForm)).toHaveLength(0);
      expect(page.root.findByType(MigrateSheet).props.open).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });
});
