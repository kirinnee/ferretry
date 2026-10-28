import { describe, it } from 'bun:test';
import should from 'should';
import { identifyKnownProcesses } from '../../../src/lib/migrate/harness-provenance.ts';
import type { ProcRow } from '../../../src/lib/migrate/process-table.ts';
import { inventoryProcesses } from '../../../src/lib/migrate/process-table.ts';
import { livenessSampleOf, lookAtPaneProcesses } from '../../../src/lib/session/observer/liveness.ts';
import {
  defaultWardenConfig,
  detectAnomalies,
  foldLivenessSample,
  type LivenessTrack,
  leftoverBrowserCandidates,
  type WardenSessionView,
  wardenDetectOptions,
  withLivenessLedger,
} from '../../../src/lib/warden/index.ts';
import { REPORT_SHAPES, type ReportCategory, type ReportShape } from '../../fixtures/warden/report-shapes.ts';

/**
 * A replay of the 39 investigations one host paid for in late October 2026, through the REAL pure
 * pipeline: each report's situation becomes a pane process tree and twenty-five minutes of liveness
 * looks, which go through the process classifier, the liveness fold and the detector exactly as the
 * daemon runs them.
 */

const PANE = 1_000;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const TICK_MS = 30_000;
const LOOKED_FOR_MS = 25 * 60_000;

const row = (pid: number, ppid: number, argv: string, startedSecondsAgo = 3_600): ProcRow => ({
  pid,
  ppid,
  startedSecondsAgo,
  argv,
});

/** Under every pane, for as long as the session lives. */
const TOOLS_SERVER = row(1_001, PANE, 'fy mcp serve', 200_000);

interface Situation {
  readonly turnState: 'working' | 'your-turn';
  readonly rows: readonly ProcRow[];
  readonly listening?: readonly number[];
  /** The transcript and the screen were moving: the ferret was doing work. */
  readonly moving: boolean;
  readonly monitored?: boolean;
}

const SITUATIONS: Readonly<Record<ReportCategory, Situation>> = {
  'tools-server': { turnState: 'your-turn', rows: [TOOLS_SERVER], moving: false },
  idle: { turnState: 'your-turn', rows: [TOOLS_SERVER], moving: false },
  // The blamed process was not under this pane — the walk starts at the pane — so only its own helper is.
  'other-session': { turnState: 'your-turn', rows: [TOOLS_SERVER], moving: false },
  'tmux-reader': { turnState: 'your-turn', rows: [TOOLS_SERVER], moving: false },
  'leftover-browser': {
    turnState: 'your-turn',
    rows: [
      TOOLS_SERVER,
      row(1_100, PANE, "/usr/bin/zsh -c source snapshot.sh && eval 'chromium --headless --remote-debugging-port=9333'"),
      row(1_101, 1_100, '/usr/lib/chromium/chromium --headless --remote-debugging-port=9333'),
      row(1_102, 1_101, '/usr/lib/chromium/chromium --type=renderer'),
    ],
    listening: [1_101],
    moving: false,
  },
  'dev-server': {
    turnState: 'your-turn',
    rows: [
      TOOLS_SERVER,
      row(1_200, PANE, "/usr/bin/zsh -c source snapshot.sh && eval 'bun board/server.ts'"),
      row(1_201, 1_200, 'bun board/server.ts'),
    ],
    listening: [1_201],
    moving: false,
  },
  'dev-server-busy': {
    turnState: 'working',
    rows: [
      TOOLS_SERVER,
      row(1_200, PANE, "/usr/bin/zsh -c source snapshot.sh && eval 'bun board/server.ts'"),
      row(1_201, 1_200, 'bun board/server.ts'),
      row(1_300, PANE, "/usr/bin/zsh -c source snapshot.sh && eval 'bun test'", 60),
      row(1_301, 1_300, 'bun test', 60),
    ],
    listening: [1_201],
    moving: true,
  },
  'ci-watch': {
    turnState: 'working',
    rows: [
      TOOLS_SERVER,
      row(1_400, PANE, "/usr/bin/zsh -c source snapshot.sh && eval 'gh pr checks 42 --watch'", 960),
      row(1_401, 1_400, 'gh pr checks 42 --watch', 960),
    ],
    moving: true,
  },
  'ci-poll-loop': {
    turnState: 'your-turn',
    rows: [
      TOOLS_SERVER,
      row(
        1_500,
        PANE,
        `/usr/bin/zsh -c source snapshot.sh && eval 'until [ "$(gh pr checks 42 | grep -c pending)" = "0" ]; do sleep 40; done'`,
        7_200,
      ),
      row(1_501, 1_500, 'sleep 40', 10),
    ],
    moving: false,
  },
  'dead-monitor': { turnState: 'working', rows: [TOOLS_SERVER], moving: true, monitored: false },
};

/** The processes as the inventory hands them to the liveness look. */
function paneProcesses(situation: Situation) {
  const known = identifyKnownProcesses(situation.rows, { rootPid: PANE, binaryName: 'fy', configuredServers: [] });
  return inventoryProcesses(situation.rows, new Map(), known, new Set(situation.listening ?? []));
}

/** Twenty-five minutes of liveness looks, folded as the monitor folds them. */
function observe(situation: Situation, startMs: number): LivenessTrack | undefined {
  const processes = paneProcesses(situation);
  let track: LivenessTrack | undefined;
  for (let atMs = startMs, tick = 0; atMs <= NOW; atMs += TICK_MS, tick += 1) {
    const marker = situation.moving ? `step ${tick}` : 'steady';
    const screen = [
      `⏺ Working on the task — ${marker}`,
      '✻ Thinking… (3m 12s · ↓ 4.1k tokens · esc to interrupt)',
      '❯ ',
    ].join('\n');
    const look = { screen, transcript: `assistant: ${marker}`, ...lookAtPaneProcesses(processes) };
    track = foldLivenessSample(
      track,
      livenessSampleOf(look, text => `digest(${text})`),
      7,
      atMs,
    );
  }
  return track;
}

/** One report's ferret, as the sweep would see it at the end of the replay. */
function replay(shape: ReportShape): { readonly view: WardenSessionView; readonly anomalies: readonly string[] } {
  const situation = SITUATIONS[shape.category];
  const track = observe(situation, NOW - LOOKED_FOR_MS);
  const view: WardenSessionView = {
    config: { id: shape.ferret, mode: 'auto', teammate: shape.ferret, intervalSeconds: 30 },
    state: withLivenessLedger(
      {
        status: 'running',
        turnState: situation.turnState,
        turn: 7,
        startedAt: new Date(NOW - 86_400_000).toISOString(),
        lastActivityAt: new Date(NOW - LOOKED_FOR_MS).toISOString(),
      },
      track?.ledger,
    ),
    hasLiveMonitor: situation.monitored ?? true,
    ...(track?.leftoverBrowserSince === undefined ? {} : { leftoverBrowserSince: track.leftoverBrowserSince }),
  };
  const anomalies = detectAnomalies([view], NOW, wardenDetectOptions(defaultWardenConfig)).anomalies.map(
    anomaly => anomaly.kind,
  );
  return { view, anomalies };
}

const replayed = REPORT_SHAPES.map(shape => ({ shape, ...replay(shape) }));
const escalated = replayed.filter(entry => entry.anomalies.length > 0);

describe('replaying the 39 paid investigations of 26–28 October', () => {
  it('should cover the whole ledger: 38 stuck-subprocess flags and one lost monitor', () => {
    // Act / Assert
    should(REPORT_SHAPES).have.length(39);
    should(REPORT_SHAPES.filter(shape => shape.kind === 'sus_subprocess')).have.length(38);
  });

  it('should reproduce why the OLD rule fired on every one: each pane had a child process', () => {
    // Act / Assert — the old rule read "any child process" as "a subprocess is running".
    for (const shape of REPORT_SHAPES) should(SITUATIONS[shape.category].rows.length).be.above(0);
  });

  it('should no longer escalate at least 90% of them', () => {
    // Act
    const quiet = replayed.length - escalated.length;

    // Assert
    should(quiet / replayed.length).be.aboveOrEqual(0.9);
    should(escalated).have.length(2);
  });

  it('should still escalate the CI poll loop that could never finish', () => {
    // Act
    const real = replayed.find(entry => entry.shape.real === true);

    // Assert
    should(real?.anomalies).deepEqual(['sus_subprocess']);
  });

  it('should still raise the lost monitor, which these changes do not touch', () => {
    // Act / Assert
    should(escalated.map(entry => entry.shape.category).toSorted()).deepEqual(['ci-poll-loop', 'dead-monitor']);
    should(replayed.find(entry => entry.shape.kind === 'dead_monitor')?.anomalies).deepEqual(['dead_monitor']);
  });

  it.each([
    'tools-server',
    'idle',
    'other-session',
    'tmux-reader',
    'leftover-browser',
    'dev-server',
    'dev-server-busy',
    'ci-watch',
  ] as const)('should raise nothing for a %s case', category => {
    // Act
    const raised = replayed.filter(entry => entry.shape.category === category).flatMap(entry => entry.anomalies);

    // Assert
    should(raised).deepEqual([]);
  });

  it('should close every leftover browser by rule instead, with no investigation', () => {
    // Act
    const closable = replayed.filter(
      entry => leftoverBrowserCandidates([entry.view], NOW, { tickSeconds: 30 }).length > 0,
    );

    // Assert
    should(closable.map(entry => entry.shape.category)).deepEqual(Array(5).fill('leftover-browser'));
  });
});
