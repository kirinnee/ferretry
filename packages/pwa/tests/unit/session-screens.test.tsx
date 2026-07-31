import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { canSubmitComposer, composerUsesEnterToSend, Composer } from '../../src/components/composer.tsx';
import { SessionDetails } from '../../src/components/session-details.tsx';
import { SessionList, sessionNavigation } from '../../src/components/session-list.tsx';
import { relativeTime } from '../../src/components/session-screen-types.ts';
import { transcriptIsFollowing, Transcript } from '../../src/components/transcript.tsx';
import type { SessionView } from '@ferretry/protocol';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const connection = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://daemon.example', deviceToken: 'token' });

const session = (id = 'same-id'): SessionView =>
  ({
    config: {
      id,
      name: 'Transcript scrolling',
      label: 'Port the session screen',
      teammate: 'Fable',
      modelHint: 'gpt-5.6',
      model: 'gpt-5.6-sol',
      agent: 'codex',
      mode: 'auto',
      cwd: '/work/ferretry',
      parent: undefined,
      updatedAt: '1970-01-01T00:00:01.000Z',
    },
    state: {
      id,
      status: 'running',
      turn: 4,
      lastActivityAt: '1970-01-01T00:00:01.000Z',
      contextPercent: 54,
      activity: 'Writing tests',
    },
    directory: '/work/ferretry',
  }) as unknown as SessionView;

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('session screen components', () => {
  test('session list supplies daemon and session identity together on navigation', () => {
    expect(sessionNavigation('daemon-a', 'same-id')).toEqual(['daemon-a', 'same-id']);
    const html = renderToStaticMarkup(
      <SessionList daemonId="daemon-a" onOpenSession={() => {}} sessions={[session()]} />,
    );
    expect(html).toContain('Transcript scrolling');
    expect(html).toContain('Port the session screen');
  });

  test('details retain metadata hierarchy and no global daemon assumption', () => {
    const html = renderToStaticMarkup(<SessionDetails daemonId="daemon-b" session={session()} now={2_000} />);
    expect(html).toContain('Session details');
    expect(html).toContain('daemon-b');
    expect(html).toContain('Transcript scrolling');
  });

  test('transcript identifiers include daemon and follow state has an exact bottom threshold', () => {
    const html = renderToStaticMarkup(
      <Transcript daemonId="daemon-b" entries={[{ id: '1', kind: 'assistant', text: 'Done' }]} sessionId="same-id" />,
    );
    expect(html).toContain('data-daemon-id="daemon-b"');
    expect(transcriptIsFollowing({ scrollHeight: 500, clientHeight: 200, scrollTop: 276 })).toBe(true);
    expect(transcriptIsFollowing({ scrollHeight: 500, clientHeight: 200, scrollTop: 275 })).toBe(false);
  });

  test('composer persistence and safety are scoped to the paired daemon', () => {
    const storage = new MemoryStorage();
    const drafts = new DaemonDraftStore(storage);
    const scope = daemonSessionScope(connection, 'same-id');
    drafts.save(scope, 'Saved only for daemon A', 1);
    const otherDaemon = daemonConnection({
      daemonId: 'daemon-b',
      baseUrl: 'https://other.example',
      deviceToken: 'token-b',
    });
    const html = renderToStaticMarkup(
      <Composer
        api={{ send: async () => ({}) as never }}
        daemon={connection}
        draftStore={drafts}
        sessionId="same-id"
      />,
    );
    expect(html).toContain('Saved only for daemon A');
    expect(drafts.load(daemonSessionScope(otherDaemon, 'same-id'))).toBe('');
    expect(canSubmitComposer('  message ', false, false)).toBe(true);
    expect(canSubmitComposer('   ', false, false)).toBe(false);
    expect(composerUsesEnterToSend(true, true)).toBe(true);
    expect(composerUsesEnterToSend(false, true)).toBe(false);
  });

  test('relative time is compact and deterministic', () => {
    expect(relativeTime(1, 30_000)).toBe('now');
    expect(relativeTime(1_000, 121_000)).toBe('2m ago');
  });
});
