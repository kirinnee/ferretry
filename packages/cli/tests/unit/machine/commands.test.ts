import { describe, it } from 'bun:test';
import should from 'should';
import {
  installTools,
  parseCloneBundle,
  registerMachineCommands,
  renderInstallOutcome,
  renderMachine,
} from '../../../src/lib/machine/commands.ts';
import { bundle, fakeWorld, machine, runCommand, scan } from '../fleet/account-fakes.ts';

const noManager = scan({
  tools: [
    {
      harness: 'claude',
      label: 'Claude Code',
      installed: false,
      install: { kind: 'no-package-manager', reason: 'No npm here.', manualCommand: 'curl … | sh' },
    },
    {
      harness: 'codex',
      label: 'Codex',
      installed: false,
      install: { kind: 'runnable', command: 'npm i -g @openai/codex' },
    },
  ],
});

describe('renderMachine', () => {
  it('should show the machine, its tools and agent permissions', () => {
    const text = renderMachine(machine(), 'fz');
    should(text).match(/^studio\n {2}Setup: the account model, 2 runtime\(s\)/);
    should(text)
      .match(/Agent permissions: auto/)
      .and.match(/Default runtime for new agents: claude-default/)
      .and.match(/What agents may control: terminals on, browsers on, files on, settings off/)
      .and.match(/Claude Code: installed \(\/usr\/bin\/claude\)/)
      .and.match(/Codex: not installed/);
    should(text).not.match(/fz daemon setup/);
  });

  it('should say nothing of auto-resume for a daemon that predates it', () => {
    should(renderMachine(machine(), 'fz')).not.match(/Auto-resume/);
  });

  it('should show auto-resume and what the last restart resumed and could not', () => {
    const text = renderMachine(
      machine({
        autoResume: true,
        lastAutoResume: {
          at: '2026-10-21T08:00:00.000Z',
          resumed: 1,
          skipped: [{ sessionId: 's1', reason: 'its runtime is signed out' }],
        },
      }),
      'fz',
    );
    should(text)
      .match(/Auto-resume after restart: on/)
      .and.match(/Last restart: resumed 1 ferret \(2026-10-21T08:00:00.000Z\)/)
      .and.match(/Couldn't auto-resume s1: its runtime is signed out/);
    should(renderMachine(machine({ autoResume: false, lastAutoResume: null }), 'fz'))
      .match(/Auto-resume after restart: off/)
      .and.not.match(/Last restart/);
    should(
      renderMachine(
        machine({ autoResume: true, lastAutoResume: { at: '2026-10-21T08:00:00.000Z', resumed: 3, skipped: [] } }),
        'fz',
      ),
    ).match(/resumed 3 ferrets/);
    should(renderMachine(machine({ autoResume: true }), 'fz')).not.match(/Last restart/);
  });

  it('should say nothing of agenda mode for a daemon that predates it, and show the default otherwise', () => {
    should(renderMachine(machine(), 'fz')).not.match(/Agenda mode/);
    should(renderMachine(machine({ agendaMode: true }), 'fz')).match(/Agenda mode for new ferrets: on/);
    should(renderMachine(machine({ agendaMode: false }), 'fz')).match(/Agenda mode for new ferrets: off/);
  });

  it('should say when no default runtime resolves', () => {
    const text = renderMachine(
      machine({
        defaultRuntime: null,
        agentControl: { terminals: false, browsers: true, files: false, ferretrySettings: false },
      }),
      'fz',
    );
    should(text)
      .match(/Default runtime for new agents: none set, and no claude-default runtime exists yet/)
      .and.match(/What agents may control: terminals off, browsers on, files off/);
  });

  it('should say when it is not set up yet', () => {
    const fresh = renderMachine(
      machine({
        format: 'none',
        setUp: false,
        agentPermissions: 'skip',
        tools: [{ harness: 'claude', label: 'Claude Code', installed: true }],
      }),
      'fz',
    );
    should(fresh)
      .match(/Setup: not set up yet\n/)
      .and.match(/skip \(agents are never asked\)/)
      .and.match(/Claude Code: installed\n/);
    should(fresh).match(/Set it up with `fz daemon setup`, or pair a phone and finish in the app\./);
  });
});

describe('renderInstallOutcome', () => {
  it('should say how each install ended, with the command to run by hand on a failure', () => {
    should(renderInstallOutcome({ harness: 'claude', outcome: 'already-installed' })).equal(
      'Claude Code was already installed.',
    );
    should(renderInstallOutcome({ harness: 'codex', outcome: 'installed', command: 'npm i -g x' })).equal(
      'Codex is installed.',
    );
    should(
      renderInstallOutcome({
        harness: 'codex',
        outcome: 'failed',
        cause: 'needs-admin',
        reason: 'npm needs admin rights.',
        manualCommand: 'sudo npm i -g x',
      }),
    ).equal('Codex was not installed: npm needs admin rights.\n  Run it yourself: sudo npm i -g x');
  });
});

describe('installTools', () => {
  it('should show the command, ask, install and report', async () => {
    // Arrange
    const world = fakeWorld({
      answers: ['y'],
      gateway: {
        installTools: () => ({
          outcomes: [{ harness: 'codex', outcome: 'installed', command: 'npm i -g @openai/codex' }],
        }),
      },
    });

    // Act
    const ok = await installTools(world.deps, ['claude', 'codex'], {});

    // Assert
    should(ok).be.true();
    should(world.out.text('report'))
      .match(/Claude Code is already installed\./)
      .and.match(/Codex will be installed with: npm i -g @openai\/codex/);
    should(world.gateway.called('installTools')[0]?.args[0]).eql(['codex']);
    should(world.out.text('success')).equal('Codex is installed.');
  });

  it('should do nothing when every tool is there', async () => {
    const world = fakeWorld();
    should(await installTools(world.deps, ['claude'], {})).be.true();
    should(world.gateway.called('installTools')).be.empty();
  });

  it('should hand over the command when it cannot install, and exit non-zero', async () => {
    const world = fakeWorld({ gateway: { scan: () => noManager } });
    should(await installTools(world.deps, ['claude'], { yes: true })).be.false();
    should(world.out.text('warn')).match(
      /cannot be installed from here: No npm here\.\n {2}Run it yourself: curl … \| sh/,
    );
    should(world.out.exitCode).equal(1);
    should(world.gateway.called('installTools')).be.empty();
  });

  it('should stop after showing the command on a dry run or a "no"', async () => {
    const dry = fakeWorld();
    should(await installTools(dry.deps, ['codex'], { dryRun: true })).be.false();
    const no = fakeWorld({ answers: ['n'] });
    should(await installTools(no.deps, ['codex'], {})).be.false();
    should([...dry.gateway.called('installTools'), ...no.gateway.called('installTools')]).be.empty();
  });

  it('should exit non-zero when an install fails, or when one of two could not even start', async () => {
    const failed = fakeWorld({
      gateway: {
        installTools: () => ({
          outcomes: [
            {
              harness: 'codex',
              outcome: 'failed',
              cause: 'timed-out',
              reason: 'Too slow.',
              manualCommand: 'npm i -g x',
            },
          ],
        }),
      },
    });
    should(await installTools(failed.deps, ['codex'], { yes: true })).be.false();
    should(failed.out.text('error')).match(/Too slow\./);
    should(failed.out.exitCode).equal(1);

    const partly = fakeWorld({
      gateway: {
        scan: () => noManager,
        installTools: () => ({ outcomes: [{ harness: 'codex', outcome: 'installed', command: 'x' }] }),
      },
    });
    should(await installTools(partly.deps, ['claude', 'codex'], { yes: true })).be.false();
    should(partly.out.exitCode).equal(1);
  });
});

describe('parseCloneBundle', () => {
  it('should read an export and refuse anything that is not one', () => {
    should(parseCloneBundle(JSON.stringify(bundle()), 'setup.json').machine).equal('laptop');
    should(() => parseCloneBundle('{', 'setup.json')).throw('setup.json is not a setup export: it is not JSON.');
    should(() => parseCloneBundle('{"format":"other"}', 'x.json')).throw(/`machine export`/);
  });
});

describe('registerMachineCommands', () => {
  it('should show the machine, as words or JSON', async () => {
    const world = fakeWorld();
    await runCommand(registerMachineCommands, world, ['machine']);
    await runCommand(registerMachineCommands, world, ['machine', '--json']);
    should(world.out.lines[0]?.text).match(/^studio/);
    should(JSON.parse(world.out.lines[1]?.text as string).name).equal('studio');
  });

  it('should change agent permissions after a yes, restating the other two settings unchanged', async () => {
    const world = fakeWorld({ answers: ['y'] });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'agent-permissions', 'skip']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: 'claude-default',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
    });
    should(world.gateway.called('apply')).have.length(1);
    await should(runCommand(registerMachineCommands, world, ['machine', 'set', 'colour', 'blue'])).be.rejectedWith(
      /not a machine setting/,
    );
    await should(
      runCommand(registerMachineCommands, world, ['machine', 'set', 'agent-permissions', 'never']),
    ).be.rejectedWith(/auto or skip/);
  });

  it('should change the default runtime, or unset it back to automatic', async () => {
    const world = fakeWorld({ answers: ['y', 'y'] });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'default-runtime', 'claude-review']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: 'claude-review',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
    });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'default-runtime', 'automatic']);
    should(world.gateway.called('stage')[1]?.args[0]).eql({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
    });
    await should(runCommand(registerMachineCommands, world, ['machine', 'set', 'default-runtime', ''])).be.rejectedWith(
      /Name a runtime/,
    );
  });

  it('should switch one of what agents may control, and refuse an unknown kind or state', async () => {
    const world = fakeWorld({ answers: ['y'] });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'agent-control', 'terminals', 'off']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: 'claude-default',
      agentControl: { terminals: false, browsers: true, files: true, ferretrySettings: false },
    });
    await should(
      runCommand(registerMachineCommands, world, ['machine', 'set', 'agent-control', 'network', 'off']),
    ).be.rejectedWith(/terminals, browsers, files, settings/);
    await should(
      runCommand(registerMachineCommands, world, ['machine', 'set', 'agent-control', 'toString', 'on']),
    ).be.rejectedWith(/terminals, browsers, files, settings/);
    await should(
      runCommand(registerMachineCommands, world, ['machine', 'set', 'agent-control', 'terminals', 'maybe']),
    ).be.rejectedWith(/on or off/);
  });

  it('should switch agents’ control of Ferretry settings, which the setting word `settings` names', async () => {
    const world = fakeWorld({ answers: ['y', 'y'] });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'agent-control', 'settings', 'on']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: 'claude-default',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: true },
    });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'agent-control', 'settings', 'off']);
    should(world.gateway.called('stage')[1]?.args[0]).match({ agentControl: { ferretrySettings: false } });
  });

  it('should switch auto-resume on or off, and refuse anything else', async () => {
    const world = fakeWorld({ answers: ['y', 'y'] });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'auto-resume', 'off']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: 'claude-default',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
      autoResume: false,
    });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'auto-resume', 'on']);
    should(world.gateway.called('stage')[1]?.args[0]).match({ autoResume: true });
    await should(
      runCommand(registerMachineCommands, world, ['machine', 'set', 'auto-resume', 'maybe']),
    ).be.rejectedWith(/on or off/);
  });

  it('should switch the agenda-mode default on or off, and refuse anything else', async () => {
    const world = fakeWorld({ answers: ['y', 'y'] });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'agenda-mode', 'off']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: 'claude-default',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
      agendaMode: false,
    });
    await runCommand(registerMachineCommands, world, ['machine', 'set', 'agenda-mode', 'on']);
    should(world.gateway.called('stage')[1]?.args[0]).match({ agendaMode: true });
    await should(
      runCommand(registerMachineCommands, world, ['machine', 'set', 'agenda-mode', 'maybe']),
    ).be.rejectedWith(/on or off/);
  });

  it('should list settings in what agents may control, on or off', () => {
    const on = renderMachine(
      machine({ agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: true } }),
      'fz',
    );
    should(on).match(/What agents may control: terminals on, browsers on, files on, settings on/);
  });

  it('should install the named tools once each', async () => {
    const world = fakeWorld();
    await runCommand(registerMachineCommands, world, ['machine', 'install', 'codex', 'Codex', '--yes']);
    should(world.gateway.called('installTools')[0]?.args[0]).eql(['codex']);
  });

  it('should export the setup as JSON', async () => {
    const world = fakeWorld();
    await runCommand(registerMachineCommands, world, ['machine', 'export']);
    should(JSON.parse(world.out.text('report')).format).equal('ferretry-clone');
  });

  it('should clone alongside without asking, and replace only after a yes', async () => {
    // Arrange
    const world = fakeWorld({ answers: ['y'], files: { 'setup.json': JSON.stringify(bundle()) } });

    // Act
    await runCommand(registerMachineCommands, world, ['machine', 'clone', 'setup.json']);
    await runCommand(registerMachineCommands, world, ['machine', 'clone', 'setup.json', '--replace']);
    await runCommand(registerMachineCommands, world, ['machine', 'clone', 'setup.json', '--json']);

    // Assert
    const staged = world.gateway
      .called('stage')
      .map(call => call.args[0] as { mode: string; bundle: { machine: string } });
    should(staged.map(change => change.mode)).eql(['alongside', 'replace', 'alongside']);
    should(staged[0]?.bundle.machine).equal('laptop');
    should(world.prompt.questions).have.length(1);
    should(world.out.lines.filter(line => line.text.includes('fz credentials'))).have.length(2);
  });

  it('should ask before a copy that brings a command to run here, and not once every such piece is skipped', async () => {
    // Arrange
    const runs = { ...bundle(), components: { ...bundle().components, mcp: { notes: { command: 'npx' } } } };
    const world = fakeWorld({ answers: ['n'], files: { 'setup.json': JSON.stringify(runs) } });

    // Act
    await runCommand(registerMachineCommands, world, ['machine', 'clone', 'setup.json']);
    await runCommand(registerMachineCommands, world, ['machine', 'clone', 'setup.json', '--skip', 'mcp/notes']);

    // Assert
    should(world.prompt.questions).have.length(1);
    const staged = world.gateway.called('stage').map(call => call.args[0] as { skip?: string[] });
    should(staged.map(change => change.skip)).eql([undefined, ['mcp/notes']]);
    should(world.gateway.called('apply')).have.length(1);
  });
});
