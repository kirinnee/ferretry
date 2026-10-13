import { describe, it } from 'bun:test';
import should from 'should';
import { registerSetupCommands, renderHarnessScan, runSetup } from '../../../src/lib/setup/commands.ts';
import { fakeWorld, permissions, runCommand, scan } from '../fleet/account-fakes.ts';

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

describe('runSetup', () => {
  it('should refuse a script that did not say --yes', async () => {
    const world = fakeWorld({ interactive: false });
    await should(runSetup(world.deps, {}, false)).be.rejectedWith(/pass --yes/);
  });

  it('should refuse when the machine takes no import yet, with the reason', async () => {
    const world = fakeWorld({
      gateway: { scan: () => scan({ importing: { available: false, reason: 'Account changes are switched off.' } }) },
    });
    await should(runSetup(world.deps, { yes: true }, false)).be.rejectedWith('Account changes are switched off.');
  });

  it('should offer to install a missing tool, import, and name the runtime at a terminal', async () => {
    // Arrange: install Codex? yes. Import Claude? yes. Import Codex? no. Claude's name? work.
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
    await runSetup(world.deps, {}, false);

    // Assert
    should(world.prompt.questions).eql([
      'Codex is not installed. Install now? [Y/n]',
      'Import Claude Code? [Y/n]',
      'Import Codex? [Y/n]',
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

  it('should take every suggestion under --yes, honouring --skip and --name', async () => {
    const world = fakeWorld({ interactive: false, gateway: { scan: bothInstalled } });
    await runSetup(world.deps, { yes: true, skip: ['codex'], name: ['claude=mine'] }, false);
    should(world.prompt.questions).be.empty();
    should(world.gateway.called('installTools')).be.empty();
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'setup.import',
      include: ['claude'],
      names: { claude: 'mine' },
    });
  });

  it('should keep a suggested name when the answer is blank, and skip installing on a dry run', async () => {
    const world = fakeWorld({
      answers: ['', ''],
      gateway: { scan: () => scan({ notes: [{ harness: 'claude', text: 'CLAUDE.md and AGENTS.md match.' }] }) },
    });
    await runSetup(world.deps, { dryRun: true }, false);
    should(world.gateway.called('installTools')).be.empty();
    should(world.out.text('report'))
      .match(/Claude Code: CLAUDE\.md and AGENTS\.md match\./)
      .and.match(/Dry run/);
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'setup.import', include: ['claude'] });
  });

  it('should not install when the person says no', async () => {
    const world = fakeWorld({ answers: ['n', 'y', ''] });
    await runSetup(world.deps, {}, false);
    should(world.gateway.called('installTools')).be.empty();
  });

  it('should exit non-zero when nothing was chosen', async () => {
    const world = fakeWorld({ answers: ['n', 'n'] });
    await runSetup(world.deps, {}, false);
    should(world.gateway.called('stage')).be.empty();
    should(world.out.exitCode).equal(1);
    should(world.out.text('error')).match(/Nothing was imported/);
  });

  it('should offer each changed component on Import again and add only those chosen', async () => {
    // Arrange
    const world = fakeWorld({
      answers: ['y', '', 'y', 'n'],
      gateway: {
        scan: () =>
          scan({
            updates: [
              { reference: 'instructions/main', sources: ['~/.claude/CLAUDE.md'] },
              { reference: 'mcp/github', sources: ['~/.claude.json'] },
              { reference: 'skills/mine', sources: ['~/.claude/skills'] },
            ],
            duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
          }),
      },
    });

    // Act
    await runSetup(world.deps, { acceptUpdate: ['skills/mine'], addDuplicates: true }, true);

    // Assert
    should(world.prompt.questions.slice(2)).eql([
      'instructions/main changed in ~/.claude/CLAUDE.md since the last import. Update it? [y/N]',
      'mcp/github changed in ~/.claude.json since the last import. Update it? [y/N]',
    ]);
    should(world.out.text('report')).match(
      /claude-default already uses that Claude Code login and profile; adding claude-default-2 anyway\./,
    );
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'setup.import',
      include: ['claude'],
      acceptedUpdates: ['skills/mine', 'instructions/main'],
      addDuplicates: true,
    });
  });

  it('should never update a changed component under --yes unless it was named', async () => {
    const world = fakeWorld({
      interactive: false,
      gateway: {
        scan: () =>
          scan({
            updates: [{ reference: 'instructions/main', sources: ['x'] }],
            duplicates: [{ harness: 'claude', existing: 'a', suggested: 'a-2' }],
          }),
      },
    });
    await runSetup(world.deps, { yes: true, json: true }, true);
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'setup.import', include: ['claude'] });
    should(world.out.text('report'))
      .match(/no new runtime is added/)
      .and.not.match(/fz runtimes/);
  });

  it('should ask a caller off this machine for the operator password once, for the install and the import', async () => {
    const world = fakeWorld({
      answers: ['y', '', ''],
      gateway: {
        permissions: () => permissions({ mayApply: false, applyRefusal: 'locked', confirmation: 'operator-password' }),
        installTools: () => ({ outcomes: [{ harness: 'codex', outcome: 'installed', command: 'x' }] }),
      },
    });
    await runSetup(world.deps, {}, false);
    should(world.prompt.secrets).have.length(1);
    should(world.gateway.called('installTools')[0]?.args[1]).eql({
      unlock: 'unlock-token',
      password: 'operator-password-1',
    });
    should(world.gateway.called('apply')[0]?.args[1]).eql({ unlock: 'unlock-token', password: 'operator-password-1' });
  });

  it('should refuse a --name it cannot read', async () => {
    await should(runSetup(fakeWorld().deps, { name: ['claude'] }, false)).be.rejectedWith(/tool=name/);
  });
});

describe('registerSetupCommands', () => {
  it('should run the first run, and Import again with setup flags typed after the verb', async () => {
    const world = fakeWorld({ interactive: false });
    await runCommand(registerSetupCommands, world, ['setup', '--yes']);
    await runCommand(registerSetupCommands, world, [
      'setup',
      'import',
      '--yes',
      '--accept-update',
      'mcp/x',
      '--add-duplicates',
    ]);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'setup.import', include: ['claude'] },
      { kind: 'setup.import', include: ['claude'], acceptedUpdates: ['mcp/x'], addDuplicates: true },
    ]);
    should(world.gateway.called('installTools')).have.length(1);
  });
});
