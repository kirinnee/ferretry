import { beforeEach, describe, test } from 'bun:test';
import type { AgendaId, SessionView } from '@ferretry/protocol';
import should from 'should';
import {
  ReferenceSurfaceProvider,
  sessionReferenceSurface,
  useReferenceSurface,
} from '../../src/components/reference-surface.tsx';
import type { DaemonConnection, DaemonId } from '../../src/lib/daemon-connection.ts';
import { browserFetch } from '../../src/lib/runtime-models.ts';
import {
  readSidePaneTabsState,
  resetSidePaneTabRegistry,
  resetSidePaneTabsStates,
  sidePaneInstanceTabId,
} from '../../src/shell/side-pane-tab-model.ts';
import { render } from '../support/react.ts';

const daemonId = 'daemon-a' as DaemonId;
const scope = { daemonId, sessionId: 'session-1' };
const connection = { daemonId, baseUrl: 'https://daemon.invalid', token: 't' } as unknown as DaemonConnection;

const sessionView = (id: string, teammate: string): SessionView =>
  ({
    config: { id, teammate, createdAt: new Date().toISOString(), name: '', agent: 'claude', model: '' },
    state: { status: 'working', activity: '' },
  }) as unknown as SessionView;

/** Reads the surface exactly the way a transcript row does. */
function Reader({ onSurface }: { readonly onSurface: (surface: ReturnType<typeof useReferenceSurface>) => void }) {
  onSurface(useReferenceSurface());
  return null;
}

beforeEach(() => {
  resetSidePaneTabRegistry();
  resetSidePaneTabsStates();
});

describe('useReferenceSurface', () => {
  test('should offer nothing at all outside a session workspace', () => {
    // Arrange
    let seen: unknown;

    // Act
    render(<Reader onSurface={surface => (seen = surface)} />);

    // Assert — no resolver and no opener, so reference-shaped text stays prose.
    should(seen).deepEqual({});
  });

  test('should hand every reader in the workspace the same surface object', () => {
    // Arrange
    const surface = { onNavigate: () => undefined };
    const seen: unknown[] = [];

    // Act
    render(
      <ReferenceSurfaceProvider surface={surface}>
        <Reader onSurface={value => seen.push(value)} />
        <Reader onSurface={value => seen.push(value)} />
      </ReferenceSurfaceProvider>,
    );

    // Assert
    should(seen).have.length(2);
    should(seen[0]).equal(surface);
    should(seen[1]).equal(surface);
  });
});

describe('sessionReferenceSurface', () => {
  test('should supply a resolver only for what this session can actually prove', () => {
    // Act
    const bare = sessionReferenceSurface({ connection, scope, fetcher: browserFetch });

    // Assert — an unread fleet, no board, no ledger and no catalog each mean
    // "cannot prove", which is not the same as "nothing matches".
    should(bare.agentReferenceResolver).be.undefined();
    should(bare.taskReferenceResolver).be.undefined();
    should(bare.agendaReferenceResolver).be.undefined();
    should(bare.skillReferenceResolver).be.undefined();
    should(bare.onNavigate).be.undefined();
    should(bare.surfaceReferenceResolver).be.a.Function();
  });

  test('should prove a callsign against this daemon only, and stamp its daemon on', () => {
    // Arrange
    const surface = sessionReferenceSurface({
      connection,
      fetcher: browserFetch,
      scope,
      sessions: [sessionView('session-9', 'zelda')],
      onNavigate: () => undefined,
    });

    // Act
    const resolved = surface.agentReferenceResolver?.({ name: 'zelda' });

    // Assert
    should(resolved).deepEqual({ daemonId, sessionId: 'session-9', name: 'zelda' });
    should(surface.agentReferenceResolver?.({ name: 'ganon' })).be.null();
  });

  test('should prove tasks, attention and skills from the snapshots the host holds', () => {
    // Arrange
    const surface = sessionReferenceSurface({
      connection,
      fetcher: browserFetch,
      scope,
      tasks: [{ id: 'F12' }],
      agendaIds: ['A3' as AgendaId],
      skills: ['summary'],
    });

    // Assert
    should(surface.taskReferenceResolver?.('f12')).be.true();
    should(surface.taskReferenceResolver?.('F99')).be.false();
    should(surface.agendaReferenceResolver?.('A3' as AgendaId)).be.true();
    should(surface.agendaReferenceResolver?.('A4' as AgendaId)).be.false();
    should(surface.skillReferenceResolver?.('summary')).be.true();
    should(surface.skillReferenceResolver?.('missing')).be.false();
  });

  test('should not turn a catalog name the grammar refuses into a different name it accepts', () => {
    // Arrange — the catalog accepts any nonempty trimmed name; the reference
    // grammar accepts lowercase ones only. `Floop` therefore has NO valid
    // reference at all, and `/floop` is a different identity that this session
    // may well not have.
    const surface = sessionReferenceSurface({ connection, scope, fetcher: browserFetch, skills: ['Floop', 'run'] });

    // Assert — case-folding the proof set used to make `/floop` live off the
    // back of `Floop`, while Add to chat kept refusing `/Floop`: the transcript
    // and the action disagreed about what this session can address.
    should(surface.skillReferenceResolver?.('floop')).be.false();
    // The exact, valid entry still proves, so this is a narrowing and not a
    // silencing.
    should(surface.skillReferenceResolver?.('run')).be.true();
  });

  test('should ask the session filesystem for nothing when there is no candidate', async () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope, fetcher: browserFetch, cwd: '/repo' });

    // Act — no candidates means no directory read at all, so this cannot reach
    // the daemon.
    const resolved = await surface.resolveFilePaths?.([], new AbortController().signal);

    // Assert
    should(resolved).deepEqual(new Map());
  });

  test('should open a file reference as a file instance tab carrying its lines', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope, fetcher: browserFetch });

    // Act
    surface.onCodeReferenceOpen?.({ path: 'src/api.ts', line: 12, endLine: 20 });

    // Assert
    const id = sidePaneInstanceTabId('file', 'src/api.ts');
    should(readSidePaneTabsState(scope).active).equal(id);
    should(readSidePaneTabsState(scope).instances[id]?.selection).deepEqual({ line: 12, endLine: 20 });
  });

  test('should open a bare file reference without claiming a line', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope, fetcher: browserFetch });

    // Act
    surface.onCodeReferenceOpen?.({ path: 'README.md' });

    // Assert
    const id = sidePaneInstanceTabId('file', 'README.md');
    should(readSidePaneTabsState(scope).instances[id]?.selection).be.undefined();
  });

  test('should open a file reference with only a start line', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope, fetcher: browserFetch });

    // Act
    surface.onCodeReferenceOpen?.({ path: 'src/api.ts', line: 4 });

    // Assert
    const id = sidePaneInstanceTabId('file', 'src/api.ts');
    should(readSidePaneTabsState(scope).instances[id]?.selection).deepEqual({ line: 4 });
  });

  test('should send a skill click to the skills pane and leave a task click alone with no card route to open', () => {
    const surface = sessionReferenceSurface({ connection, scope, fetcher: browserFetch });

    surface.onTaskOpen?.('F12');
    const afterTask = readSidePaneTabsState(scope).active;
    surface.onSkillOpen?.('summary');

    should([afterTask, readSidePaneTabsState(scope).active]).deepEqual([null, 'skills']);
  });

  test('should open the card an old task reference was imported as, and prefer a card on the slice with that id', () => {
    const visited: string[] = [];
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      onNavigate: to => visited.push(to),
      tasks: [{ id: 'F12' }, { id: 'F96', legacyId: 'F12' }, { id: 'F97', legacyId: 'F7' }],
    });

    surface.onTaskOpen?.('f7');
    surface.onTaskOpen?.('f12');

    should(visited).deepEqual(['/d/daemon-a/board/F97', '/d/daemon-a/board/F12']);
    should(surface.taskReferenceResolver?.('f7')).be.true();
    should(surface.taskReferenceResolver?.('F8')).be.false();
  });

  test('should prove and open a card on another project from the machine-wide ids', () => {
    // Arrange
    const visited: string[] = [];
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      onNavigate: to => visited.push(to),
      tasks: [{ id: 'F12' }],
      taskIds: new Set(['F12', 'F364']),
    });

    // Act
    surface.onTaskOpen?.('f364');

    // Assert
    should(surface.taskReferenceResolver?.('f364')).be.true();
    should(surface.taskReferenceResolver?.('F365')).be.false();
    should(visited).deepEqual(['/d/daemon-a/board/F364']);
  });

  test('should prove from the machine-wide ids when the host holds no project slice', () => {
    const surface = sessionReferenceSurface({ connection, scope, fetcher: browserFetch, taskIds: new Set(['F364']) });

    should(surface.taskReferenceResolver?.('F364')).be.true();
    should(surface.taskReferenceResolver?.('F1')).be.false();
  });

  test("should open a task on this machine's board when the host can navigate, not the Tasks sheet", () => {
    // Arrange
    const visited: string[] = [];
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      onNavigate: to => visited.push(to),
    });

    // Act
    surface.onTaskOpen?.('f412');

    // Assert
    should(visited).deepEqual(['/d/daemon-a/board/F412']);
    should(readSidePaneTabsState(scope).active).equal(null);
  });

  test('should open the card even when the host has its own Tasks destination', () => {
    // Arrange
    const visited: string[] = [];
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      onNavigate: to => visited.push(to),
      destinations: { openTasks: () => visited.push('tasks') },
    });

    // Act
    surface.onTaskOpen?.('f412');

    // Assert
    should(visited).deepEqual(['/d/daemon-a/board/F412']);
  });

  test("should fall back to the host's Tasks destination when the machine has no card route", () => {
    // Arrange
    const visited: string[] = [];
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      onNavigate: to => visited.push(to),
      cardRoute: false,
      destinations: { openTasks: () => visited.push('tasks') },
    });

    // Act
    surface.onTaskOpen?.('f412');

    // Assert
    should(visited).deepEqual(['tasks']);
  });

  // Attention is deliberately NOT a side-pane tab (handover #35); its home is
  // #17's focused action modal. The opener therefore comes from the host that
  // OWNS that modal, and a host without one must not manufacture a dead link.
  test('should offer no Attention opener when the host owns no action modal', () => {
    // Arrange — a ledger, but nowhere to open it.
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      agendaIds: ['A3' as AgendaId],
    });
    const before = readSidePaneTabsState(scope).active;

    // Act
    surface.onAgendaOpen?.('A3' as AgendaId);

    // Assert — proved, and still prose, because `hasOpener` reads the omission.
    should(surface.agendaReferenceResolver?.('A3' as AgendaId)).be.true();
    should(surface.onAgendaOpen).be.undefined();
    should(readSidePaneTabsState(scope).active).equal(before);
  });

  test('should never open Attention as a side-pane tab even when the host supplies a modal', () => {
    // Arrange
    const opened: [AgendaId, HTMLElement | null | undefined][] = [];
    const surface = sessionReferenceSurface({
      connection,
      fetcher: browserFetch,
      scope,
      agendaIds: ['A3' as AgendaId],
      onAgendaOpen: (id, opener) => opened.push([id, opener]),
    });
    const before = readSidePaneTabsState(scope).active;

    // Act
    surface.onAgendaOpen?.('A3' as AgendaId, null);

    // Assert — the request reaches the modal, and the bento box stays untouched.
    should(opened).deepEqual([['A3' as AgendaId, null]]);
    should(readSidePaneTabsState(scope).active).equal(before);
  });

  test('should refuse an opener that has no ledger to prove the id against', () => {
    // Arrange — an opener alone would link an id nothing proved.
    const opened: AgendaId[] = [];

    // Act
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      onAgendaOpen: id => opened.push(id),
    });

    // Assert
    should(surface.agendaReferenceResolver).be.undefined();
    should(surface.onAgendaOpen).be.undefined();
    should(opened).be.empty();
  });

  test('should open a proved terminal surface as that exact terminal instance', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope, fetcher: browserFetch });

    // Act
    surface.onSurfaceOpen?.({
      kind: 'surface',
      surface: 'terminal',
      key: '0a1b2c3d4e5f',
      daemonId,
      sessionId: scope.sessionId,
    });

    // Assert
    should(readSidePaneTabsState(scope).active).equal(sidePaneInstanceTabId('terminal', '0a1b2c3d4e5f'));
  });

  test('should open a terminal a reference names by its name as that terminal’s own tab', () => {
    // Arrange — `%terminal:dev`, the handle a person and an agent share, over a listing that holds it.
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      terminals: {
        sessionId: scope.sessionId,
        terminals: [
          {
            id: '0a1b2c3d4e5f',
            name: 'dev',
            sessionId: scope.sessionId,
            title: 'Terminal 1',
            state: 'running',
            cols: 80,
            rows: 24,
            viewers: 1,
            createdAt: '2026-08-01T10:00:00.000Z',
            lastActivityAt: '2026-08-01T10:05:00.000Z',
          },
        ],
        limits: { perSession: 6, global: 24, runningGlobal: 1, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
      },
    });

    // Act
    surface.onSurfaceOpen?.({ kind: 'surface', surface: 'terminal', key: 'dev', daemonId, sessionId: scope.sessionId });

    // Assert
    should(readSidePaneTabsState(scope).active).equal(sidePaneInstanceTabId('terminal', '0a1b2c3d4e5f'));
  });

  test('should carry navigation through only when the host offered it', () => {
    // Arrange
    const visited: string[] = [];

    // Act
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      onNavigate: to => visited.push(to),
    });
    surface.onNavigate?.('/d/daemon-a/session/session-9');

    // Assert
    should(visited).deepEqual(['/d/daemon-a/session/session-9']);
  });

  test('should open every reference in the host destinations when the page offers them', () => {
    // Arrange
    const opened: string[] = [];
    const surface = sessionReferenceSurface({
      connection,
      scope,
      fetcher: browserFetch,
      destinations: {
        openFile: (path, selection) => opened.push(`file:${path}:${selection?.line ?? '-'}`),
        openSurface: reference => opened.push(`${reference.surface}:${reference.key}`),
        openTasks: () => opened.push('tasks'),
        openSkills: () => opened.push('skills'),
      },
    });

    // Act
    surface.onCodeReferenceOpen?.({ path: 'src/a.ts', line: 3 });
    surface.onSurfaceOpen?.({ kind: 'surface', surface: 'browser', key: 'b1', daemonId, sessionId: scope.sessionId });
    surface.onTaskOpen?.('F1');
    surface.onSkillOpen?.('floop');

    // Assert — the workspace took every one, and the side pane opened nothing.
    should(opened).deepEqual(['file:src/a.ts:3', 'browser:b1', 'tasks', 'skills']);
    should(readSidePaneTabsState(scope).active).equal(null);
  });
});

describe('sessionReferenceSurface workspace media', () => {
  test('should read a media block’s workspace file through the given fetcher for the given session', async () => {
    // Arrange
    const requested: string[] = [];
    const surface = sessionReferenceSurface({
      connection,
      scope,
      cwd: '/repo',
      fetcher: async url => {
        requested.push(String(url));
        return new Response(JSON.stringify({ base64: 'AAEC', path: 'assets/a.png', size: 3 }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    // Act
    const read = await surface.readWorkspaceMedia?.('/repo/assets/a.png', new AbortController().signal);

    // Assert — the session's own preview route, for the session-relative path.
    should(requested).deepEqual([
      'https://daemon.invalid/v1/sessions/session-1/fs/file?format=base64&path=assets%2Fa.png',
    ]);
    should(read?.ok === true ? [...read.bytes] : null).deepEqual([0, 1, 2]);
  });
});
