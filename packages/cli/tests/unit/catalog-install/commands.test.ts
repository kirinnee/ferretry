import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerCatalogInstallCommands } from '../../../src/lib/catalog-install/commands.ts';
import { CatalogInstallController } from '../../../src/lib/catalog-install/controller.ts';
import {
  catalogFileText,
  FakeFiles,
  FakeGateway,
  FakeOutput,
  FakePrompt,
  INSTALL_ID,
  installOf,
  skillItem,
} from './support.ts';

function build(existingCatalog = false) {
  const gateway = new FakeGateway();
  const out = new FakeOutput();
  const controller = new CatalogInstallController({
    gateway,
    files: new FakeFiles(catalogFileText([skillItem()])),
    out,
    prompt: new FakePrompt(),
    interactive: false,
    cwd: '/work',
    binaryName: 'fy',
  });
  const program = new Command().exitOverride();
  if (existingCatalog) program.command('catalog').command('export');
  registerCatalogInstallCommands(program, controller);
  return { program, gateway, out };
}

describe('fy catalog commands', () => {
  it('should parse install with repeatable --bind and --unbound', async () => {
    const { program, gateway } = build();
    gateway.preview = {
      ...gateway.preview,
      secrets: [
        { placeholder: 'A', held: false },
        { placeholder: 'B', held: false },
      ],
    };

    await program.parseAsync(
      [
        'catalog',
        'install',
        'cat.json',
        '--project',
        'repo',
        '--harness',
        'claude',
        '--bind',
        'A=X',
        '--unbound',
        'B',
        '--older',
        '--yes',
      ],
      { from: 'user' },
    );

    should(gateway.applies[0]?.request.secretBindings).eql({ A: 'X', B: null });
    should(gateway.previews[0]?.request.allowOlder).be.true();
  });

  it('should add to an existing catalog command rather than make a second', () => {
    const { program } = build(true);
    should(program.commands.filter(command => command.name() === 'catalog')).have.length(1);
    should(program.commands[0]?.commands.map(command => command.name())).eql([
      'export',
      'install',
      'installs',
      'uninstall',
    ]);
  });

  it('should list and uninstall', async () => {
    const { program, gateway, out } = build();
    gateway.installs = [installOf('project')];
    await program.parseAsync(['catalog', 'installs'], { from: 'user' });
    await program.parseAsync(['catalog', 'uninstall', INSTALL_ID, '--yes'], { from: 'user' });
    should(out.reports[0]).containEql(INSTALL_ID);
    should(gateway.removes).have.length(1);
  });
});

describe('fy catalog install verbs and --json', () => {
  it('should take --json on the verb or on the shared catalog command', async () => {
    for (const argv of [
      ['catalog', 'installs', '--json'],
      ['catalog', '--json', 'installs'],
    ]) {
      const { program, gateway, out } = build();
      gateway.installs = [installOf('project')];
      await program.parseAsync(argv, { from: 'user' });
      should([argv.join(' '), JSON.parse(out.successes[0] ?? '{}').installs[0].installId]).eql([
        argv.join(' '),
        INSTALL_ID,
      ]);
    }
  });

  it('should print the human list without --json', async () => {
    const { program, gateway, out } = build();
    gateway.installs = [installOf('project')];
    await program.parseAsync(['catalog', 'installs'], { from: 'user' });
    should(out.successes).have.length(0);
    should(out.reports[0]).containEql(INSTALL_ID);
  });

  it('should pass --json through install and uninstall', async () => {
    const install = build();
    await install.program.parseAsync(
      ['catalog', 'install', 'cat.json', '--project', 'repo', '--harness', 'claude', '--yes', '--json'],
      { from: 'user' },
    );
    should(install.out.diagnostics).have.length(1);
    should(JSON.parse(install.out.successes[0] ?? '{}').install.installId).equal(INSTALL_ID);

    const remove = build();
    remove.gateway.installs = [installOf('runtime')];
    await remove.program.parseAsync(['catalog', 'uninstall', INSTALL_ID, '--yes', '--json'], { from: 'user' });
    should(JSON.parse(remove.out.successes[0] ?? '{}').installId).equal(INSTALL_ID);
  });
});
