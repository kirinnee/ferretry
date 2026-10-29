import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { type ComponentProps, cloneElement, type ReactElement } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  type SessionAttentionModel,
  type SessionChatClient,
  SessionChatPage,
} from '../../src/lib/pages/session-chat-page.tsx';
import { WorkspaceLayoutStore } from '../../src/lib/workspace-layout-store.ts';
import { WorkspaceRailPreferenceStore } from '../../src/lib/workspace-rail-preferences.ts';
import { SessionSearchProvider } from '../../src/features/session-search/session-search.tsx';
import { resetSidePaneTabsStates } from '../../src/shell/side-pane-tab-model.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});

const NO_STORAGE = { getItem: () => null, setItem: () => undefined };
const originalFetch = globalThis.fetch;

const route = (input: string | URL | Request): Response => {
  const url = new URL(String(input), 'https://fixture.example.test');
  const sessionId = decodeURIComponent(url.pathname.split('/v1/sessions/')[1]?.split('/')[0] ?? '');
  if (url.pathname.endsWith('/fs/index'))
    return Response.json({ v: 1, sessionId, root: `/work/${sessionId}`, files: [], coverage: 'complete', skipped: [] });
  if (url.pathname.endsWith('/mcp'))
    return Response.json({ project: { path: `/work/${sessionId}/.mcp.json`, etag: null, servers: [] } });
  if (url.pathname.includes('/v1/sessions/') && url.pathname.endsWith('/tasks'))
    return Response.json({ v: 1, sessionId, tasks: [], parseErrors: 0, updatedAt: '2026-08-06T00:00:00.000Z' });
  return Response.json(url.pathname.endsWith('/changes') ? { repo: false, changes: [] } : { entries: [] });
};

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request) => route(input)) as typeof fetch;
});

afterEach(() => {
  resetSidePaneTabsStates();
  globalThis.fetch = originalFetch;
});

const renderPage = (props: Partial<ComponentProps<typeof SessionChatPage>> = {}) => {
  const page = (
    <SessionChatPage
      client={{ interrupt: async () => sessionView('shared') } as unknown as SessionChatClient}
      connection={alpha}
      entries={[]}
      onSessionChange={() => undefined}
      presentation="pane"
      session={sessionView('shared')}
      workspaceLayouts={new WorkspaceLayoutStore(NO_STORAGE)}
      workspaceRails={new WorkspaceRailPreferenceStore(NO_STORAGE)}
      formFactor="desktop"
      {...props}
    />
  );
  return render(
    <SessionSearchProvider
      connection={alpha}
      focusSignal={0}
      scope={daemonSessionScope(alpha, page.props.session.config.id)}
    >
      {cloneElement(page as ReactElement)}
    </SessionSearchProvider>,
  );
};

const interruptButton = (root: ReactTestInstance): ReactTestInstance => {
  const button = root.findAllByType('button').find(candidate => candidate.props['aria-label'] === 'Interrupt turn');
  if (button === undefined) throw new Error('missing the Interrupt button');
  return button;
};

describe('SessionChatPage branches', () => {
  test('offers the composer no Attention catalogue while the board is unreadable', () => {
    const unreadable = { client: {}, snapshot: null, status: 'error' } as unknown as SessionAttentionModel;
    const page = renderPage({ attention: unreadable });

    try {
      expect('autocompleteAttention' in page.root.findByType(Composer).props).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test('publishes an answered session, and drops an answer that names another session', async () => {
    const published: SessionView[] = [];
    let refreshes = 0;
    let answer: SessionView = sessionView('other');
    const page = renderPage({
      client: { interrupt: async () => answer } as unknown as SessionChatClient,
      onRefresh: () => {
        refreshes += 1;
      },
      onSessionChange: view => published.push(view),
    });

    try {
      await runAsync(async () => {
        interruptButton(page.root).props.onClick();
        await Promise.resolve();
      });
      expect(published).toEqual([]);
      expect(refreshes).toBe(0);

      answer = sessionView('shared', { state: { status: 'interrupted' } });
      await runAsync(async () => {
        interruptButton(page.root).props.onClick();
        await Promise.resolve();
      });
      expect(published).toEqual([answer]);
      expect(refreshes).toBe(1);
    } finally {
      run(() => page.unmount());
    }
  });
});
