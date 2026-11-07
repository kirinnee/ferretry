import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import {
  type AccountChange,
  type AccountChangeOutcome,
  type AccountChangeView,
  type CloneBundle,
  CloneBundleSchema,
  type CloneReview,
  type MachineView,
  MachineViewSchema,
  type SetupScan,
} from '@ferretry/plugin-runtimes/contract';
import should from 'should';
import { parseArgs } from '../../src/lib/argv.ts';
import { optionList } from '../../src/lib/machine/flags.ts';
import { renderMachine, installTools, machineSettingsEdit, parseCloneBundle } from '../../src/lib/commands/machine.ts';
import { MACHINE_ROUTES } from '../../src/lib/machine/gateway.ts';
import { runClone } from '../../src/lib/machine/clone-command.ts';
import { runChange } from '../../src/lib/machine/change.ts';
import type { IMachineGateway, MachineDeps } from '../../src/lib/machine/ports.ts';
import { runFy } from '../../src/lib/run.ts';
import { CapturedOutput } from './update/support.ts';
import { fakeWorld, inventoryOf, registryOf, skeletonEntry } from './fakes.ts';

const machineView = (over: Partial<MachineView> = {}): MachineView =>
  MachineViewSchema.parse({
    name: 'laptop',
    format: 'present',
    setUp: true,
    agentPermissions: 'auto',
    defaultRuntime: 'claude-default',
    agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
    browserMode: 'headless',
    browserProxy: null,
    browserPorts: 'random',
    browserFirewallFailure: 'warn',
    autoResume: true,
    agendaMode: false,
    publicUsageFeed: false,
    lastAutoResume: { at: '2026-11-06T10:00:00.000Z', resumed: 2, skipped: [{ sessionId: 'ada', reason: 'no pane' }] },
    tools: [
      { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/usr/bin/claude' },
      { harness: 'codex', label: 'Codex', installed: false },
    ],
    runtimeCount: 2,
    runningSessions: 1,
    authority: { mayApply: true, applyRefusal: 'granted' },
    ...over,
  });

const bundle = (): CloneBundle =>
  CloneBundleSchema.parse({
    format: 'ferretry-clone',
    version: 1,
    machine: 'desktop',
    daemon: 'daemon-1',
    exportedAt: '2026-11-06T10:00:00.000Z',
    credentials: [],
    components: { mcp: { notes: { command: 'notes-server' } } },
    profiles: {},
    runtimes: {},
    files: [],
    notCopied: [],
    keys: {},
  });

const changeView = (summary = 'Set agent permissions'): AccountChangeView =>
  ({
    id: 'fy_fprop_aaaaaaaaaaaaaaaaaaaaaa',
    summary,
    consequences: [],
    preview: { kind: 'executor', executor: 'clone', description: 'copies the setup' },
  }) as unknown as AccountChangeView;

interface Calls {
  readonly staged: AccountChange[];
  readonly applied: string[];
  readonly installs: string[][];
  readonly reviews: unknown[];
  readonly forgotten: string[];
}

function fakeGateway(
  options: {
    view?: MachineView;
    scan?: Partial<SetupScan>;
    review?: CloneReview;
    outcome?: AccountChangeOutcome;
    installOutcomes?: unknown[];
  } = {},
) {
  const calls: Calls = { staged: [], applied: [], installs: [], reviews: [], forgotten: [] };
  const gateway: IMachineGateway = {
    machine: async () => options.view ?? machineView(),
    stage: async change => {
      calls.staged.push(change);
      return changeView();
    },
    apply: async id => {
      calls.applied.push(id);
      return (
        options.outcome ?? ({ outcome: 'executed', executor: 'clone', summary: 'Copied.' } as AccountChangeOutcome)
      );
    },
    scan: async () => ({ tools: [], ...options.scan }) as unknown as SetupScan,
    installTools: async harnesses => {
      calls.installs.push([...harnesses]);
      return { outcomes: options.installOutcomes ?? [] } as never;
    },
    exportBundle: async () => bundle(),
    reviewClone: async request => {
      calls.reviews.push(request);
      if (options.review === undefined) throw new Error('no review scripted');
      return options.review;
    },
    forgetCloneSource: async source => {
      calls.forgotten.push(source);
      return source === 'known';
    },
  };
  return { gateway, calls };
}

function depsOf(gateway: IMachineGateway, over: Partial<MachineDeps> = {}) {
  const lines: string[] = [];
  const out = new CapturedOutput();
  const deps: MachineDeps = {
    gateway,
    out: {
      success: m => lines.push(`ok: ${m}`),
      report: m => lines.push(m),
      warn: m => lines.push(`warn: ${m}`),
      error: m => lines.push(`err: ${m}`),
      setExitCode: c => out.setExitCode(c),
    },
    prompt: { ask: async () => 'y' },
    interactive: false,
    readText: async () => '',
    binaryName: 'fy',
    ...over,
  };
  return { deps, text: () => lines.join('\n'), out };
}

const reviewOf = (over: Partial<CloneReview> = {}): CloneReview =>
  ({
    mode: 'update',
    source: { name: 'desktop', lastCopiedAt: '2026-10-28T00:00:00.000Z', verified: 'self' },
    items: [],
    settings: [],
    logins: [],
    keys: [],
    same: { count: 4, probable: 0 },
    fingerprint: 'fp-1',
    ...over,
  }) as CloneReview;

const item = (ref: string, outcome: string, extra: object = {}) =>
  ({ ref, kind: 'mcp', outcome, match: 'key', files: [], ...extra }) as CloneReview['items'][number];

describe('fy machine (V-0312)', () => {
  it('V-0312 renders the machine in words: setup, permissions, control, ferrets and tools', () => {
    const text = renderMachine(machineView(), 'fy');
    should(text).containEql('laptop');
    should(text).containEql('Setup: the account model, 2 runtime(s)');
    should(text).containEql('What agents may control: terminals on, browsers on, files on, settings off, scripts off');
    should(text).containEql("Couldn't auto-resume ada: no pane");
    should(text).containEql('Ferrets running: 1');
    should(text).containEql('Codex: not installed');
  });

  it('V-0312 points an unset machine at onboarding', () => {
    should(renderMachine(machineView({ format: 'none', setUp: false }), 'fy')).containEql(
      'Set it up with `fy onboard`',
    );
  });

  const runtimes = () =>
    skeletonEntry(
      definePlugin({
        id: 'runtimes',
        title: 'Runtimes',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: ['command'],
        actions: {
          routes: [
            route(MACHINE_ROUTES.machine, {
              minimum: 'operator',
              audit: { skip: 't' },
              guard: { none: 't' },
              caller: 'any',
            }),
            route(MACHINE_ROUTES.exportBundle, {
              minimum: 'operator',
              audit: { skip: 't' },
              guard: { none: 't' },
              caller: 'any',
            }),
          ],
        },
      }),
      'h-runtimes',
    );

  const wired = (replies: unknown[]) => {
    const made = fakeWorld({
      registry: registryOf(runtimes()),
      inventory: inventoryOf({ id: 'runtimes', contract: 'h-runtimes' }),
    });
    for (const body of replies) made.transport.replies.push({ status: 200, body });
    return {
      ...made,
      world: {
        ...made.world,
        prompt: { ask: async () => 'y' },
        readText: async (path: string) => Bun.file(path).text(),
      },
    };
  };

  it('V-0312 reads the machine through the Runtimes route and prints it, or (--json) the daemon’s own view', async () => {
    const { world, io, transport } = wired([machineView(), machineView()]);
    should(await runFy(['machine'], world)).equal(0);
    should(io.stdout()).containEql('Setup: the account model');
    should(transport.sent[0]?.path).equal('/v1/runtimes/machine');
    should(await runFy(['machine', '--json'], world)).equal(0);
    should(JSON.parse(io.stdout().slice(io.stdout().indexOf('{'))).name).equal('laptop');
  });

  it('V-0314 prints the export as JSON after asking whether this caller may change the machine', async () => {
    const { world, io, transport } = wired([machineView(), bundle()]);
    should(await runFy(['machine', 'export'], world)).equal(0);
    should(transport.sent.map(request => request.path)).deepEqual(['/v1/runtimes/machine', '/v1/runtimes/export']);
    should(JSON.parse(io.stdout()).format).equal('ferretry-clone');
  });

  it('V-0314 refuses an export to a caller that may not apply, in words, and reads nothing more', async () => {
    const { world, io, transport } = wired([
      machineView({ authority: { mayApply: false, applyRefusal: 'not-granted' } }),
    ]);
    should(await runFy(['machine', 'export'], world)).equal(1);
    should(io.stderr()).containEql('has not granted it');
    should(transport.sent.length).equal(1);
  });

  it('V-0313 says a file that cannot be read could not be read, and exits 1', async () => {
    const { world, io } = wired([]);
    should(await runFy(['machine', 'clone', '/nonexistent/setup.json'], world)).equal(1);
    should(io.stderr()).containEql('Could not read /nonexistent/setup.json.');
  });
});

describe('fy machine set (V-0316)', () => {
  it('V-0316 changes ONLY the named field and restates every other machine setting', () => {
    const current = machineView();
    const edit = machineSettingsEdit('agent-permissions', ['skip'], current, 'fy');
    should(edit).deepEqual({
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: 'claude-default',
      agentControl: current.agentControl,
      browserMode: 'headless',
      browserProxy: null,
      browserPorts: 'random',
      browserFirewallFailure: 'warn',
      autoResume: true,
      agendaMode: false,
      publicUsageFeed: false,
    });
  });

  it('V-0316 sets the default runtime, or back to the machine’s own with "automatic"', () => {
    should(machineSettingsEdit('default-runtime', ['mine'], machineView(), 'fy').defaultRuntime).equal('mine');
    should(machineSettingsEdit('default-runtime', ['automatic'], machineView(), 'fy').defaultRuntime).equal(null);
    should(() => machineSettingsEdit('default-runtime', [], machineView(), 'fy')).throw(/Name a runtime/u);
  });

  it('V-0316 turns one agent-control kind on or off by the word the verb takes', () => {
    const edit = machineSettingsEdit('agent-control', ['settings', 'on'], machineView(), 'fy');
    should(edit.agentControl).deepEqual({
      terminals: true,
      browsers: true,
      files: true,
      ferretrySettings: true,
      pageScripts: false,
    });
    should(() => machineSettingsEdit('agent-control', ['nothing', 'on'], machineView(), 'fy')).throw(/is not one of/u);
    should(() => machineSettingsEdit('agent-control', ['files', 'maybe'], machineView(), 'fy')).throw(/Say on or off/u);
  });

  it('V-0316 sets auto-resume and agenda-mode, and refuses anything that is not a machine setting', () => {
    should(machineSettingsEdit('auto-resume', ['off'], machineView(), 'fy').autoResume).equal(false);
    should(machineSettingsEdit('agenda-mode', ['on'], machineView(), 'fy').agendaMode).equal(true);
    should(() => machineSettingsEdit('colour', ['red'], machineView(), 'fy')).throw(/is not a machine setting/u);
    should(() => machineSettingsEdit('agent-permissions', ['maybe'], machineView(), 'fy')).throw(/auto or skip/u);
  });

  it('V-0316 stages the change, shows its preview, and applies exactly what was staged after a yes', async () => {
    const { gateway, calls } = fakeGateway();
    const { deps, text } = depsOf(gateway, { interactive: true });
    const change = machineSettingsEdit('agent-permissions', ['skip'], machineView(), 'fy');
    await runChange(deps, { change, destructive: true, options: {} });
    should(calls.staged).deepEqual([change]);
    should(calls.applied).deepEqual(['fy_fprop_aaaaaaaaaaaaaaaaaaaaaa']);
    should(text()).containEql('Set agent permissions');
  });

  it('V-0316 --dry-run stages and shows, and applies nothing', async () => {
    const { gateway, calls } = fakeGateway();
    const { deps, text } = depsOf(gateway);
    await runChange(deps, {
      change: { kind: 'runtime.enable', name: 'x' },
      destructive: true,
      options: { dryRun: true },
    });
    should(calls.applied).deepEqual([]);
    should(text()).containEql('Dry run: nothing was changed.');
  });

  it('V-0316 off a terminal without --yes it applies nothing and exits 1', async () => {
    const { gateway, calls } = fakeGateway();
    const { deps, text, out } = depsOf(gateway);
    await runChange(deps, { change: { kind: 'runtime.enable', name: 'x' }, destructive: true, options: {} });
    should(calls.applied).deepEqual([]);
    should(out.exitCode).equal(1);
    should(text()).containEql('Re-run with --yes');
  });

  it('V-0316 a caller that may not apply is refused in words BEFORE anything is staged', async () => {
    const { gateway, calls } = fakeGateway({
      view: machineView({ authority: { mayApply: false, applyRefusal: 'step-up-required' } }),
    });
    const { deps } = depsOf(gateway);
    await expect(
      runChange(deps, { change: { kind: 'runtime.enable', name: 'x' }, destructive: false, options: {} }),
    ).rejects.toThrow('needs a passkey confirmation');
    should(calls.staged).deepEqual([]);
  });
});

describe('fy machine install (V-0315)', () => {
  const missing = (harness: string, install: object) =>
    ({ harness, label: harness === 'codex' ? 'Codex' : 'Claude Code', installed: false, install }) as never;

  it('V-0315 shows the exact command first, and with --dry-run runs nothing', async () => {
    const { gateway, calls } = fakeGateway({
      scan: { tools: [missing('codex', { kind: 'runnable', command: 'npm i -g codex' })] },
    });
    const { deps, text } = depsOf(gateway);
    should(await installTools(deps, ['codex'], { dryRun: true })).equal(false);
    should(text()).containEql('Codex will be installed with: npm i -g codex');
    should(calls.installs).deepEqual([]);
  });

  it('V-0315 installs after a yes and reports each outcome; a failure names the command to run by hand', async () => {
    const { gateway, calls } = fakeGateway({
      scan: { tools: [missing('codex', { kind: 'runnable', command: 'npm i -g codex' })] },
      installOutcomes: [
        {
          harness: 'codex',
          outcome: 'failed',
          cause: 'needs-admin',
          reason: 'needs sudo',
          manualCommand: 'sudo npm i -g codex',
        },
      ],
    });
    const { deps, text, out } = depsOf(gateway);
    should(await installTools(deps, ['codex'], { yes: true })).equal(false);
    should(calls.installs).deepEqual([['codex']]);
    should(text()).containEql('Codex was not installed: needs sudo');
    should(text()).containEql('Run it yourself: sudo npm i -g codex');
    should(out.exitCode).equal(1);
  });

  it('V-0315 says a tool is already installed, and does nothing more', async () => {
    const { gateway, calls } = fakeGateway({
      scan: { tools: [{ harness: 'claude-code', label: 'Claude Code', installed: true } as never] },
    });
    const { deps, text } = depsOf(gateway);
    should(await installTools(deps, ['claude-code'], {})).equal(true);
    should(text()).containEql('Claude Code is already installed.');
    should(calls.installs).deepEqual([]);
  });

  it('V-0315 a tool that cannot be installed from here is said so with the remedy, and exits 1', async () => {
    const { gateway } = fakeGateway({
      scan: { tools: [missing('codex', { kind: 'no-package-manager', reason: 'no npm', manualCommand: 'get npm' })] },
    });
    const { deps, text, out } = depsOf(gateway);
    should(await installTools(deps, ['codex'], { yes: true })).equal(false);
    should(text()).containEql('cannot be installed from here: no npm');
    should(out.exitCode).equal(1);
  });
});

describe('fy machine clone (V-0313)', () => {
  it('V-0313 refuses a file that is not JSON, or is not a setup export', () => {
    should(() => parseCloneBundle('nope', 'x.json')).throw('x.json is not a setup export: it is not JSON.');
    should(() => parseCloneBundle('{"a":1}', 'x.json')).throw('x.json is not a setup export from `machine export`.');
    should(parseCloneBundle(JSON.stringify(bundle()), 'x.json').machine).equal('desktop');
  });

  it('V-0313 names the setup to copy when no file is given', async () => {
    const { gateway } = fakeGateway();
    const { deps } = depsOf(gateway);
    await expect(runClone(deps, undefined, undefined, {})).rejects.toThrow(
      'Name the setup to copy: fy machine clone <file>',
    );
  });

  it('V-0313 --replace and --alongside together are refused, and update-only choices do not fit a whole copy', async () => {
    const { gateway } = fakeGateway();
    const { deps } = depsOf(gateway);
    await expect(runClone(deps, 'f', bundle(), { replace: true, alongside: true })).rejects.toThrow('Pick one.');
    await expect(runClone(deps, 'f', bundle(), { replace: true, theirs: ['mcp/notes'] })).rejects.toThrow(
      '--theirs choose between two versions',
    );
  });

  it('V-0313 --forget stands alone, and drops the record of one source only', async () => {
    const { gateway, calls } = fakeGateway();
    const { deps, text } = depsOf(gateway);
    await expect(runClone(deps, 'file', undefined, { forget: 'known' })).rejects.toThrow('--forget stands alone');
    await runClone(deps, undefined, undefined, { forget: 'known' });
    await runClone(deps, undefined, undefined, { forget: 'other' });
    should(calls.forgotten).deepEqual(['known', 'other']);
    should(text()).containEql('Forgot known:');
    should(text()).containEql('There is no record of other');
  });

  it('V-0313 --forget --dry-run says what it would do and asks the daemon nothing', async () => {
    const { gateway, calls } = fakeGateway();
    const { deps, text } = depsOf(gateway);
    await runClone(deps, undefined, undefined, { forget: 'known', dryRun: true });
    should(calls.forgotten).deepEqual([]);
    should(text()).containEql('Dry run:');
  });

  it('V-0313 --replace copies everything after a yes, and asks first because a replace is destructive', async () => {
    const { gateway, calls } = fakeGateway();
    const { deps, out } = depsOf(gateway);
    await runClone(deps, 'f', bundle(), { replace: true });
    should(calls.applied).deepEqual([]);
    should(out.exitCode).equal(1);
    await runClone(deps, 'f', bundle(), { replace: true, yes: true, skip: ['mcp/notes'] });
    should(calls.staged.at(-1)).containEql({ kind: 'clone.import', mode: 'replace', skip: ['mcp/notes'] });
    should(calls.applied.length).equal(1);
  });

  it('V-0313 a first copy is alongside, and asks first when it brings a command to run, unless it is skipped', async () => {
    const { gateway, calls } = fakeGateway({ review: reviewOf({ mode: 'first' }) });
    const { deps, out } = depsOf(gateway);
    await runClone(deps, 'f', bundle(), {});
    should(calls.staged.at(-1)).containEql({ kind: 'clone.import', mode: 'alongside' });
    should(calls.applied).deepEqual([]);
    should(out.exitCode).equal(1);
    await runClone(deps, 'f', bundle(), { skip: ['mcp/notes'] });
    should(calls.applied.length).equal(1);
  });

  it('V-0313 a first copy refuses update-only choices, because there is only one version of everything', async () => {
    const { gateway } = fakeGateway({ review: reviewOf({ mode: 'first' }) });
    const { deps } = depsOf(gateway);
    await expect(runClone(deps, 'f', bundle(), { theirs: ['mcp/notes'] })).rejects.toThrow(
      'has not been copied here before',
    );
  });

  it('V-0313 an update shows only what differs, and --dry-run applies nothing', async () => {
    const { gateway, calls } = fakeGateway({
      review: reviewOf({ items: [item('mcp/notes', 'theirs', { fields: ['command'] })] }),
    });
    const { deps, text } = depsOf(gateway);
    await runClone(deps, 'f', bundle(), { dryRun: true });
    should(text()).containEql('Update from desktop (last copied 2026-10-28)');
    should(text()).containEql('Changed on desktop (1)');
    should(text()).containEql('4 things already the same.');
    should(calls.staged).deepEqual([]);
  });

  it('V-0313 an item both machines changed is never chosen for the person: off a terminal the copy is refused naming it', async () => {
    const { gateway, calls } = fakeGateway({ review: reviewOf({ items: [item('mcp/notes', 'both')] }) });
    const { deps } = depsOf(gateway);
    await expect(runClone(deps, 'f', bundle(), {})).rejects.toThrow(
      'Both machines changed this, and nothing is chosen for you',
    );
    should(calls.staged).deepEqual([]);
  });

  it('V-0313 --theirs takes the other machine’s version, and the apply carries the review it was shown', async () => {
    const { gateway, calls } = fakeGateway({ review: reviewOf({ items: [item('mcp/notes', 'both')] }) });
    const { deps } = depsOf(gateway);
    await runClone(deps, 'f', bundle(), { theirs: ['mcp/notes'], yes: true });
    should(calls.staged.at(-1)).containEql({ kind: 'clone.import', mode: 'update', reviewed: 'fp-1' });
    should((calls.staged.at(-1) as { decisions?: unknown }).decisions).deepEqual({ 'mcp/notes': 'take' });
  });

  it('V-0313 a choice for an item that does not differ is refused before anything is written', async () => {
    const { gateway, calls } = fakeGateway({ review: reviewOf({ items: [item('mcp/notes', 'theirs')] }) });
    const { deps } = depsOf(gateway);
    await expect(runClone(deps, 'f', bundle(), { mine: ['mcp/other'] })).rejects.toThrow(
      'nothing called mcp/other differs',
    );
    should(calls.staged).deepEqual([]);
  });

  it('V-0313 a login the daemon cannot match is never picked for the person', async () => {
    const login = { sourceId: 'work', outcome: 'ask', candidates: ['a', 'b'] };
    const { gateway, calls } = fakeGateway({ review: reviewOf({ logins: [login as never] }) });
    const { deps } = depsOf(gateway);
    await expect(runClone(deps, 'f', bundle(), {})).rejects.toThrow('could be more than one login here');
    await runClone(deps, 'f', bundle(), { login: ['work=a'], yes: true });
    should((calls.staged.at(-1) as { logins?: unknown }).logins).deepEqual({ work: 'a' });
    await expect(runClone(deps, 'f', bundle(), { login: ['work=zzz'] })).rejects.toThrow('pick one of a, b');
    await expect(runClone(deps, 'f', bundle(), { login: ['nope'] })).rejects.toThrow('--login takes');
  });

  it('V-0313 a review that went stale between the preview and the apply is said so, and nothing is changed', async () => {
    const { gateway } = fakeGateway({ review: reviewOf({ items: [item('mcp/notes', 'theirs')] }) });
    gateway.apply = async () => {
      throw new Error('Something changed since you reviewed. Review again.');
    };
    const { deps } = depsOf(gateway);
    await expect(runClone(deps, 'f', bundle(), { yes: true })).rejects.toThrow(
      'Nothing was changed. Run `fy machine clone <file> --dry-run`',
    );
  });

  it('V-0313 everything already here is said so and nothing is staged', async () => {
    const { gateway, calls } = fakeGateway({ review: reviewOf() });
    const { deps, text } = depsOf(gateway);
    await runClone(deps, 'f', bundle(), {});
    should(text()).containEql('Everything from desktop is already here. Nothing to copy.');
    should(calls.staged).deepEqual([]);
  });
});

describe('the machine verbs through the router, by row', () => {
  const allRoutes = () =>
    skeletonEntry(
      definePlugin({
        id: 'runtimes',
        title: 'Runtimes',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: ['command'],
        actions: {
          routes: Object.values(MACHINE_ROUTES).map(key =>
            route(key, { minimum: 'operator', audit: { skip: 't' }, guard: { none: 't' }, caller: 'any' }),
          ),
        },
      }),
      'h-runtimes',
    );

  const wired = (replies: unknown[]) => {
    const made = fakeWorld({
      registry: registryOf(allRoutes()),
      inventory: inventoryOf({ id: 'runtimes', contract: 'h-runtimes' }),
    });
    for (const body of replies) made.transport.replies.push({ status: 200, body });
    return {
      ...made,
      world: {
        ...made.world,
        prompt: { ask: async () => 'y' },
        readText: async (path: string) => Bun.file(path).text(),
      },
    };
  };

  const paths = (sent: readonly { method: string; path: string }[]) => sent.map(request => request.path);

  it('V-0316 fy machine set stages the one named field through the Runtimes routes (fails without the verb)', async () => {
    // The daemon's answers are not what is under test (the Runtimes tests own their shape): the verb must read the
    // machine and then STAGE exactly the one field named, through the declared route. Without the verb nothing is sent.
    const { world, transport } = wired([machineView(), machineView()]);
    await runFy(['machine', 'set', 'agent-permissions', 'skip', '--dry-run'], world);
    should(paths(transport.sent)).containEql('/v1/runtimes/proposals');
    const staged = transport.sent.find(request => request.path === '/v1/runtimes/proposals')?.body as {
      change: AccountChange;
    };
    should(staged.change).containEql({ kind: 'machine.settings', agentPermissions: 'skip', autoResume: true });
  });

  it('V-0316 fy machine set refuses a value the setting does not take, and sends nothing', async () => {
    const { world, io, transport } = wired([machineView()]);
    should(await runFy(['machine', 'set', 'agent-permissions', 'auto', 'skip'], world)).equal(1);
    should(io.stderr()).containEql('has no place for "skip"');
    should(transport.sent).deepEqual([]);
  });

  it('V-0316 a switch that took the next word as its value is refused, not read as off', async () => {
    const { world, io, transport } = wired([machineView()]);
    should(await runFy(['machine', 'set', 'auto-resume', '--yes', 'off'], world)).equal(1);
    should(io.stderr()).containEql('--yes is a switch and took "off" as its value');
    should(transport.sent).deepEqual([]);
  });

  it('V-0315 fy machine install shows the command and, with --dry-run, runs nothing (fails without the verb)', async () => {
    const scan = {
      machine: 'laptop',
      format: 'present',
      harnesses: [],
      runtimes: [],
      updates: [],
      duplicates: [],
      notes: [],
      importing: { available: true },
      tools: [
        {
          harness: 'codex',
          label: 'Codex',
          installed: false,
          install: { kind: 'runnable', command: 'npm install -g @openai/codex' },
        },
      ],
    };
    const { world, io, transport } = wired([machineView(), scan]);
    should(await runFy(['machine', 'install', 'codex', '--dry-run'], world)).equal(0);
    should(io.stdout()).containEql('Codex will be installed with: npm install -g @openai/codex');
    should(paths(transport.sent)).deepEqual(['/v1/runtimes/machine', '/v1/runtimes/setup/scan']);
  });

  it('V-0315 fy machine install --yes claude is refused: the switch would have swallowed the tool', async () => {
    const { world, io, transport } = wired([machineView()]);
    should(await runFy(['machine', 'install', '--yes', 'claude'], world)).equal(1);
    should(io.stderr()).containEql('--yes is a switch and took "claude"');
    should(transport.sent).deepEqual([]);
  });

  it('V-0313 the old variadic form --skip a b is refused whole: b is not silently applied, and nothing is sent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fy-clone-'));
    try {
      const file = join(dir, 'setup.json');
      await writeFile(file, JSON.stringify(bundle()));
      const { world, io, transport } = wired([machineView()]);
      should(await runFy(['machine', 'clone', file, '--skip', 'mcp/notes', 'hooks/guard', '--yes'], world)).equal(1);
      should(io.stderr()).containEql('has no place for "hooks/guard"');
      should(io.stderr()).containEql('--skip a --skip b');
      should(transport.sent).deepEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('V-0313 the repeated form --skip a --skip b is read as two items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fy-clone-'));
    try {
      const file = join(dir, 'setup.json');
      await writeFile(file, JSON.stringify(bundle()));
      const { world, io, transport } = wired([machineView()]);
      await runFy(['machine', 'clone', file, '--skip', 'mcp/notes', '--skip', 'hooks/guard', '--dry-run'], world);
      should(io.stderr()).not.containEql('has no place');
      should(paths(transport.sent)).containEql('/v1/runtimes/clone/review');
      should(optionList(parseArgs(['--skip', 'mcp/notes', '--skip', 'hooks/guard']), 'skip')).deepEqual([
        'mcp/notes',
        'hooks/guard',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
