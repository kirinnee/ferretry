import { describe, it } from 'bun:test';
import should from 'should';
import type { ProcessObservation } from '../../../src/lib/migrate/inflight-report.ts';
import {
  MigrationPreflight,
  type MigrateTargetView,
  type PaneSnapshotPort,
} from '../../../src/lib/migrate/preflight-service.ts';
import type { ProcessInventoryPort } from '../../../src/lib/migrate/process-inventory-port.ts';

class StubInventory implements ProcessInventoryPort {
  readonly sessions: string[] = [];

  constructor(private readonly observation: ProcessObservation) {}

  async collect(tmuxSession: string): Promise<ProcessObservation> {
    this.sessions.push(tmuxSession);
    return this.observation;
  }
}

class StubPanes implements PaneSnapshotPort {
  readonly sessions: string[] = [];

  constructor(private readonly text: string | Error) {}

  async visible(tmuxSession: string): Promise<string> {
    this.sessions.push(tmuxSession);
    if (this.text instanceof Error) throw this.text;
    return this.text;
  }
}

const view = (overrides: Partial<MigrateTargetView> = {}): MigrateTargetView => ({
  sessionId: 'session-1',
  harness: 'claude',
  tmuxSession: 'fy-session-1',
  status: 'waiting',
  turn: 3,
  openTools: [],
  ...overrides,
});

const chatTail = [
  {
    type: 'tool.use',
    timestamp: '2026-07-31T09:00:00.000Z',
    data: { toolUseId: 'tool-1', name: 'Bash', input: { command: 'git push origin main' } },
  },
];

describe('MigrationPreflight', () => {
  it('should join every signal into one report keyed on the target pane', async () => {
    // Arrange
    const inventory = new StubInventory({
      kind: 'observed',
      processes: [{ pid: 900, argv: 'vitest run', verdict: 're_armable' }],
    });
    const panes = new StubPanes('');
    const preflight = new MigrationPreflight(inventory, panes);

    // Act
    const report = await preflight.inspect(view({ status: 'tool_running', openTools: ['tool-1'] }), chatTail);

    // Assert
    should(inventory.sessions).deepEqual(['fy-session-1']);
    should(panes.sessions).deepEqual([]);
    should(report.openTools).deepEqual([
      {
        toolUseId: 'tool-1',
        name: 'Bash',
        summary: 'git push origin main',
        startedAt: '2026-07-31T09:00:00.000Z',
        verdict: 'destructive_to_interrupt',
      },
    ]);
    should(report.processes).have.length(1);
    should(report.worstVerdict).equal('destructive_to_interrupt');
    should(preflight.gate(report)).deepEqual({
      proceed: false,
      forced: false,
      reason: 'refused: in-flight work is destructive_to_interrupt',
    });
    should(preflight.gate(report, { force: true }).forced).be.true();
  });

  it('should count the codex pane footer only for a codex session', async () => {
    // Arrange
    const panes = new StubPanes('Esc to interrupt · 2 background terminals running');
    const inventory = new StubInventory({ kind: 'observed', processes: [] });

    // Act
    const codex = await new MigrationPreflight(inventory, panes).inspect(view({ harness: 'codex' }));
    const claude = await new MigrationPreflight(inventory, new StubPanes('2 background terminals running')).inspect(
      view(),
    );

    // Assert
    should(panes.sessions).deepEqual(['fy-session-1']);
    should(codex.codexBackgroundTerminals).equal(2);
    should(codex.worstVerdict).equal('unknown');
    should(claude.codexBackgroundTerminals).equal(0);
    should(claude.empty).be.true();
  });

  it('should turn an unreadable codex pane into a blind spot rather than a zero count', async () => {
    // Arrange
    const preflight = new MigrationPreflight(
      new StubInventory({ kind: 'observed', processes: [] }),
      new StubPanes(new Error('no server running')),
    );

    // Act
    const report = await preflight.inspect(view({ harness: 'codex' }));

    // Assert
    should(report.blindSpots).deepEqual(['the codex pane footer could not be read: no server running']);
    should(report.empty).be.false();
    should(preflight.gate(report)).deepEqual({
      proceed: false,
      forced: false,
      reason: 'refused: the codex pane footer could not be read: no server running',
    });
  });

  it('should refuse a session whose pane could not be walked at all', async () => {
    // Arrange
    const preflight = new MigrationPreflight(
      new StubInventory({ kind: 'unobservable', reason: 'the pane pid could not be resolved: no server running' }),
      new StubPanes(''),
    );

    // Act
    const report = await preflight.inspect(view());

    // Assert
    should(report.blindSpots).deepEqual(['the pane pid could not be resolved: no server running']);
    should(preflight.gate(report).proceed).be.false();
  });

  it('should expose the report, forensic record, outcome and handoff it exists to produce', async () => {
    // Arrange
    const preflight = new MigrationPreflight(
      new StubInventory({
        kind: 'observed',
        processes: [{ pid: 900, argv: 'rm -rf work', verdict: 'destructive_to_interrupt' }],
      }),
      new StubPanes(''),
    );
    const report = await preflight.inspect(view());

    // Act
    const summary = preflight.summarize(report);
    const document = preflight.document(report, {
      sessionId: 'session-1',
      targetAgent: 'codex-terra',
      forced: true,
      at: '2026-07-31T09:00:00.000Z',
    });
    const settled = preflight.settle({
      ok: true,
      from: 'claude-loge',
      targetAgent: 'codex-terra',
      at: '2026-07-31T09:05:00.000Z',
    });

    // Assert
    should(summary).containEql('  proc  [DESTRUCTIVE] pid 900 (?): rm -rf work');
    should(document).containEql('- **FORCED past a destructive/unknown refusal');
    should(document).containEql('| DESTRUCTIVE | 900 | ? | ? | `rm -rf work` |');
    should(settled).containEql('## Outcome — MIGRATION SUCCEEDED');
    should(preflight.handoff('/state/report.md')).containEql('Read /state/report.md');
  });
});
