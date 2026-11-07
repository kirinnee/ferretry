import { describe, it } from 'bun:test';
import should from 'should';
import { SessionAttachError } from '../../../../daemon/lib/session/attach/service.ts';
import { backgroundTerminalCount, livenessSampleOf } from '../../../../daemon/lib/session/liveness.ts';
import { PaneLook, type PaneLookPorts } from '../../../../daemon/lib/session/pane-look.ts';
import type { ProcessDetailRow, ProcessTreeRead } from '../../../../daemon/lib/session/processes/ports.ts';
import {
  claudeWrapper,
  HARNESS_PID,
  HARNESS_ROW,
  MCP_PID,
  MCP_ROW,
  NOW,
  PANE_PID,
  rowOf,
} from './processes/support.ts';

/** A fake process tree under one proved pane (`%7`, pid 500), with the harness and its tools server. */
function subject(
  options: {
    readonly rows?: readonly ProcessDetailRow[];
    /** The rows of the n-th walk (1-based), when they change between looks; `rows` otherwise. */
    readonly rowsAt?: (walk: number) => readonly ProcessDetailRow[];
    /** What `startOf` answers for a pid now; absent: the start of that pid in the latest walk, else gone. */
    readonly startNow?: (pid: number) => number | undefined;
    readonly screen?: string;
    readonly refusal?: Error;
    readonly absent?: boolean;
    readonly tree?: ProcessTreeRead;
  } = {},
) {
  const asked = { proofs: [] as string[], walked: [] as number[], screens: [] as string[], absent: [] as string[] };
  let latest: readonly ProcessDetailRow[] = [];
  const ports: PaneLookPorts = {
    panes: {
      resolve: async ferret => {
        asked.proofs.push(ferret);
        if (options.refusal !== undefined) throw options.refusal;
        return {
          socketPath: '/tmp/tmux.sock',
          tmuxSession: `fy-${ferret}`,
          paneId: '%7',
          pid: PANE_PID,
          processStartTicks: 9,
        };
      },
    },
    tree: {
      tree: async rootPid => {
        asked.walked.push(rootPid);
        latest = options.rowsAt?.(asked.walked.length) ?? options.rows ?? [HARNESS_ROW, MCP_ROW];
        return options.tree ?? { kind: 'read', rows: latest };
      },
      listening: async () => new Set<number>(),
      startOf: async () => undefined,
    },
    provenance: {
      identify: async rows => {
        const known = new Map<number, { readonly kind: string }>();
        for (const row of rows) {
          if (row.pid === HARNESS_PID) known.set(row.pid, { kind: 'harness' });
          if (row.pid === MCP_PID) known.set(row.pid, { kind: 'ferretry-tools' });
        }
        return known;
      },
    },
    incarnation: {
      startOf: async pid => options.startNow?.(pid) ?? latest.find(row => row.pid === pid)?.start,
    },
    paneAbsent: async ferret => {
      asked.absent.push(ferret);
      return options.absent ?? false;
    },
    screen: async paneId => {
      asked.screens.push(paneId);
      return options.screen;
    },
    digest: text => `digest(${text.length})`,
    nowMs: () => NOW,
  };
  return { look: new PaneLook(ports), asked };
}

const SHELL = 600;
const command = rowOf({ pid: SHELL, ppid: HARNESS_PID, argv: claudeWrapper('bun test'), ageSeconds: 30 });
const commandChild = rowOf({ pid: 601, ppid: SHELL, argv: 'bun test', ageSeconds: 29 });
/** A Chrome the agent launched through a tool command, its own renderer under it, the command since gone. */
const browserShell = rowOf({
  pid: 700,
  ppid: HARNESS_PID,
  argv: claudeWrapper('google-chrome --headless'),
  ageSeconds: 900,
});
const browser = rowOf({ pid: 701, ppid: 700, argv: '/opt/google/chrome/chrome --headless', ageSeconds: 899 });
const renderer = rowOf({ pid: 702, ppid: 701, argv: '/opt/google/chrome/chrome --type=renderer', ageSeconds: 898 });
/** A Chrome the tools server drives: a helper's browser, never a leftover. */
const helperBrowser = rowOf({ pid: 800, ppid: MCP_PID, argv: '/opt/google/chrome/chrome --remote-debugging-pipe' });

describe('the liveness look at a ferret’s own pane (today’s InlineObserverHost.liveness)', () => {
  it('should digest the masked screen and carry it for its work counters, read from the PROVED pane only', async () => {
    // Arrange
    const { look, asked } = subject({ screen: '✢ Fixing… (5m 45s · ↓ 17.2k tokens)' });

    // Act
    const sample = await look.liveness('f1');

    // Assert
    should(asked.proofs).eql(['f1']);
    should(asked.screens).eql(['%7']);
    should(sample.pane).equal('✢ Fixing… (5m 45s · ↓ 17.2k tokens)');
    should(sample.paneHash).equal('digest(35)');
  });

  it('should say a tool command runs, keyed by the youngest one, when a shell the harness started is working', async () => {
    // Arrange
    const { look } = subject({ rows: [HARNESS_ROW, MCP_ROW, command, commandChild], screen: '' });

    // Act
    const sample = await look.liveness('f1');

    // Assert
    should(sample.subprocessAlive).equal(true);
    should(sample.subprocessKey).equal(`pid:${SHELL}`);
    should(sample.leftoverBrowser).be.undefined();
  });

  it('should not count the harness and its tools server as a subprocess (an idle ferret is not busy)', async () => {
    // Arrange
    const { look } = subject({ screen: '❯ ' });

    // Act
    const sample = await look.liveness('f1');

    // Assert
    should(sample.subprocessAlive).equal(false);
    should(sample.subprocessKey).be.undefined();
  });

  it('should report a browser the agent launched still running after its command ended', async () => {
    // Arrange
    const { look } = subject({ rows: [HARNESS_ROW, MCP_ROW, browserShell, browser, renderer], screen: '' });

    // Act
    const sample = await look.liveness('f1');

    // Assert
    should(sample.subprocessAlive).equal(false);
    should(sample.leftoverBrowser).equal(true);
  });

  it('should count a background terminal the harness reports in its footer as a live subprocess', async () => {
    // Arrange
    const { look } = subject({ screen: 'Working (3m)\n2 background terminals running' });

    // Act
    const sample = await look.liveness('f1');

    // Assert
    should(sample.subprocessAlive).equal(true);
    should(backgroundTerminalCount('1 background terminal running')).equal(1);
  });

  it('should leave out what could not be read: a pane it cannot prove is no evidence, and its screen is never read', async () => {
    // Arrange
    const { look, asked } = subject({
      refusal: new SessionAttachError('identity_mismatch', 'the live pane no longer matches its registration'),
      screen: 'not to be read',
    });

    // Act
    const sample = await look.liveness('f1');

    // Assert
    should(sample).eql({});
    should(asked.screens).eql([]);
  });

  it('should read a pane tmux confirms is gone as running nothing, with no screen', async () => {
    // Arrange
    const { look, asked } = subject({
      refusal: new SessionAttachError('pane_unavailable', 'the registered pane is not live'),
      absent: true,
    });

    // Act
    const sample = await look.liveness('f1');

    // Assert
    should(asked.absent).eql(['f1']);
    should(sample).eql({ subprocessAlive: false });
  });

  it('should keep the process look when the screen read is refused (a hold), and no screen digest', async () => {
    // Arrange
    const { look } = subject({ rows: [HARNESS_ROW, MCP_ROW, command] });

    // Act
    const sample = await look.liveness('f1');

    // Assert
    should(sample.paneHash).be.undefined();
    should(sample.pane).be.undefined();
    should(sample.subprocessAlive).equal(true);
  });

  it('should keep a leftover browser only when the tree was observed (livenessSampleOf, today’s rule)', () => {
    // Arrange
    const digest = (text: string): string => text;

    // Act
    const blind = livenessSampleOf({ leftoverBrowser: true }, digest);
    const seen = livenessSampleOf({ children: false, leftoverBrowser: true }, digest);

    // Assert
    should(blind).eql({});
    should(seen).eql({ subprocessAlive: false, leftoverBrowser: true });
  });
});

describe('the browsers left under a ferret’s pane, read afresh (the read half of closeLeftoverBrowsers)', () => {
  it('should list only the top-level browser the agent launched: not its renderer, a helper’s browser or the harness', async () => {
    // Arrange
    const { look, asked } = subject({ rows: [HARNESS_ROW, MCP_ROW, helperBrowser, browserShell, browser, renderer] });

    // Act
    const read = await look.browsers('f1');

    // Assert
    should(asked.walked).eql([PANE_PID]);
    should(read).eql({ kind: 'observed', toolCommandRunning: false, browsers: [{ pid: 701, start: browser.start }] });
  });

  it('should say a tool command runs now, so the caller closes nothing', async () => {
    // Arrange
    const { look } = subject({ rows: [HARNESS_ROW, MCP_ROW, browserShell, browser, command, commandChild] });

    // Act
    const read = await look.browsers('f1');

    // Assert
    should(read).eql({ kind: 'observed', toolCommandRunning: true, browsers: [{ pid: 701, start: browser.start }] });
  });

  it('should never list the pane process (the ferret) nor anything outside the walk from its pid', async () => {
    // Arrange: the walk returns only descendants of the proved pane pid; the pane itself is never a row.
    const { look } = subject({ rows: [HARNESS_ROW, MCP_ROW, browserShell, browser] });

    // Act
    const read = await look.browsers('f1');

    // Assert
    if (read.kind !== 'observed') throw new Error('expected an observed pane');
    should(read.browsers.map(entry => entry.pid)).not.containEql(PANE_PID);
    should(read.browsers.map(entry => entry.pid)).not.containEql(HARNESS_PID);
  });

  it('should be unobservable, with the reason, when the tree cannot be read or the pane cannot be proved', async () => {
    // Arrange
    const unreadable = subject({ tree: { kind: 'unavailable', reason: "This ferret's pane could not be read." } });
    const unproved = subject({ refusal: new SessionAttachError('invalid_registration', 'no complete identity') });

    // Act
    const first = await unreadable.look.browsers('f1');
    const second = await unproved.look.browsers('f1');

    // Assert
    should(first).eql({ kind: 'unobservable', reason: "This ferret's pane could not be read." });
    should(second).eql({ kind: 'unobservable', reason: 'no complete identity' });
  });
});

describe('a browser re-proved just before Browsers signals it (paneBrowserStill: only a pid it can prove)', () => {
  const listed = { pid: browser.pid, start: browser.start };
  const leftover = [HARNESS_ROW, MCP_ROW, browserShell, browser, renderer];

  it('should prove the same browser by a FRESH walk: same pid, same start, still top-level under the proved pane', async () => {
    // Arrange
    const { look, asked } = subject({ rows: leftover });

    // Act
    const first = await look.still('f1', listed);
    const second = await look.still('f1', listed);

    // Assert: nothing is cached; each re-proof proves the pane and walks it again.
    should(first).eql({ still: true });
    should(second).eql({ still: true });
    should(asked.proofs).eql(['f1', 'f1']);
    should(asked.walked).eql([PANE_PID, PANE_PID]);
  });

  it('should not prove a pid whose start changed between the look and the signal (the pid was reused)', async () => {
    // Arrange: the second walk finds pid 701 again, but a later process holds it.
    const reused = rowOf({ pid: 701, ppid: 700, argv: '/opt/google/chrome/chrome --headless', ageSeconds: 1 });
    const later = { ...reused, start: browser.start + 5 };
    const { look } = subject({ rowsAt: walk => (walk === 1 ? leftover : [HARNESS_ROW, MCP_ROW, browserShell, later]) });

    // Act
    const read = await look.browsers('f1');
    const still = await look.still('f1', listed);

    // Assert
    should(read).eql({ kind: 'observed', toolCommandRunning: false, browsers: [listed] });
    should(still).eql({ still: false, why: 'not-proved' });
  });

  it('should say gone when no process holds the pid any more', async () => {
    // Arrange
    const { look } = subject({ rows: [HARNESS_ROW, MCP_ROW] });

    // Act
    const still = await look.still('f1', listed);

    // Assert
    should(still).eql({ still: false, why: 'gone' });
  });

  it('should not prove the same process once it is no longer under that pane (it moved out of the tree)', async () => {
    // Arrange: the process still runs with the same start, but the walk from the proved pane no longer reaches it.
    const { look } = subject({ rows: [HARNESS_ROW, MCP_ROW], startNow: () => browser.start });

    // Act
    const still = await look.still('f1', listed);

    // Assert
    should(still).eql({ still: false, why: 'not-proved' });
  });

  it('should not prove it while a tool command runs under the pane (it may be using that browser)', async () => {
    // Arrange
    const { look } = subject({ rows: [...leftover, command, commandChild] });

    // Act
    const still = await look.still('f1', listed);

    // Assert
    should(still).eql({ still: false, why: 'tool-running' });
  });

  it('should not prove anything when the pane cannot be proved, even if the pid still runs', async () => {
    // Arrange
    const { look } = subject({
      refusal: new SessionAttachError('invalid_registration', 'no complete identity'),
      startNow: () => browser.start,
    });

    // Act
    const still = await look.still('f1', listed);

    // Assert
    should(still).eql({ still: false, why: 'not-proved' });
  });

  it('should never prove pid 1 or below, or what is not a pid, and never walk for one', async () => {
    // Arrange
    const { look, asked } = subject({ rows: leftover });

    // Act
    const answers = await Promise.all(
      [1, 0, -4, Number.NaN].map(async pid => await look.still('f1', { pid, start: 1 })),
    );

    // Assert
    should(answers.every(answer => !answer.still && answer.why === 'not-proved')).be.true();
    should(asked.walked).eql([]);
  });
});
