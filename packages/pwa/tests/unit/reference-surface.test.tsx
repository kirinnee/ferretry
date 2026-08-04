import type { AttentionId, SessionView } from '@ferretry/protocol';
import { beforeEach, describe, test } from 'bun:test';
import should from 'should';
import {
  ReferenceSurfaceProvider,
  sessionReferenceSurface,
  useReferenceSurface,
} from '../../src/components/reference-surface.tsx';
import type { DaemonConnection, DaemonId } from '../../src/lib/daemon-connection.ts';
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
    const bare = sessionReferenceSurface({ connection, scope });

    // Assert — an unread fleet, no board, no ledger and no catalog each mean
    // "cannot prove", which is not the same as "nothing matches".
    should(bare.agentReferenceResolver).be.undefined();
    should(bare.taskReferenceResolver).be.undefined();
    should(bare.attentionReferenceResolver).be.undefined();
    should(bare.skillReferenceResolver).be.undefined();
    should(bare.onNavigate).be.undefined();
    should(bare.surfaceReferenceResolver).be.a.Function();
  });

  test('should prove a callsign against this daemon only, and stamp its daemon on', () => {
    // Arrange
    const surface = sessionReferenceSurface({
      connection,
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
      scope,
      tasks: [{ id: 'F12' }],
      attentionIds: ['A3' as AttentionId],
      skills: ['Summary'],
    });

    // Assert
    should(surface.taskReferenceResolver?.('f12')).be.true();
    should(surface.taskReferenceResolver?.('F99')).be.false();
    should(surface.attentionReferenceResolver?.('A3' as AttentionId)).be.true();
    should(surface.attentionReferenceResolver?.('A4' as AttentionId)).be.false();
    should(surface.skillReferenceResolver?.('summary')).be.true();
    should(surface.skillReferenceResolver?.('missing')).be.false();
  });

  test('should ask the session filesystem for nothing when there is no candidate', async () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope, cwd: '/repo' });

    // Act — no candidates means no directory read at all, so this cannot reach
    // the daemon.
    const resolved = await surface.resolveFilePaths?.([], new AbortController().signal);

    // Assert
    should(resolved).deepEqual(new Map());
  });

  test('should open a file reference as a file instance tab carrying its lines', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope });

    // Act
    surface.onCodeReferenceOpen?.({ path: 'src/api.ts', line: 12, endLine: 20 });

    // Assert
    const id = sidePaneInstanceTabId('file', 'src/api.ts');
    should(readSidePaneTabsState(scope).active).equal(id);
    should(readSidePaneTabsState(scope).instances[id]?.selection).deepEqual({ line: 12, endLine: 20 });
  });

  test('should open a bare file reference without claiming a line', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope });

    // Act
    surface.onCodeReferenceOpen?.({ path: 'README.md' });

    // Assert
    const id = sidePaneInstanceTabId('file', 'README.md');
    should(readSidePaneTabsState(scope).instances[id]?.selection).be.undefined();
  });

  test('should open a file reference with only a start line', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope });

    // Act
    surface.onCodeReferenceOpen?.({ path: 'src/api.ts', line: 4 });

    // Assert
    const id = sidePaneInstanceTabId('file', 'src/api.ts');
    should(readSidePaneTabsState(scope).instances[id]?.selection).deepEqual({ line: 4 });
  });

  test('should send task, attention and skill clicks to their own pane', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope });

    // Act
    surface.onTaskOpen?.('F12');
    const afterTask = readSidePaneTabsState(scope).active;
    surface.onAttentionOpen?.('A3' as AttentionId);
    const afterAttention = readSidePaneTabsState(scope).active;
    surface.onSkillOpen?.('summary');

    // Assert
    should([afterTask, afterAttention, readSidePaneTabsState(scope).active]).deepEqual([
      'tasks',
      'attention',
      'skills',
    ]);
  });

  test('should open a proved terminal surface as that exact terminal instance', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope });

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

  test('should carry navigation through only when the host offered it', () => {
    // Arrange
    const visited: string[] = [];

    // Act
    const surface = sessionReferenceSurface({ connection, scope, onNavigate: to => visited.push(to) });
    surface.onNavigate?.('/d/daemon-a/session/session-9');

    // Assert
    should(visited).deepEqual(['/d/daemon-a/session/session-9']);
  });
});
