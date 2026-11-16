import { describe, it } from 'bun:test';
import should from 'should';
import { MovePreflight, type MoveTargetView } from '../../../../daemon/lib/moves/preflight-service.ts';
import type { ProcessInfo, ProcessObservation } from '../../../../daemon/lib/moves/inflight-report.ts';
import type { MovePane, ProcessInventoryPort } from '../../../../daemon/lib/moves/process-inventory-port.ts';
import { identifyAgentJobs } from '../../../../daemon/lib/moves/agent-jobs.ts';
import { identifyKnownProcesses } from '../../../../daemon/lib/moves/harness-provenance.ts';
import { inventoryProcesses, type ProcRow } from '../../../../daemon/lib/moves/process-table.ts';
import { requesterCall } from '../../../../daemon/lib/moves/requester-call.ts';

const PIPELINE =
  "fy ferret move gustavo --agent claude-llm3 2>&1 | grep -v direnv | grep -v '\\[safe\\]' | grep -E '✖|refused'";
const wrap = (payload: string): string =>
  "/usr/bin/zsh -c source /home/kirin/.ferretry/fleet/homes/h/shell-snapshots/snapshot-zsh-1-ab.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval '" +
  payload.replaceAll("'", `'"'"'`) +
  "' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd";

const PANE = 100;
const provenance = {
  rootPid: PANE,
  binaryName: 'fy',
  toolsServerArguments: ['mcp', 'serve'],
  statuslineSubcommand: 'statusline',
  configuredServers: [],
};
const row = (pid: number, ppid: number, argv: string, startedSecondsAgo = 12): ProcRow => ({
  pid,
  ppid,
  argv,
  startedSecondsAgo,
});

/** The real false positive: the tool shell, `fy ferret move`, and three `ugrep` consumers, all 12 s old. */
const selfMoveRows: readonly ProcRow[] = [
  row(200, PANE, 'claude --resume x', 5000),
  row(300, 200, wrap(PIPELINE)),
  row(310, 300, wrap(PIPELINE)), // the pipeline's subshell: same argv, a fork of the tool shell
  row(320, 310, 'fy ferret move gustavo --agent claude-llm3'),
  row(321, 310, 'ugrep -v direnv'),
  row(322, 310, 'ugrep -v \\[safe\\]'),
  row(323, 310, 'ugrep -E ✖|refused'),
];

const observe = (rows: readonly ProcRow[]): ProcessObservation => {
  const known = identifyKnownProcesses(rows, provenance);
  const jobs = identifyAgentJobs(rows, PANE, known);
  return { kind: 'observed', processes: inventoryProcesses(rows, new Map(), known, new Set(), jobs) };
};

class StubInventory implements ProcessInventoryPort {
  constructor(private readonly observation: ProcessObservation) {}
  async collect(): Promise<ProcessObservation> {
    return this.observation;
  }
}
const panes: MovePane = { identify: async () => undefined, screen: async () => '' };
const view = (overrides: Partial<MoveTargetView> = {}): MoveTargetView => ({
  sessionId: 's1',
  harness: 'claude',
  pane: panes,
  status: 'tool_running',
  turn: 3,
  openTools: [],
  ...overrides,
});

describe('requesterCall', () => {
  it('should walk from the requester up to its tool shell and stop there', () => {
    const { processes } = observe(selfMoveRows) as { processes: readonly ProcessInfo[] };
    should(requesterCall(processes, 320)).deepEqual([320, 310, 300]);
  });

  it('should exclude nothing for a pid it cannot prove', () => {
    const { processes } = observe(selfMoveRows) as { processes: readonly ProcessInfo[] };
    should(requesterCall(processes, undefined)).deepEqual([]);
    should(requesterCall(processes, 999)).deepEqual([]); // not in this pane
    should(requesterCall(processes, 200)).deepEqual([]); // the harness itself
    should(requesterCall(processes, PANE)).deepEqual([]); // the pane root is not a descendant
  });

  it('should exclude nothing when the requester is not under a harness tool shell', () => {
    // A human typed `fy ferret move` into the pane's own shell: its parent is the pane, not a harness.
    const rows = [row(300, PANE, 'zsh'), row(320, 300, 'fy ferret move x --agent y')];
    const { processes } = observe(rows) as { processes: readonly ProcessInfo[] };
    should(requesterCall(processes, 320)).deepEqual([]);
  });
});

describe('a ferret moving itself', () => {
  it('should not be refused for its own tool shell, `fy ferret move` and three ugrep consumers', async () => {
    const preflight = new MovePreflight(new StubInventory(observe(selfMoveRows)));
    const tool = {
      type: 'tool.use',
      data: { toolUseId: 't1', name: 'Bash', input: { command: PIPELINE } },
    };

    const refused = await preflight.inspect(view({ openTools: ['t1'] }), [tool]);
    const own = await preflight.inspect(view({ openTools: ['t1'] }), [tool], { requesterPid: 320 });

    // Without the pid: refused, as the owner saw. With it: the call chain and its open tool are left out.
    should(preflight.gate(refused).proceed).be.false();
    should(preflight.gate(own).proceed).be.true();
    should(own.requesterCall?.map(entry => entry.pid)).deepEqual([320, 310, 300].sort());
    should(own.openTools).deepEqual([]);
    should(own.worstVerdict).equal('safe_to_kill');
  });

  it('should still refuse for a job the same tool shell left running beside the call', async () => {
    const rows = [...selfMoveRows, row(330, 300, 'bun run deploy.ts', 400)];
    const preflight = new MovePreflight(new StubInventory(observe(rows)));

    const report = await preflight.inspect(view(), [], { requesterPid: 320 });

    should(preflight.gate(report).proceed).be.false();
    should(report.processes.map(entry => entry.pid)).containEql(330);
  });

  it('should refuse as before when the requester pid belongs to no tool shell of this pane', async () => {
    const preflight = new MovePreflight(new StubInventory(observe(selfMoveRows)));
    const report = await preflight.inspect(view(), [], { requesterPid: 4242 });
    should(preflight.gate(report).proceed).be.false();
    should(report.requesterCall).be.undefined();
  });

  it('should keep a different open tool call blocking', async () => {
    const preflight = new MovePreflight(new StubInventory(observe(selfMoveRows)));
    const tools = [
      { type: 'tool.use', data: { toolUseId: 't1', name: 'Bash', input: { command: PIPELINE } } },
      { type: 'tool.use', data: { toolUseId: 't2', name: 'Bash', input: { command: 'git push' } } },
    ];
    const report = await preflight.inspect(view({ openTools: ['t1', 't2'] }), tools, { requesterPid: 320 });
    should(report.openTools.map(entry => entry.toolUseId)).deepEqual(['t2']);
    should(preflight.gate(report).proceed).be.false();
  });
});

describe('what may stand between the `fy` process and its tool shell', () => {
  const inspectRows = async (rows: readonly ProcRow[]) => {
    const preflight = new MovePreflight(new StubInventory(observe(rows)));
    return { preflight, report: await preflight.inspect(view(), [], { requesterPid: 320 }) };
  };

  it('should NOT exclude a long-running script that calls `fy ferret move me` (a slot-watch loop)', async () => {
    // Arrange — tool shell → `bash slot-watch.sh` (loops, retrying the migrate) → `fy ferret move me`.
    const rows = [
      row(200, PANE, 'claude --resume x', 5000),
      row(300, 200, wrap('bash slot-watch.sh')),
      row(310, 300, 'bash slot-watch.sh', 900),
      row(320, 310, 'fy ferret move me --agent claude-llm3'),
    ];
    const { processes } = observe(rows) as { processes: readonly ProcessInfo[] };

    // Act
    const { preflight, report } = await inspectRows(rows);

    // Assert — the walk stops at the script: nothing is excluded, and the gate sees all of it.
    should(requesterCall(processes, 320)).deepEqual([]);
    should(report.requesterCall).be.undefined();
    should(report.processes.map(entry => entry.pid)).containEql(310);
    should(preflight.gate(report).proceed).be.false();
  });

  it('should NOT exclude an interpreter, `watch` or `timeout` between them either', () => {
    for (const between of [
      'node loop.js',
      'python3 retry.py',
      'watch -n 5 fy ferret move me',
      'bun run try-advance.ts',
    ]) {
      const rows = [
        row(200, PANE, 'claude --resume x', 5000),
        row(300, 200, wrap('x')),
        row(310, 300, between, 900),
        row(320, 310, 'fy ferret move me --agent claude-llm3'),
      ];
      const { processes } = observe(rows) as { processes: readonly ProcessInfo[] };
      should(requesterCall(processes, 320)).deepEqual([]);
    }
  });

  it('should still exclude a pipeline subshell (the tool shell’s own command line) and a `sh -c` between them', () => {
    const forked = [
      row(200, PANE, 'claude --resume x', 5000),
      row(300, 200, wrap('fy ferret move me | tail')),
      row(310, 300, wrap('fy ferret move me | tail')),
      row(320, 310, 'fy ferret move me --agent claude-llm3'),
    ];
    const dashC = [
      row(200, PANE, 'claude --resume x', 5000),
      row(300, 200, wrap('sh -c "fy ferret move me"')),
      row(310, 300, 'sh -c fy ferret move me'),
      row(320, 310, 'fy ferret move me --agent claude-llm3'),
    ];
    for (const rows of [forked, dashC]) {
      const { processes } = observe(rows) as { processes: readonly ProcessInfo[] };
      should(requesterCall(processes, 320)).deepEqual([320, 310, 300]);
    }
  });

  it('should leave the pipeline’s other stages to the gate, each judged by what it is', async () => {
    // Arrange — the consumers are direct children of the pipeline shell; a `bun` stage there is not read-only.
    const rows = [...selfMoveRows, row(324, 310, 'bun run deploy.ts', 400)];

    // Act
    const { preflight, report } = await inspectRows(rows);

    // Assert
    should(report.processes.map(entry => entry.pid)).containEql(324);
    should(preflight.gate(report).proceed).be.false();
  });
});

describe('the report carries whose turn it is to the gate', () => {
  it('should tell a session at its prompt apart from one mid-turn', async () => {
    const preflight = new MovePreflight(new StubInventory({ kind: 'observed', processes: [] }));

    const working = await preflight.inspect(view({ status: 'running', turnState: 'working' }));
    const prompt = await preflight.inspect(view({ status: 'running', turnState: 'your-turn' }));

    should(working.midTurn).be.true();
    should(prompt.midTurn).be.false();
  });
});

describe('requesterCall — what else the chain shells were doing', () => {
  const chain = (payload: string, call = 'fy ferret move me --agent claude-llm3'): readonly ProcRow[] => [
    row(200, PANE, 'claude --resume x', 5000),
    row(300, 200, wrap(payload)),
    row(320, 300, call),
  ];
  const excluded = (rows: readonly ProcRow[]) =>
    requesterCall((observe(rows) as { processes: readonly ProcessInfo[] }).processes, 320);

  it('should exclude a shell that only ran the move, with a safe `cd`, `ls` or `echo` around it', () => {
    for (const payload of ['fy ferret move me', 'cd /tmp && fy ferret move me', 'echo hi; fy ferret move me --agent x'])
      should(excluded(chain(payload))).deepEqual([320, 300]);
  });

  it('should keep a shell visible that did other work around the move', () => {
    for (const payload of [
      'git stash && fy ferret move me && git stash pop',
      'while true; do ./advance.sh; fy ferret move me; sleep 60; done',
      'bun run deploy.ts; fy ferret move me',
      "bash -c 'git stash && fy ferret move me && git stash pop'",
    ])
      should(excluded(chain(payload))).deepEqual([]);
  });

  it('should exclude nothing when the requester is not a move request', () => {
    for (const call of ['git push origin main', 'fy wait me', 'fy send me hi', 'fy ferret move me $(rm -rf x)'])
      should(excluded(chain('fy ferret move me', call))).deepEqual([]);
  });

  it('should accept the fy5 preview and `fy ferret move`', () => {
    should(excluded(chain('fy ferret move me', 'fy ferret move me --agent x'))).deepEqual([320, 300]);
    should(excluded(chain('fy5 ferret move me', 'fy5 ferret move me'))).deepEqual([320, 300]);
  });
});
