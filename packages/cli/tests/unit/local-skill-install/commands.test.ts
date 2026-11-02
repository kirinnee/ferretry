import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerLocalSkillInstallCommands } from '../../../src/lib/local-skill-install/commands.ts';
import { LocalSkillInstallController } from '../../../src/lib/local-skill-install/controller.ts';
import { FakeGateway, FakeOutput, FakePrompt, INSTALL_ID, installOf } from './support.ts';

function build(existingSkill = false) {
  const gateway = new FakeGateway();
  const out = new FakeOutput();
  const controller = new LocalSkillInstallController({
    gateway,
    out,
    prompt: new FakePrompt(),
    interactive: false,
    cwd: '/work',
    binaryName: 'fy',
  });
  const program = new Command().exitOverride();
  if (existingSkill) program.command('skill').option('--json').command('other');
  registerLocalSkillInstallCommands(program, controller);
  return { program, gateway, out };
}

describe('fy skill commands', () => {
  it('should parse install with its source, scope and target flags', async () => {
    const { program, gateway } = build();

    await program.parseAsync(
      ['skill', 'install', '--from', 'a/b', '--to', 'project', '--project', 'repo', '--harness', 'codex', '--yes'],
      { from: 'user' },
    );

    should(gateway.previews[0]?.request).eql({
      source: { path: '/work/a/b/SKILL.md' },
      target: { scope: 'project', projectRoot: '/work/repo', harness: 'codex' },
    });
    should(gateway.applies).have.length(1);
  });

  it('should reach a runtime copy, and share a skill command another half made', async () => {
    const { program, gateway } = build(true);

    await program.parseAsync(
      ['skill', 'install', '--from', '/s', '--to', 'runtime', '--runtime', 'r', '--profile', 'p', '--yes'],
      { from: 'user' },
    );

    should(gateway.previews[0]?.scope).equal('runtime');
  });

  it('should list and uninstall, honouring --json before the verb', async () => {
    const { program, gateway, out } = build();
    gateway.installs = [installOf()];

    await program.parseAsync(['skill', '--json', 'installs'], { from: 'user' });
    await program.parseAsync(['skill', 'uninstall', INSTALL_ID, '--yes'], { from: 'user' });

    should(JSON.parse(out.successes[0] ?? '{}').installs).have.length(1);
    should(gateway.removes).eql([{ scope: 'project', installId: INSTALL_ID }]);
  });

  it('should refuse an install without --from or --to', async () => {
    const { program } = build();

    await program.parseAsync(['skill', 'install', '--to', 'project'], { from: 'user' }).then(
      () => should.fail('expected a rejection', 'resolved'),
      error => should((error as Error).message).containEql('--from'),
    );
  });
});
