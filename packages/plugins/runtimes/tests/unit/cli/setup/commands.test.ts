import { describe, it } from 'bun:test';
import should from 'should';
import { renderHarnessScan, renderScan } from '../../../../cli/lib/setup/commands.ts';
import { authorityOf, fakeWorld, machine, runVerb, scan } from '../fleet/account-fakes.ts';

const bothInstalled = () =>
  scan({
    tools: [
      { harness: 'claude-code', label: 'Claude Code', installed: true },
      { harness: 'codex', label: 'Codex', installed: true },
    ],
    harnesses: [
      { ...scan().harnesses[0], harness: 'claude-code' } as never,
      { ...scan().harnesses[1], harness: 'codex', installed: true } as never,
    ],
    runtimes: [
      { harness: 'claude-code', name: 'claude-default', profile: 'default' },
      { harness: 'codex', name: 'codex-default', profile: 'default' },
    ],
  });

describe('renderHarnessScan', () => {
  it('should say what was found, by name only', () => {
    const text = renderHarnessScan({
      harness: 'claude-code',
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

describe('renderScan', () => {
  it('should show each tool found, the one that is missing, and the runtime an import would make', () => {
    const text = renderScan(scan());
    should(text).match(/^Claude Code\n {2}Your login: signed in as you@example\.com/);
    should(text).match(/Codex is not installed; install it with: npm i -g @openai\/codex/);
    should(text).match(/An import would create:\n {2}claude-default {2}\(Claude Code, profile default\)/);
    should(text).not.match(/not possible/);
  });

  it('should hand over the manual command when no package manager is there', () => {
    const text = renderScan(
      scan({
        tools: [
          {
            harness: 'codex',
            label: 'Codex',
            installed: false,
            install: {
              kind: 'no-package-manager',
              reason: 'No package manager was found.',
              manualCommand: 'npm i -g x',
            },
          },
        ],
        harnesses: [],
        runtimes: [],
      }),
    );
    should(text).equal('Codex is not installed; No package manager was found. Install it by hand with: npm i -g x');
  });

  it('should say what changed since the last import, what is a duplicate, and why an import is not possible', () => {
    const text = renderScan(
      scan({
        updates: [{ reference: 'mcp/github', sources: ['~/.claude.json'] }],
        duplicates: [{ harness: 'claude-code', existing: 'mine', suggested: 'mine-2' }],
        notes: [{ harness: 'claude-code', text: 'CLAUDE.md and AGENTS.md match.' }],
        importing: { available: false, reason: 'Account changes are switched off.' },
      }),
    );
    should(text)
      .match(/mine already uses that Claude Code login and profile, so no new runtime would be added\./)
      .and.match(/mcp\/github changed in ~\/\.claude\.json since the last import\./)
      .and.match(/Claude Code: CLAUDE\.md and AGENTS\.md match\./)
      .and.match(/An import is not possible now: Account changes are switched off\./);
  });
});

describe('runtime scan', () => {
  it('should print the scan as words, or as JSON, and change nothing', async () => {
    const world = fakeWorld({ interactive: false });
    await runVerb(world, 'runtime scan');
    await runVerb(world, 'runtime scan', [], { json: true });
    should(world.out.lines[0]?.text).match(/^Claude Code/);
    should(JSON.parse(world.out.lines[1]?.text as string).machine).equal('studio');
    should(world.gateway.called('stage')).be.empty();
  });
});

describe('runtime import', () => {
  it('should import one tool with no questions, under the suggested name', async () => {
    const world = fakeWorld({ interactive: false });
    await runVerb(world, 'runtime import', ['claude']);
    should(world.prompt.questions).be.empty();
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'setup.import', include: ['claude-code'] });
    should(world.out.text('report')).match(/fz runtime ls/);
  });

  it('should take --name for the runtime it creates', async () => {
    const world = fakeWorld({ interactive: false, gateway: { scan: bothInstalled } });
    await runVerb(world, 'runtime import', ['Codex'], { name: 'codex-smoke' });
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'setup.import',
      include: ['codex'],
      names: { codex: 'codex-smoke' },
    });
  });

  it('should name the sign-in that a login which is not signed in still needs', async () => {
    const world = fakeWorld({
      interactive: false,
      gateway: { scan: () => ({ ...bothInstalled(), format: 'present' }) },
    });
    await runVerb(world, 'runtime import', ['codex']);
    should(world.out.text('report')).match(
      /Codex is not signed in yet: find its login with `fz login ls`, then run `fz login signin <login>` before you launch\./,
    );
  });

  it('should refuse a tool that is not installed, naming how to get it, and stage nothing', async () => {
    const world = fakeWorld({ interactive: false });
    await should(runVerb(world, 'runtime import', ['codex'])).be.rejectedWith(
      'Codex is not installed on studio. Install it with `fz onboard`, then import it.',
    );
    should(world.gateway.called('stage')).be.empty();
  });

  it('should refuse a tool it does not know, and one that was not named', async () => {
    await should(runVerb(fakeWorld(), 'runtime import', ['gemini'])).be.rejectedWith(/use claude or codex/);
    await should(runVerb(fakeWorld(), 'runtime import')).be.rejectedWith(/Say which tool/);
  });

  it('should refuse when the machine takes no import yet, with the reason', async () => {
    const world = fakeWorld({
      gateway: { scan: () => scan({ importing: { available: false, reason: 'Account changes are switched off.' } }) },
    });
    await should(runVerb(world, 'runtime import', ['claude'])).be.rejectedWith('Account changes are switched off.');
  });

  it('should say when the login and profile already have a runtime', async () => {
    const world = fakeWorld({
      interactive: false,
      gateway: {
        scan: () => scan({ duplicates: [{ harness: 'claude-code', existing: 'mine', suggested: 'mine-2' }] }),
      },
    });
    await runVerb(world, 'runtime import', ['claude'], { json: true });
    should(world.out.text('report'))
      .match(/mine already uses that Claude Code login and profile, so no new runtime is added\./)
      .and.not.match(/fz runtime ls/);
  });

  it('should refuse a caller that needs a passkey confirmation before it scans or stages anything', async () => {
    const world = fakeWorld({
      gateway: {
        machine: () => machine({ authority: authorityOf({ mayApply: false, applyRefusal: 'step-up-required' }) }),
      },
    });
    await should(runVerb(world, 'runtime import', ['claude'])).be.rejectedWith(/passkey confirmation/);
    should(world.gateway.called('scan')).be.empty();
    should(world.gateway.called('stage')).be.empty();
  });
});
