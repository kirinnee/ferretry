import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerSetupCommands, renderHarnessScan, runImport, runSetup } from '../../../src/lib/setup/commands.ts';
import { authorityOf, fakeWorld, machine, runCommand, scan } from '../fleet/account-fakes.ts';

const bothInstalled = () =>
  scan({
    tools: [
      { harness: 'claude', label: 'Claude Code', installed: true },
      { harness: 'codex', label: 'Codex', installed: true },
    ],
    harnesses: [
      { ...scan().harnesses[0], harness: 'claude' } as never,
      { ...scan().harnesses[1], harness: 'codex', installed: true } as never,
    ],
    runtimes: [
      { harness: 'claude', name: 'claude-default', profile: 'default' },
      { harness: 'codex', name: 'codex-default', profile: 'default' },
    ],
  });

describe('renderHarnessScan', () => {
  it('should say what was found, by name only', () => {
    const text = renderHarnessScan({
      harness: 'claude',
      installed: true,
      account: { state: 'refresh-due', reason: 'expires soon' },
      instructions: { name: 'main', source: '~/.claude/CLAUDE.md', bytes: 10 },
      settings: { source: '~/.claude/settings.json', count: 4, hooks: 1 },
      mcpServers: ['github'],
      skills: ['pr-review'],
      secretKeys: ['env.ANTHROPIC_API_KEY'],
      missingCommands: ['uvx'],
      problems: ['settings.json has a comment'],
    });
    should(text).match(/Your login: signed in \(expires soon\)/);
    should(text)
      .match(/Instructions: ~\/\.claude\/CLAUDE\.md/)
      .and.match(/4 setting\(s\), 1 hook\(s\)/);
    should(text)
      .match(/MCP servers: github/)
      .and.match(/Skills: pr-review/);
    should(text).match(/never copied as text: env\.ANTHROPIC_API_KEY/);
    should(text)
      .match(/Command not found on this machine: uvx/)
      .and.match(/Problem: settings\.json has a comment/);
    should(renderHarnessScan(scan().harnesses[0] as never)).match(/signed in as you@example\.com/);
    should(renderHarnessScan(scan().harnesses[1] as never))
      .match(/Your login: not signed in/)
      .and.not.match(/Instructions|Settings:/);
  });
});

/** A program with the `daemon` group the setup verbs mount onto, as `fy.ts` registers it first. */
const daemonGroup = (program: Command): void => {
  program.command('daemon');
};

describe('runSetup', () => {
  it('should refuse a script and name the no-questions verb', async () => {
    const world = fakeWorld({ interactive: false });
    await should(runSetup(world.deps, {})).be.rejectedWith(
      /needs a terminal\. In a script, run `fz daemon import claude` or `fz daemon import codex` instead\./,
    );
    should(world.gateway.called('stage')).be.empty();
  });

  it('should refuse when the machine takes no import yet, with the reason', async () => {
    const world = fakeWorld({
      gateway: { scan: () => scan({ importing: { available: false, reason: 'Account changes are switched off.' } }) },
    });
    await should(runSetup(world.deps, {})).be.rejectedWith('Account changes are switched off.');
  });

  it('should ask one question at a time: install, use each login and setup, then the runtime name', async () => {
    // Arrange: install Codex? yes. Use Claude? yes. Use Codex? no. Claude's name? work.
    let scans = 0;
    const world = fakeWorld({
      answers: ['y', '', 'n', 'work-claude'],
      gateway: {
        scan: () => (scans++ < 2 ? scan() : bothInstalled()),
        installTools: () => ({
          outcomes: [{ harness: 'codex', outcome: 'installed', command: 'npm i -g @openai/codex' }],
        }),
      },
    });

    // Act
    await runSetup(world.deps, {});

    // Assert
    should(world.prompt.questions).eql([
      'Codex is not installed. Install now? [Y/n]',
      'We found Claude Code on studio. Use your login and setup? [Y/n]',
      'We found Codex on studio. Use your login and setup? [Y/n]',
      'Name for the Claude Code runtime [claude-default]:',
    ]);
    should(world.gateway.called('installTools')[0]?.args[0]).eql(['codex']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'setup.import',
      include: ['claude'],
      names: { claude: 'work-claude' },
    });
    should(world.out.text('report')).match(/fz runtimes/);
  });

  it('should say a login that is not signed in can still be imported, and name the sign-in after', async () => {
    // Arrange: both installed; Codex's own login is not signed in.
    const notSignedIn = bothInstalled();
    const world = fakeWorld({
      answers: ['n', 'y', ''],
      gateway: { scan: () => ({ ...notSignedIn, format: 'version-2' }) },
    });

    // Act
    await runSetup(world.deps, {});

    // Assert — no tools question on a machine that already has a setup.
    should(world.prompt.questions[0]).equal('We found Claude Code on studio. Use your login and setup? [Y/n]');
    should(world.out.text('report'))
      .match(/Your Codex login is not signed in\. You can still import it, and sign in afterwards\./)
      .and.match(
        /Codex is not signed in yet: find its login with `fz credentials`, then run `fz credential signin <login>`/,
      );
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'setup.import', include: ['codex'] });
  });

  it('should keep a suggested name when the answer is blank, and skip installing on a dry run', async () => {
    const world = fakeWorld({
      answers: ['', ''],
      gateway: { scan: () => scan({ notes: [{ harness: 'claude', text: 'CLAUDE.md and AGENTS.md match.' }] }) },
    });
    await runSetup(world.deps, { dryRun: true });
    should(world.gateway.called('installTools')).be.empty();
    should(world.out.text('report'))
      .match(/Claude Code: CLAUDE\.md and AGENTS\.md match\./)
      .and.match(/Dry run/);
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'setup.import', include: ['claude'] });
  });

  it('should not install when the person says no', async () => {
    const world = fakeWorld({ answers: ['n', 'y', ''] });
    await runSetup(world.deps, {});
    should(world.gateway.called('installTools')).be.empty();
  });

  it('should end with a clear "nothing set up yet" and the way back when everything is skipped', async () => {
    const world = fakeWorld({ answers: ['n', 'n'] });
    await runSetup(world.deps, {});
    should(world.gateway.called('stage')).be.empty();
    should(world.out.exitCode).be.undefined();
    should(world.out.text('report')).match(
      /Nothing was set up, so studio has no runtimes yet\. Run `fz daemon setup` again when you are ready, or finish in the app\./,
    );
  });

  it('should say nothing changed when Import again chooses nothing', async () => {
    const world = fakeWorld({ answers: ['n'], gateway: { scan: () => scan({ format: 'version-2' }) } });
    await runSetup(world.deps, {});
    should(world.out.text('report')).match(/Nothing was imported\. Your runtimes are unchanged\./);
  });

  it('should offer each changed component on Import again and add only those chosen', async () => {
    // Arrange
    const world = fakeWorld({
      answers: ['y', 'y', 'n'],
      gateway: {
        scan: () =>
          scan({
            format: 'version-2',
            runtimes: [],
            updates: [
              { reference: 'instructions/main', sources: ['~/.claude/CLAUDE.md'] },
              { reference: 'mcp/github', sources: ['~/.claude.json'] },
            ],
            duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
          }),
      },
    });

    // Act
    await runSetup(world.deps, {});

    // Assert
    should(world.prompt.questions.slice(1)).eql([
      'instructions/main changed in ~/.claude/CLAUDE.md since the last import. Update it? [y/N]',
      'mcp/github changed in ~/.claude.json since the last import. Update it? [y/N]',
    ]);
    should(world.out.text('report')).match(
      /claude-default already uses that Claude Code login and profile, so no new runtime is added\./,
    );
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'setup.import',
      include: ['claude'],
      acceptedUpdates: ['instructions/main'],
    });
  });

  it('should take an update alone when no tool is chosen', async () => {
    const world = fakeWorld({
      answers: ['n', 'y'],
      gateway: { scan: () => scan({ format: 'version-2', updates: [{ reference: 'mcp/x', sources: ['y'] }] }) },
    });
    await runSetup(world.deps, { json: true });
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'setup.import',
      include: [],
      acceptedUpdates: ['mcp/x'],
    });
    should(world.out.text('report')).not.match(/fz runtimes/);
  });

  it('should refuse a caller that needs a passkey confirmation before it scans or stages anything', async () => {
    const world = fakeWorld({
      gateway: {
        machine: () => machine({ authority: authorityOf({ mayApply: false, applyRefusal: 'step-up-required' }) }),
      },
    });
    await should(runSetup(world.deps, {})).be.rejectedWith(/passkey confirmation/);
    should(world.gateway.called('scan')).be.empty();
    should(world.gateway.called('stage')).be.empty();
  });
});

describe('runImport', () => {
  it('should import one tool with no questions, under the suggested name', async () => {
    const world = fakeWorld({ interactive: false });
    await runImport(world.deps, 'claude', {});
    should(world.prompt.questions).be.empty();
    should(world.gateway.called('installTools')).be.empty();
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'setup.import', include: ['claude'] });
    should(world.out.text('report')).match(/fz runtimes/);
  });

  it('should take --name for the runtime it creates', async () => {
    const world = fakeWorld({ interactive: false, gateway: { scan: bothInstalled } });
    await runImport(world.deps, 'Codex', { name: 'codex-smoke' });
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'setup.import',
      include: ['codex'],
      names: { codex: 'codex-smoke' },
    });
  });

  it('should refuse a tool that is not installed, naming the install command, and install nothing', async () => {
    const world = fakeWorld({ interactive: false });
    await should(runImport(world.deps, 'codex', {})).be.rejectedWith(
      'Codex is not installed on studio. Install it with `fz machine install codex`, then import it.',
    );
    should(world.gateway.called('installTools')).be.empty();
    should(world.gateway.called('stage')).be.empty();
  });

  it('should refuse a tool it does not know', async () => {
    await should(runImport(fakeWorld().deps, 'gemini', {})).be.rejectedWith(/use claude or codex/);
  });

  it('should say when the login and profile already have a runtime', async () => {
    const world = fakeWorld({
      interactive: false,
      gateway: { scan: () => scan({ duplicates: [{ harness: 'claude', existing: 'mine', suggested: 'mine-2' }] }) },
    });
    await runImport(world.deps, 'claude', { json: true });
    should(world.out.text('report'))
      .match(/mine already uses that Claude Code login and profile, so no new runtime is added\./)
      .and.not.match(/fz runtimes/);
  });
});

describe('registerSetupCommands', () => {
  it('should mount setup and import onto the daemon group, with their flags after the verb', async () => {
    const world = fakeWorld({ interactive: false });
    await runCommand(
      registerSetupCommands,
      world,
      ['daemon', 'import', 'claude', '--name', 'claude-auto-smoke'],
      daemonGroup,
    );
    await should(
      runCommand(registerSetupCommands, world, ['daemon', 'setup', '--dry-run'], daemonGroup),
    ).be.rejectedWith(/needs a terminal/);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'setup.import', include: ['claude'], names: { claude: 'claude-auto-smoke' } },
    ]);
  });

  it('should run setup at a terminal', async () => {
    const world = fakeWorld({ answers: ['n', 'y', ''] });
    await runCommand(registerSetupCommands, world, ['daemon', 'setup'], daemonGroup);
    should(world.gateway.called('stage')).have.length(1);
  });

  it('should refuse to mount without the daemon group, and leave no top-level setup', () => {
    const program = new Command();
    should(() => registerSetupCommands(program, fakeWorld().deps)).throw(/daemon command group/);
    should(program.commands).be.empty();
  });
});
