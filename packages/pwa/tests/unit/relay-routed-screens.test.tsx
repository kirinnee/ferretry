import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { FileInstanceSurface } from '../../src/components/file-instance-surface.tsx';
import { fsApi, resetFsProbes } from '../../src/components/files-api.ts';
import { sessionReferenceSurface } from '../../src/components/reference-surface.tsx';
import { SessionSearchControl, SessionSearchProvider } from '../../src/features/session-search/session-search.tsx';
import { SessionSkillsSurface } from '../../src/features/skills/session-skills-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { type AppStore, StoreProvider } from '../../src/lib/store.tsx';
import { interact, mount, must } from '../support/dom.ts';

/**
 * Every screen here used to reach its daemon over the daemon's own address, past the carrier router.
 *
 * On a daemon only the relay can reach that address answers nothing, so each test makes the direct
 * network THROW and hands the store a carrier that answers. A screen that still dials directly shows
 * its failure; one that goes through the carrier shows the daemon's answer.
 */
const daemon = daemonConnection({
  daemonId: 'relayed',
  baseUrl: 'https://relayed.example.test',
  deviceId: 'relayed-token',
});
const scope = daemonSessionScope(daemon, 'session-a');

interface Seen {
  readonly method: string;
  readonly pathname: string;
}

const originalFetch = globalThis.fetch;
const direct: Seen[] = [];

beforeEach(() => {
  direct.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    direct.push({ method: init?.method ?? 'GET', pathname: new URL(String(input)).pathname });
    throw new TypeError('Failed to fetch: this daemon is reachable only through the relay');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetFsProbes();
});

const carrier = (answer: (seen: Seen) => Response): { readonly seen: Seen[]; readonly fetch: DaemonFetch } => {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const row = { method: init?.method ?? 'GET', pathname: new URL(String(input)).pathname };
      seen.push(row);
      return answer(row);
    },
  };
};

const routed = (fetch: DaemonFetch, children: ReactNode) => (
  <StoreProvider store={{ carrier: { fetch } } as unknown as AppStore}>{children}</StoreProvider>
);

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await interact(async () => await Promise.resolve());
};

describe('screens read a relay-only daemon through the carrier', () => {
  it('the chat search reads its file index through the carrier and dials nothing directly', async () => {
    // Arrange
    const relay = carrier(row => {
      if (row.pathname.endsWith('/fs/index'))
        return Response.json({
          v: 1,
          sessionId: 'session-a',
          root: '/work',
          files: [{ name: 'needle.ts', path: 'src/needle.ts' }],
          coverage: 'complete',
          skipped: [],
        });
      return new Response('not found', { status: 404 });
    });
    const view = await mount(
      routed(
        relay.fetch,
        <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
          <SessionSearchControl />
        </SessionSearchProvider>,
      ),
    );
    await settle();

    // Act
    const input = must(view.container.querySelector<HTMLInputElement>('input'), 'search input');
    await interact(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();

    // Assert
    expect(relay.seen.filter(row => row.pathname.endsWith('/fs/index'))).toHaveLength(1);
    expect(relay.seen.some(row => /\/tasks(\/|$)/u.test(row.pathname))).toBe(false);
    expect(view.container.textContent).toContain('src/needle.ts');
    expect(direct).toEqual([]);
    await view.unmount();
  });

  it('an open file reads its bytes and its change probe through the carrier', async () => {
    // Arrange
    const relay = carrier(row => {
      if (row.pathname.endsWith('/fs/changes')) return Response.json({ repo: false, changes: [] });
      if (row.pathname.endsWith('/fs/file'))
        return Response.json({ path: 'README.md', size: 13, content: 'relayed bytes' });
      return new Response('not found', { status: 404 });
    });
    const instance = {
      id: 'file:README.md',
      kind: 'file',
      key: 'README.md',
      label: 'README.md',
      title: 'README.md',
      order: 1,
      revision: 1,
    } as const;

    // Act
    const view = await mount(
      routed(relay.fetch, <FileInstanceSurface daemon={daemon} scope={scope} instance={instance} />),
    );
    await settle();

    // Assert
    expect(view.container.textContent).toContain('relayed bytes');
    expect(relay.seen.map(row => row.pathname)).toContain('/v1/sessions/session-a/fs/changes');
    expect(direct).toEqual([]);
    await view.unmount();
  });

  it('the @file reference proof lists directories through the fetch it is handed', async () => {
    // Arrange
    const relay = carrier(() =>
      Response.json({ root: '/work', path: 'src', entries: [{ name: 'a.ts', type: 'file', size: 1 }] }),
    );
    const surface = sessionReferenceSurface({ connection: daemon, fetcher: relay.fetch, scope });

    // Act
    const proved = await must(surface.resolveFilePaths, 'file resolver')(['src/a.ts'], new AbortController().signal);

    // Assert
    expect([...proved]).toEqual([['src/a.ts', 'src/a.ts']]);
    expect(direct).toEqual([]);
  });

  it('a file listing that is not a listing is refused at the boundary', async () => {
    // Arrange: the old cast handed this body to the @file proof and the tree as if it were a listing.
    const relay = carrier(() => Response.json({ entries: 'not a list' }));

    // Act + Assert
    await expect(fsApi.list(daemon, scope, '', undefined, relay.fetch)).rejects.toThrow('cannot read');
  });

  it('the skills pane reads its catalog through the carrier', async () => {
    // Arrange
    const relay = carrier(() => new Response('{"error":"no skills for the test"}', { status: 404 }));

    // Act
    const view = await mount(routed(relay.fetch, <SessionSkillsSurface connection={daemon} scope={scope} />));
    await settle();

    // Assert
    expect(relay.seen.map(row => row.pathname)).toContain('/v1/sessions/session-a/skills');
    expect(direct).toEqual([]);
    await view.unmount();
  });
});
