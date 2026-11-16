import { describe, it } from 'bun:test';
import should from 'should';
import { MovePreflight, type MoveTargetView } from '../../../../daemon/lib/moves/preflight-service.ts';
import type { ProcessInfo, ProcessObservation } from '../../../../daemon/lib/moves/inflight-report.ts';
import type { ProcessInventoryPort } from '../../../../daemon/lib/moves/process-inventory-port.ts';
import { identifyAgentJobs } from '../../../../daemon/lib/moves/agent-jobs.ts';
import { identifyKnownProcesses } from '../../../../daemon/lib/moves/harness-provenance.ts';
import { inventoryProcesses, type ProcRow } from '../../../../daemon/lib/moves/process-table.ts';
import { requesterCall } from '../../../../daemon/lib/moves/requester-call.ts';

const PIPELINE =
  "fy migrate gustavo --agent claude-llm3 2>&1 | grep -v direnv | grep -v '\\[safe\\]' | grep -E '✖|refused'";
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

/** The real false positive: the tool shell, `fy migrate`, and three `ugrep` consumers, all 12 s old. */
const selfMoveRows: readonly ProcRow[] = [
  row(200, PANE, 'claude --resume x', 5000),
  row(300, 200, wrap(PIPELINE)),
  row(310, 300, wrap(PIPELINE)), // the pipeline's subshell: same argv, a fork of the tool shell
  row(320, 310, 'fy migrate gustavo --agent claude-llm3'),
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
const panes = { visible: async () => '' };
const view = (overrides: Partial<MoveTargetView> = {}): MoveTargetView => ({
  sessionId: 's1',
  harness: 'claude',
  tmuxSession: 'fy-s1',
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
    // A human typed `fy migrate` into the pane's own shell: its parent is the pane, not a harness.
    const rows = [row(300, PANE, 'zsh'), row(320, 300, 'fy migrate x --agent y')];
    const { processes } = observe(rows) as { processes: readonly ProcessInfo[] };
    should(requesterCall(processes, 320)).deepEqual([]);
  });
});

describe('a ferret moving itself', () => {
  it('should not be refused for its own tool shell, `fy migrate` and three ugrep consumers', async () => {
    const preflight = new MovePreflight(new StubInventory(observe(selfMoveRows)), panes);
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
    const preflight = new MovePreflight(new StubInventory(observe(rows)), panes);

    const report = await preflight.inspect(view(), [], { requesterPid: 320 });

    should(preflight.gate(report).proceed).be.false();
    should(report.processes.map(entry => entry.pid)).containEql(330);
  });

  it('should refuse as before when the requester pid belongs to no tool shell of this pane', async () => {
    const preflight = new MovePreflight(new StubInventory(observe(selfMoveRows)), panes);
    const report = await preflight.inspect(view(), [], { requesterPid: 4242 });
    should(preflight.gate(report).proceed).be.false();
    should(report.requesterCall).be.undefined();
  });

  it('should keep a different open tool call blocking', async () => {
    const preflight = new MovePreflight(new StubInventory(observe(selfMoveRows)), panes);
    const tools = [
      { type: 'tool.use', data: { toolUseId: 't1', name: 'Bash', input: { command: PIPELINE } } },
      { type: 'tool.use', data: { toolUseId: 't2', name: 'Bash', input: { command: 'git push' } } },
    ];
    const report = await preflight.inspect(view({ openTools: ['t1', 't2'] }), tools, { requesterPid: 320 });
    should(report.openTools.map(entry => entry.toolUseId)).deepEqual(['t2']);
    should(preflight.gate(report).proceed).be.false();
  });
});
