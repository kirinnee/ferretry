import { describe, it } from 'bun:test';
import should from 'should';
import { assembleInflightReport, type InflightReport } from '../../../src/lib/migrate/inflight-report.ts';
import { renderInflightCli, renderInflightReport } from '../../../src/lib/migrate/report-render.ts';

const meta = {
  sessionId: 'session-1',
  targetAgent: 'claude-loge',
  forced: false,
  at: '2026-07-31T09:00:00.000Z',
};

const busy = (): InflightReport =>
  assembleInflightReport({
    status: 'tool_running',
    turn: 12,
    openTools: [
      {
        toolUseId: 'tool-1',
        name: 'Bash',
        summary: 'git push  origin\nmain',
        verdict: 'destructive_to_interrupt',
      },
    ],
    processes: {
      kind: 'observed',
      processes: [
        { pid: 900, argv: 'rg TODO | wc -l', startedSecondsAgo: 240, cwd: '/work/repo', verdict: 'safe_to_kill' },
        { pid: 901, argv: 'vitest run', verdict: 're_armable' },
      ],
    },
    codexBackgroundTerminals: 2,
  });

const idle = (): InflightReport =>
  assembleInflightReport({
    status: 'waiting',
    turn: 1,
    openTools: [],
    processes: { kind: 'observed', processes: [] },
    codexBackgroundTerminals: 0,
  });

const unreadable = (): InflightReport =>
  assembleInflightReport({
    status: 'waiting',
    turn: 2,
    openTools: [],
    processes: { kind: 'unobservable', reason: 'ps exited 1: cannot | allocate memory' },
    codexBackgroundTerminals: 0,
  });

describe('renderInflightCli', () => {
  it('should list every observed signal on its own line', () => {
    // Act
    const actual = renderInflightCli(busy());

    // Assert
    should(actual.split('\n')).deepEqual([
      'in-flight inventory — status tool_running, turn 12, worst: DESTRUCTIVE',
      '  tool  [DESTRUCTIVE] Bash: git push origin main',
      '  proc  [safe] pid 900 (4m): rg TODO | wc -l',
      '  proc  [re-armable] pid 901 (?): vitest run',
      '  codex 2 background terminal(s) [UNKNOWN — no argv, unaccountable]',
    ]);
  });

  it('should say plainly when nothing was observed', () => {
    // Act
    const actual = renderInflightCli(idle());

    // Assert
    should(actual.split('\n')).deepEqual([
      'in-flight inventory — status waiting, turn 1, worst: safe',
      '  (no open tools or descendant processes observed)',
    ]);
  });

  it('should show a blind spot instead of claiming nothing was observed', () => {
    // Act
    const actual = renderInflightCli(unreadable());

    // Assert
    should(actual.split('\n')).deepEqual([
      'in-flight inventory — status waiting, turn 2, worst: UNKNOWN',
      '  blind [UNKNOWN] ps exited 1: cannot | allocate memory',
    ]);
  });
});

describe('renderInflightReport', () => {
  it('should record what was running without claiming the migration happened', () => {
    // Act
    const actual = renderInflightReport(busy(), { ...meta, targetModel: 'opus' });

    // Assert
    should(actual).startWith('# Migration in-flight report\n');
    should(actual).containEql('- Session: `session-1`');
    should(actual).containEql('onto: `claude-loge` (model `opus`) — **PENDING');
    should(actual).containEql('- Requested at: 2026-07-31T09:00:00.000Z');
    should(actual).containEql('- Status at migrate: tool_running (turn 12)');
    should(actual).containEql('- Worst verdict: **DESTRUCTIVE**');
    should(actual).not.containEql('FORCED past');
    should(actual).containEql('| DESTRUCTIVE | Bash | `git push origin main` |');
    should(actual).containEql('| safe | 900 | 4m | `/work/repo` | `rg TODO \\| wc -l` |');
    should(actual).containEql('| re-armable | 901 | ? | ? | `vitest run` |');
    should(actual).containEql('### Codex background terminals: 2');
    should(actual).endWith('before acting.\n\n');
  });

  it('should announce a forced migration as the destruction it is', () => {
    // Act
    const actual = renderInflightReport(busy(), { ...meta, forced: true });

    // Assert
    should(actual).containEql('onto: `claude-loge` — **PENDING');
    should(actual).containEql('- **FORCED past a destructive/unknown refusal (`--force-inflight`).**');
  });

  it('should state that nothing was observed when nothing was', () => {
    // Act
    const actual = renderInflightReport(idle(), meta);

    // Assert
    should(actual).containEql('_No open tools or descendant processes were observed at migrate time._');
    should(actual).not.containEql('### Open harness tools');
    should(actual).not.containEql('### Descendant processes');
    should(actual).not.containEql('### Codex background terminals');
    should(actual).not.containEql('### Blind spots');
  });

  it('should name every blind spot so a refusal can be acted on', () => {
    // Act
    const actual = renderInflightReport(unreadable(), meta);

    // Assert
    should(actual).containEql('### Blind spots');
    should(actual).containEql('- ps exited 1: cannot \\| allocate memory');
    should(actual).not.containEql('_No open tools or descendant processes were observed at migrate time._');
  });
});
