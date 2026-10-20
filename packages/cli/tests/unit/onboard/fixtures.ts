import type { DaemonUpdateView } from '@ferretry/protocol';
import type { DaemonInspection } from '../../../src/lib/daemon/controller.ts';
import type { DaemonSupervisorReport } from '../../../src/lib/daemon/ports.ts';
import { decideDaemonStatus } from '../../../src/lib/daemon/render.ts';
import type { OnboardDeps } from '../../../src/lib/onboard/controller.ts';
import type { IOnboardDaemon, RelayReach } from '../../../src/lib/onboard/ports.ts';
import { health, installedDaemon } from '../daemon/fixtures.ts';

const SERVING_SUPERVISED: DaemonSupervisorReport = { manager: 'launchd', state: 'running', pid: 4242 };
export const NO_DEFINITION: DaemonSupervisorReport = { manager: 'direct', state: 'absent' };

/** The daemon's update view, current unless a newer `latest` is given. */
function updateView(latest?: string): DaemonUpdateView {
  return {
    current: '1.2.3',
    method: { kind: 'homebrew', cask: 'ferretry' },
    plan: { kind: 'self', steps: [{ command: 'brew upgrade --cask ferretry' }], rollback: 'none' },
    check:
      latest === undefined
        ? { state: 'never' }
        : {
            state: 'ok',
            checkedAt: '2026-10-20T00:00:00.000Z',
            latest: { version: latest, url: `https://example.test/releases/v${latest}` },
          },
    available: latest !== undefined,
    midTurn: 0,
    autoInstall: false,
    job: null,
  };
}

interface InspectionInput {
  readonly serving?: boolean;
  readonly supervisor?: DaemonSupervisorReport;
  readonly version?: string;
  readonly installedVersion?: string;
  readonly missing?: boolean;
  readonly serviceManager?: boolean;
  readonly latest?: string;
  readonly nixShell?: boolean;
}

/** One inspection: serving under launchd at 1.2.3 by default. */
export function inspection(input: InspectionInput = {}): DaemonInspection {
  const serving = input.serving ?? true;
  const supervisor = input.supervisor ?? (serving ? SERVING_SUPERVISED : NO_DEFINITION);
  const view = decideDaemonStatus(
    'fyd',
    supervisor,
    serving ? health({ version: input.version ?? '1.2.3', pid: supervisor.pid ?? 99 }) : undefined,
  );
  return {
    view,
    located:
      input.missing === true
        ? { reason: 'cannot find fyd on PATH — install it or point FY_DAEMON_BIN at the executable' }
        : installedDaemon({ version: input.installedVersion ?? input.version ?? '1.2.3' }),
    update: {
      install:
        input.nixShell === true
          ? { kind: 'nix-shell', storePath: '/nix/store/x-ferretry' }
          : { kind: 'homebrew', cask: 'ferretry' },
      update: serving ? updateView(input.latest) : undefined,
    },
    serviceManager: input.serviceManager ?? true,
  };
}

/** A daemon whose inspections are played back in order, recording what was asked of it. */
export class FakeDaemon implements IOnboardDaemon {
  readonly calls: string[] = [];
  readonly quiet: boolean[] = [];
  constructor(
    private readonly inspections: DaemonInspection[],
    private readonly failure?: Error,
  ) {}

  async inspect(): Promise<DaemonInspection> {
    this.calls.push('inspect');
    const next = this.inspections.length > 1 ? this.inspections.shift() : this.inspections[0];
    if (next === undefined) throw new Error('nothing to inspect');
    return next;
  }

  async install(): Promise<void> {
    this.calls.push('install');
    if (this.failure !== undefined) throw this.failure;
  }

  async start(): Promise<void> {
    this.calls.push('start');
    if (this.failure !== undefined) throw this.failure;
  }
}

export interface Recorded {
  readonly lines: Array<{ readonly kind: string; readonly text: string }>;
  readonly questions: string[];
  exitCode: number | undefined;
  paired: number;
}

interface DepsInput {
  readonly daemon: FakeDaemon;
  readonly interactive?: boolean;
  readonly answers?: string[];
  readonly relay?: RelayReach;
  readonly setUp?: boolean | undefined;
}

/** Every port `fy setup` reads, faked, with what it wrote recorded. */
export function deps(input: DepsInput): { deps: OnboardDeps; recorded: Recorded } {
  const recorded: Recorded = { lines: [], questions: [], exitCode: undefined, paired: 0 };
  const answers = [...(input.answers ?? [])];
  const daemon = input.daemon;
  return {
    recorded,
    deps: {
      daemon: quiet => {
        daemon.quiet.push(quiet);
        return daemon;
      },
      relay: { reach: async () => input.relay ?? { state: 'relay', url: 'wss://relay.example.test' } },
      machine: { setUp: async () => ('setUp' in input ? input.setUp : true) },
      pairing: {
        pair: async () => {
          recorded.paired += 1;
        },
      },
      prompt: {
        ask: async question => {
          recorded.questions.push(question);
          return answers.shift() ?? '';
        },
      },
      out: {
        success: text => recorded.lines.push({ kind: 'success', text }),
        report: text => recorded.lines.push({ kind: 'report', text }),
        warn: text => recorded.lines.push({ kind: 'warn', text }),
        setExitCode: code => {
          recorded.exitCode = code;
        },
      },
      interactive: () => input.interactive ?? false,
      clientName: 'fy',
      clientVersion: '1.2.3',
    },
  };
}

/** The one JSON object a `--json` run printed. */
export function printedJson(recorded: Recorded): Record<string, unknown> {
  const reports = recorded.lines.filter(line => line.kind === 'report');
  if (reports.length !== 1) throw new Error(`expected one report, got ${String(reports.length)}`);
  return JSON.parse(reports[0]?.text ?? '') as Record<string, unknown>;
}
