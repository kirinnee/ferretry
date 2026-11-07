import { describe, it } from 'bun:test';
import type {
  HarnessCliView,
  HarnessUpdateReport,
  HarnessUpdateStartRequest,
  HarnessUpdateView,
} from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerHarnessCommands } from '../../../src/lib/harness/commands.ts';
import { HARNESS_UPDATE_POLL_MS, HarnessController } from '../../../src/lib/harness/controller.ts';
import type { IHarnessOutput, IHarnessUpdateGateway } from '../../../src/lib/harness/ports.ts';
import { renderHarnessStatus, verificationWords } from '../../../src/lib/harness/render.ts';

const CHANGELOG = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
const VERIFIED_URL = 'https://github.com/kirinnee/ferretry/blob/main/packages/fleet/tests/contract/README.md';
const PREFIX = '/home/kirin/.nvm/versions/node/v22';

const claude = (overrides: Partial<HarnessCliView> = {}): HarnessCliView => ({
  harness: 'claude',
  location: { state: 'located', path: `${PREFIX}/bin/claude`, rule: 'inherited environment', declaredBy: 'PATH' },
  installed: { state: 'ok', version: '2.1.200' },
  method: { kind: 'npm-global', tool: 'npm', package: '@anthropic-ai/claude-code', prefix: PREFIX, nodeManager: 'nvm' },
  plan: {
    kind: 'self',
    steps: [{ command: `npm install -g --prefix ${PREFIX} @anthropic-ai/claude-code@latest` }],
    rollback: 'automatic',
    pinsVersion: true,
  },
  check: { state: 'ok', checkedAt: '2026-10-20T09:00:00.000Z', latest: { version: '2.1.230', url: CHANGELOG } },
  verified: { version: '2.1.220', url: VERIFIED_URL },
  verification: 'older',
  available: true,
  job: null,
  ...overrides,
});

const codex = (overrides: Partial<HarnessCliView> = {}): HarnessCliView => ({
  harness: 'codex',
  location: { state: 'absent', searched: [] },
  installed: null,
  method: null,
  plan: null,
  check: { state: 'never' },
  verified: { version: '0.145.0', url: VERIFIED_URL },
  verification: 'unknown',
  available: false,
  job: null,
  ...overrides,
});

const finished = (outcome: HarnessUpdateReport['outcome'], message: string): HarnessCliView['job'] => ({
  state: 'finished',
  report: { outcome, message, finishedAt: '2026-10-20T09:01:00.000Z' },
});

class Gateway implements IHarnessUpdateGateway {
  readonly started: HarnessUpdateStartRequest[] = [];
  /** The views each read answers, in order; the last repeats. */
  constructor(
    private readonly views: HarnessUpdateView[],
    private readonly failure?: Error,
  ) {}
  async harnessUpdate(): Promise<HarnessUpdateView> {
    const view = this.views.length > 1 ? this.views.shift() : this.views[0];
    if (view === undefined) throw new Error('no view');
    return view;
  }
  async startHarnessUpdate(request: HarnessUpdateStartRequest): Promise<HarnessUpdateView> {
    if (this.failure !== undefined) throw this.failure;
    this.started.push(request);
    return await this.harnessUpdate();
  }
}

class Output implements IHarnessOutput {
  readonly lines: string[] = [];
  exitCode = 0;
  report(message: string): void {
    this.lines.push(message);
  }
  success(message: string): void {
    this.lines.push(`ok: ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error: ${message}`);
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

function controller(
  views: HarnessUpdateView[],
  options: { interactive?: boolean; answers?: string[]; failure?: Error } = {},
) {
  const gateway = new Gateway(views, options.failure);
  const out = new Output();
  const asked: string[] = [];
  const waits: number[] = [];
  const answers = [...(options.answers ?? [])];
  const subject = new HarnessController({
    gateway,
    out,
    prompt: {
      ask: async question => {
        asked.push(question);
        return answers.shift() ?? '';
      },
    },
    interactive: options.interactive ?? false,
    wait: async milliseconds => {
      waits.push(milliseconds);
    },
    binaryName: 'fy',
  });
  return { subject, gateway, out, asked, waits };
}

describe('fy harness status', () => {
  it('says where each harness is, how it was installed, what it runs and what Ferretry verified', async () => {
    const { subject, out } = controller([{ harnesses: [claude(), codex()] }]);
    await subject.status({});
    should(out.lines[0]).equal(
      [
        'Claude Code 2.1.200 — update available: 2.1.230 (not yet verified by Ferretry)',
        `  Runs:       ${PREFIX}/bin/claude  (inherited environment — PATH)`,
        `  Installed:  npm global — npm global package @anthropic-ai/claude-code in ${PREFIX} (node from nvm)`,
        '  Verified:   older than 2.1.220, the version Ferretry verified',
        '  Latest:     2.1.230 on npm, checked 2026-10-20T09:00:00.000Z',
        `  Update:     fy harness update claude — runs npm install -g --prefix ${PREFIX} @anthropic-ai/claude-code@latest`,
        '',
        'Codex: not found on this machine',
        '  Searched PATH.',
        '',
        'Running ferrets keep the version they started with until they are restarted.',
      ].join('\n'),
    );
  });

  it('prints the protocol payload with --json', async () => {
    const view = { harnesses: [claude()] };
    const { subject, out } = controller([view]);
    await subject.status({ json: true });
    should(JSON.parse(out.lines[0] ?? '')).eql(view);
  });

  it('renders every other state a harness can be in', () => {
    const text = renderHarnessStatus(
      {
        harnesses: [
          claude({
            installed: { state: 'unreadable', reason: 'it timed out' },
            available: false,
            check: {
              state: 'failed',
              checkedAt: '2026-10-20T09:00:00.000Z',
              reason: 'could not reach npm',
              lastKnown: { checkedAt: '2026-10-20T08:00:00.000Z', latest: { version: '2.1.230', url: CHANGELOG } },
            },
            plan: {
              kind: 'manual',
              explanation: 'Bump the flake.',
              steps: [
                { command: 'nix flake update nixpkgs', note: 'in your flake' },
                { command: 'home-manager switch --flake .' },
              ],
            },
            job: { state: 'running', startedAt: '2026-10-20T09:00:00.000Z', command: 'brew update' },
          }),
          codex({
            location: {
              state: 'override-absent',
              path: '/x',
              declaredBy: 'FY_CODEX_BIN',
              reason: 'FY_CODEX_BIN names /x',
            },
          }),
          codex({ location: { state: 'absent', searched: ['/opt/bin', '/usr/bin'] } }),
          claude({
            installed: { state: 'ok', version: '2.1.220' },
            available: false,
            check: { state: 'never' },
            method: null,
            plan: null,
            job: finished('succeeded', 'Updated Claude Code.'),
          }),
          claude({
            installed: { state: 'ok', version: '2.1.230' },
            available: false,
            plan: null,
          }),
        ],
      },
      'fy',
    );
    should(text).match(/Claude Code \(version unreadable\) — up to date/u);
    should(text).match(/ {2}Version: {4}unreadable — it timed out/u);
    should(text).match(/the check at 2026-10-20T09:00:00\.000Z failed: could not reach npm \(last known 2\.1\.230\)/u);
    should(text).match(
      / {2}Update: {5}Bump the flake\.\n {4}nix flake update nixpkgs {3}# in your flake\n {4}home-manager switch --flake \./u,
    );
    should(text).match(/ {2}Updating: {3}running brew update/u);
    should(text).match(/Codex: not usable — FY_CODEX_BIN names \/x/u);
    should(text).match(/Searched PATH and \/opt\/bin, \/usr\/bin\./u);
    should(text).match(/Claude Code 2\.1\.220\n {2}Runs:/u);
    should(text).match(/2\.1\.220 is the version Ferretry verified/u);
    should(text).match(/ {2}Latest: {5}not checked/u);
    should(text).match(/ {2}Last update: Updated Claude Code\./u);
    should(text).match(/Claude Code 2\.1\.230 — up to date/u);
  });

  it('words every verification', () => {
    should(verificationWords(claude(), '2.1.230')).equal(
      `not yet verified by Ferretry (verified: 2.1.220) — ${VERIFIED_URL}`,
    );
    should(verificationWords(claude(), undefined)).equal('Ferretry verified 2.1.220');
  });
});

describe('fy harness update', () => {
  it('refuses a harness it does not know and a --to that is not a version', async () => {
    const { subject } = controller([{ harnesses: [claude()] }]);
    await should(subject.update('gemini', {})).be.rejectedWith('unknown harness "gemini"; name claude or codex');
    await should(subject.update('claude', { to: 'newest' })).be.rejectedWith(/--to takes a version like 2\.1\.220/u);
  });

  it('updates to the verified version with --to verified --yes, then reports how it ended', async () => {
    const running = claude({ job: { state: 'running', startedAt: '2026-10-20T09:00:00.000Z', command: 'npm' } });
    const done = claude({ job: finished('succeeded', 'Updated Claude Code 2.1.200 → 2.1.220.') });
    const { subject, gateway, out, waits } = controller([
      { harnesses: [claude()] },
      { harnesses: [running] },
      { harnesses: [running] },
      { harnesses: [done] },
    ]);
    await subject.update('claude', { to: 'verified', yes: true });
    should(gateway.started).eql([{ harness: 'claude', target: '2.1.220' }]);
    should(out.lines).eql([
      `Claude Code 2.1.200 → 2.1.220, with: npm install -g --prefix ${PREFIX} @anthropic-ai/claude-code@2.1.220`,
      'Updating Claude Code… this can take a few minutes.',
      'ok: Updated Claude Code 2.1.200 → 2.1.220.',
    ]);
    should(waits).eql([HARNESS_UPDATE_POLL_MS, HARNESS_UPDATE_POLL_MS]);
    should(out.exitCode).equal(0);
  });

  it('never goes past the verified version on --yes alone', async () => {
    const { subject, gateway, out } = controller([{ harnesses: [claude()] }]);
    await subject.update('claude', { yes: true });
    should(gateway.started).be.empty();
    should(out.lines.slice(1)).eql([
      `warn: Claude Code 2.1.230 has not been verified by Ferretry yet (verified: 2.1.220). Known risks: ${VERIFIED_URL}`,
      'error: Nothing was changed. Re-run with --allow-unverified to install it anyway, or --to verified.',
    ]);
    should(out.exitCode).equal(1);
  });

  it('goes past it with --allow-unverified, and says a rollback with a non-zero exit', async () => {
    const { subject, gateway, out } = controller([
      { harnesses: [claude()] },
      { harnesses: [claude({ job: finished('rolled-back', 'It did not start, so 2.1.200 was put back.') })] },
    ]);
    await subject.update('claude', { yes: true, allowUnverified: true });
    should(gateway.started).eql([{ harness: 'claude', confirmUnverified: true }]);
    should(out.lines.at(-1)).equal('warn: It did not start, so 2.1.200 was put back.');
    should(out.exitCode).equal(1);
  });

  it('asks at a terminal — both questions — and stops on a no', async () => {
    const yesYes = controller(
      [{ harnesses: [claude()] }, { harnesses: [claude({ job: finished('failed', 'npm stopped.') })] }],
      { interactive: true, answers: ['y', 'yes'] },
    );
    await yesYes.subject.update('claude', {});
    should(yesYes.asked).eql(['Install a version Ferretry has not verified? [y/N]', 'Update now? [y/N]']);
    should(yesYes.out.lines.at(-1)).equal('error: npm stopped.');
    should(yesYes.out.exitCode).equal(1);

    const no = controller([{ harnesses: [claude()] }], { interactive: true, answers: ['n'] });
    await no.subject.update('claude', {});
    should(no.gateway.started).be.empty();
    should(no.out.lines.at(-1)).equal('warn: Nothing was changed.');
  });

  it('needs --yes when nobody is at a terminal to ask', async () => {
    const { subject, gateway, out } = controller([{ harnesses: [claude()] }]);
    await subject.update('claude', { to: '2.1.220' });
    should(gateway.started).be.empty();
    should(out.lines.at(-1)).equal(
      'error: Nothing was changed: this needs a yes. Re-run with --yes to go ahead without being asked.',
    );
  });

  it('asks for the same yes when the newest version could not be learned', async () => {
    const unknown = claude({ check: { state: 'never' }, installed: { state: 'unreadable', reason: 'odd' } });
    const { subject, out } = controller([{ harnesses: [unknown] }]);
    await subject.update('claude', { yes: true });
    should(out.lines[0]).match(/^Claude Code \(version unreadable\) → the newest available, with:/u);
    should(out.lines[1]).match(/^warn: Ferretry could not learn which Claude Code version this installs/u);
  });

  it('says an up-to-date harness is up to date, both ways', async () => {
    const current = claude({ installed: { state: 'ok', version: '2.1.230' }, available: false });
    const { subject, out } = controller([{ harnesses: [current] }]);
    await subject.update('claude', {});
    await subject.update('claude', { to: '2.1.220' });
    should(out.lines).eql([
      'ok: Claude Code 2.1.230 is already the newest version known.',
      'ok: Claude Code 2.1.230 is already at or past 2.1.220.',
    ]);
  });

  it('hands back the steps for a method Ferretry cannot update, and refuses a harness it cannot find', async () => {
    const module = claude({ method: { kind: 'nix-module', manager: 'home-manager' } });
    const { subject, out } = controller([{ harnesses: [module, codex()] }]);
    await subject.update(undefined, {});
    should(out.lines[0]).match(/^warn: Claude Code: Claude Code comes from your home-manager configuration/u);
    should(out.lines[1]).match(/^ {2}nix flake update nixpkgs {3}# in your configuration flake/u);
    should(out.lines[2]).equal('  home-manager switch --flake .');
    should(out.lines.at(-1)).equal('error: Codex: this daemon cannot find it, so there is nothing to update.');
    should(out.exitCode).equal(1);
  });

  it('says the daemon’s refusal, and a non-Error refusal too', async () => {
    const refused = controller([{ harnesses: [claude()] }], {
      failure: new Error('Claude Code is already being updated'),
    });
    await refused.subject.update('claude', { to: '2.1.220', yes: true });
    should(refused.out.lines.at(-1)).equal('error: Claude Code: Claude Code is already being updated');
    const odd = controller([{ harnesses: [claude()] }], { failure: 'odd' as unknown as Error });
    await odd.subject.update('claude', { to: '2.1.220', yes: true });
    should(odd.out.lines.at(-1)).equal('error: Claude Code: odd');
  });

  it('skips a harness the daemon did not report', async () => {
    const { subject, out } = controller([{ harnesses: [] }]);
    await subject.update('codex', {});
    should(out.lines).be.empty();
  });
});

describe('the harness command surface', () => {
  function run(argv: string[], views: HarnessUpdateView[]) {
    const { subject, gateway, out } = controller(views);
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerHarnessCommands(program, subject);
    return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
  }

  it('mounts status and update with their flags', async () => {
    const status = run(['harness', 'status', '--json'], [{ harnesses: [] }]);
    await status.parsed;
    should(JSON.parse(status.out.lines[0] ?? '')).eql({ harnesses: [] });
    const update = run(
      ['harness', 'update', 'claude', '--to', '2.1.220', '--yes', '--allow-unverified'],
      [{ harnesses: [claude()] }, { harnesses: [claude({ job: finished('succeeded', 'Updated.') })] }],
    );
    await update.parsed;
    should(update.gateway.started).eql([{ harness: 'claude', target: '2.1.220' }]);
  });
});
