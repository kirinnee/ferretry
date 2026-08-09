import { beforeEach, describe, test } from 'bun:test';
import type { AttentionId, SessionView } from '@ferretry/protocol';
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
      skills: ['summary'],
    });

    // Assert
    should(surface.taskReferenceResolver?.('f12')).be.true();
    should(surface.taskReferenceResolver?.('F99')).be.false();
    should(surface.attentionReferenceResolver?.('A3' as AttentionId)).be.true();
    should(surface.attentionReferenceResolver?.('A4' as AttentionId)).be.false();
    should(surface.skillReferenceResolver?.('summary')).be.true();
    should(surface.skillReferenceResolver?.('missing')).be.false();
  });

  test('should not turn a catalog name the grammar refuses into a different name it accepts', () => {
    // Arrange — the catalog accepts any nonempty trimmed name; the reference
    // grammar accepts lowercase ones only. `Floop` therefore has NO valid
    // reference at all, and `/floop` is a different identity that this session
    // may well not have.
    const surface = sessionReferenceSurface({ connection, scope, skills: ['Floop', 'run'] });

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

  test('should send task and skill clicks to their own pane', () => {
    // Arrange
    const surface = sessionReferenceSurface({ connection, scope });

    // Act
    surface.onTaskOpen?.('F12');
    const afterTask = readSidePaneTabsState(scope).active;
    surface.onSkillOpen?.('summary');

    // Assert
    should([afterTask, readSidePaneTabsState(scope).active]).deepEqual(['tasks', 'skills']);
  });

  // Attention is deliberately NOT a side-pane tab (handover #35); its home is
  // #17's focused action modal. The opener therefore comes from the host that
  // OWNS that modal, and a host without one must not manufacture a dead link.
  test('should offer no Attention opener when the host owns no action modal', () => {
    // Arrange — a ledger, but nowhere to open it.
    const surface = sessionReferenceSurface({ connection, scope, attentionIds: ['A3' as AttentionId] });
    const before = readSidePaneTabsState(scope).active;

    // Act
    surface.onAttentionOpen?.('A3' as AttentionId);

    // Assert — proved, and still prose, because `hasOpener` reads the omission.
    should(surface.attentionReferenceResolver?.('A3' as AttentionId)).be.true();
    should(surface.onAttentionOpen).be.undefined();
    should(readSidePaneTabsState(scope).active).equal(before);
  });

  test('should never open Attention as a side-pane tab even when the host supplies a modal', () => {
    // Arrange
    const opened: [AttentionId, HTMLElement | null | undefined][] = [];
    const surface = sessionReferenceSurface({
      connection,
      scope,
      attentionIds: ['A3' as AttentionId],
      onAttentionOpen: (id, opener) => opened.push([id, opener]),
    });
    const before = readSidePaneTabsState(scope).active;

    // Act
    surface.onAttentionOpen?.('A3' as AttentionId, null);

    // Assert — the request reaches the modal, and the bento box stays untouched.
    should(opened).deepEqual([['A3' as AttentionId, null]]);
    should(readSidePaneTabsState(scope).active).equal(before);
  });

  test('should refuse an opener that has no ledger to prove the id against', () => {
    // Arrange — an opener alone would link an id nothing proved.
    const opened: AttentionId[] = [];

    // Act
    const surface = sessionReferenceSurface({ connection, scope, onAttentionOpen: id => opened.push(id) });

    // Assert
    should(surface.attentionReferenceResolver).be.undefined();
    should(surface.onAttentionOpen).be.undefined();
    should(opened).be.empty();
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
