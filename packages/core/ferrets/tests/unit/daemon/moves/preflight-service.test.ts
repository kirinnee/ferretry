import { describe, it } from 'bun:test';
import should from 'should';
import type { ProcessObservation } from '../../../src/lib/migrate/inflight-report.ts';
import {
  type MigrateTargetView,
  MigrationPreflight,
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

  /** `undefined` is a pane the adapter CONFIRMED is gone; an `Error` is one it could not read. */
  constructor(private readonly text: string | Error | undefined) {}

  async visible(tmuxSession: string): Promise<string | undefined> {
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
      reason: 'refused: The agent is in the middle of a Bash call that changes things — git push origin main',
    });
    should(preflight.gate(report, { force: true }).forced).be.true();
    should(preflight.describe(report)).match({
      status: 'tool_running',
      blockedBy: 'destructive',
      items: [
        { kind: 'tool', blocks: true, detail: 'git push origin main' },
        { kind: 'process', blocks: false },
      ],
    });
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
      reason:
        'refused: Ferretry couldn’t check what the agent is running — the codex pane footer could not be read: no server running',
    });
  });

  it('should treat a codex pane that is confirmed gone as no background terminals at all', async () => {
    // A stopped session has no footer to read, which is not the same as a footer nobody could read.
    // Blind-spotting it would refuse the migration of every dead codex session — the exact case an
    // operator moves a session for — on evidence that could not exist.
    // Arrange
    const preflight = new MigrationPreflight(
      new StubInventory({ kind: 'observed', processes: [] }),
      new StubPanes(undefined),
    );

    // Act
    const report = await preflight.inspect(view({ harness: 'codex', status: 'stopped' }));

    // Assert
    should(report.blindSpots).be.empty();
    should(report.codexBackgroundTerminals).equal(0);
    should(report.empty).be.true();
    should(preflight.gate(report)).deepEqual({ proceed: true, forced: false, reason: 'no in-flight work' });
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
    should(preflight.handoff(report, '/state/report.md', 'interactive')).be.undefined();
    const busy = await preflight.inspect(view({ status: 'tool_running' }));
    should(preflight.handoff(busy, '/state/report.md', 'interactive')).containEql('read /state/report.md');
  });
});

describe('the agent’s own jobs a refusal names', () => {
  it('should hand back only the blocking processes the agent started from its tool shell', async () => {
    // Arrange
    const preflight = new MigrationPreflight(
      new StubInventory({
        kind: 'observed',
        processes: [
          {
            pid: 40,
            argv: '/usr/bin/zsh -c eval ./merge.sh',
            startedSecondsAgo: 240,
            verdict: 'unknown',
            toolShell: 40,
          },
          { pid: 41, argv: 'bash ./merge.sh', verdict: 'unknown', toolShell: 40 },
          { pid: 42, argv: 'sleep 5', startedSecondsAgo: 5, verdict: 'safe_to_kill', toolShell: 40 },
          { pid: 43, argv: 'some-vendor-tool --watch', startedSecondsAgo: 60, verdict: 'unknown' },
        ],
      }),
      new StubPanes(''),
    );

    // Act
    const jobs = preflight.agentJobs(await preflight.inspect(view()));

    // Assert — the safe one and the one the agent did not start from its shell are not asked about.
    should(jobs).deepEqual([
      { pid: 40, command: '/usr/bin/zsh -c eval ./merge.sh', age: '4m' },
      { pid: 41, command: 'bash ./merge.sh' },
    ]);
  });
});
