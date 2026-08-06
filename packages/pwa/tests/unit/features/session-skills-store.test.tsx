import { afterEach, describe, expect, it } from 'bun:test';
import { type SessionSkillsRead, useSessionSkills } from '../../../src/features/skills/session-skills-store.ts';
import type { SkillsCatalog } from '../../../src/features/skills/skills-catalog.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import type { DaemonFetch } from '../../../src/lib/runtime-models.ts';
import { render, run, runAsync } from '../../support/react.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const scopeA = daemonSessionScope(laptop, 'session-a');
const scopeB = daemonSessionScope(laptop, 'session-b');

const catalog = (...names: readonly string[]): SkillsCatalog => ({
  harness: 'claude',
  skills: names.map(name => ({ name, description: 'A skill.', scope: 'global', origin: 'both' })),
});

const originalFetch = globalThis.fetch;
const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

/** Publishes the hook's value so a test can read and drive it. */
function Probe({
  scope,
  fetcher,
  onRead,
}: {
  readonly scope: DaemonSessionScope;
  readonly fetcher?: DaemonFetch;
  readonly onRead: (read: SessionSkillsRead) => void;
}) {
  onRead(useSessionSkills(laptop, scope, fetcher));
  return null;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('useSessionSkills', () => {
  it('reads once and hands the pane the very same read', async () => {
    const asked: string[] = [];
    const fetcher: DaemonFetch = async url => {
      asked.push(String(url));
      return Response.json(catalog('floop', 'run'));
    };
    let latest: SessionSkillsRead | null = null;
    const tree = render(
      <Probe
        fetcher={fetcher}
        onRead={read => {
          latest = read;
        }}
        scope={scopeA}
      />,
    );
    try {
      await settle();
      const first = latest as SessionSkillsRead | null;
      expect(first?.names).toEqual(['floop', 'run']);
      expect(first?.catalog?.skills.map(skill => skill.name)).toEqual(['floop', 'run']);
      await first?.settled();

      // The pane mounts and asks. It must JOIN, not start a second read.
      const joined = await first?.load(scopeA, new AbortController().signal);
      expect(joined?.skills.map(skill => skill.name)).toEqual(['floop', 'run']);
      expect(asked).toEqual(['https://laptop.example.test/v1/sessions/session-a/skills']);
    } finally {
      run(() => tree.unmount());
    }
  });

  it('treats a second call as the reader asking again', async () => {
    let answer = catalog('floop');
    const asked: string[] = [];
    const fetcher: DaemonFetch = async url => {
      asked.push(String(url));
      return Response.json(answer);
    };
    let latest: SessionSkillsRead | null = null;
    const tree = render(
      <Probe
        fetcher={fetcher}
        onRead={read => {
          latest = read;
        }}
        scope={scopeA}
      />,
    );
    try {
      await settle();
      const read = latest as SessionSkillsRead | null;
      await read?.load(scopeA, new AbortController().signal);
      answer = catalog('floop', 'kteam');
      await runAsync(async () => {
        await read?.load(scopeA, new AbortController().signal);
        await settle();
      });

      expect(asked).toHaveLength(2);
      // Refresh is a real refresh: the shared names move with it, so the pane
      // and the transcript cannot disagree about what this session can prove.
      expect((latest as SessionSkillsRead | null)?.names).toEqual(['floop', 'kteam']);
    } finally {
      run(() => tree.unmount());
    }
  });

  it('never answers one session with another session catalog', async () => {
    const fetcher: DaemonFetch = async url =>
      Response.json(String(url).includes('session-a') ? catalog('for-a') : catalog('for-b'));
    let latest: SessionSkillsRead | null = null;
    const tree = render(
      <Probe
        fetcher={fetcher}
        onRead={read => {
          latest = read;
        }}
        scope={scopeA}
      />,
    );
    try {
      await settle();
      expect((latest as SessionSkillsRead | null)?.names).toEqual(['for-a']);

      // A pane asking about a session this hook is not holding gets a real read
      // for THAT session rather than the one already in hand.
      let other: SkillsCatalog | undefined;
      await runAsync(async () => {
        other = await (latest as SessionSkillsRead | null)?.load(scopeB, new AbortController().signal);
        await settle();
      });
      expect(other?.skills.map(skill => skill.name)).toEqual(['for-b']);
      // …and the shared names still describe the session that is on screen.
      expect((latest as SessionSkillsRead | null)?.names).toEqual(['for-a']);
    } finally {
      run(() => tree.unmount());
    }
  });

  it('leaves the names unread rather than empty when the daemon refuses', async () => {
    const fetcher: DaemonFetch = async () => new Response('nope', { status: 500 });
    let latest: SessionSkillsRead | null = null;
    const tree = render(
      <Probe
        fetcher={fetcher}
        onRead={read => {
          latest = read;
        }}
        scope={scopeA}
      />,
    );
    try {
      await settle();
      // NOT `[]`: an empty catalog would prove that this session has no skills
      // and render every valid invocation as prose.
      expect((latest as SessionSkillsRead | null)?.names).toBeUndefined();
      await expect((latest as SessionSkillsRead | null)?.load(scopeA, new AbortController().signal)).rejects.toThrow();
    } finally {
      run(() => tree.unmount());
    }
  });

  it('reads through the browser transport when no fetcher is injected', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return Response.json(catalog('floop'));
    }) as typeof fetch;
    let latest: SessionSkillsRead | null = null;
    const tree = render(
      <Probe
        onRead={read => {
          latest = read;
        }}
        scope={scopeA}
      />,
    );
    try {
      await settle();
      expect(asked).toEqual(['https://laptop.example.test/v1/sessions/session-a/skills']);
      expect((latest as SessionSkillsRead | null)?.names).toEqual(['floop']);
    } finally {
      run(() => tree.unmount());
    }
  });
});
