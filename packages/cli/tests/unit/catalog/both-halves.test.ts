import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerCatalogInstallCommands } from '../../../src/lib/catalog-install/commands';
import { CatalogInstallController } from '../../../src/lib/catalog-install/controller';
import { registerCatalogCommands } from '../../../src/lib/catalog/commands';
import { CatalogController } from '../../../src/lib/catalog/controller';
import {
  catalogFileText,
  FakeFiles,
  FakeGateway as InstallGateway,
  FakeOutput,
  FakePrompt,
  skillItem,
} from '../catalog-install/support';
import { CapturingOutput, CWD, FakeGateway, MemoryFiles, ScriptedPrompt } from './fixtures';

type Order = 'publisher first' | 'installer first';

function build(order: Order) {
  const gateway = new FakeGateway();
  const out = new CapturingOutput();
  const installOut = new FakeOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const publisher = (): void =>
    registerCatalogCommands(
      program,
      new CatalogController(gateway, out, new ScriptedPrompt([]), new MemoryFiles(), false, CWD),
    );
  const installer = (): void =>
    registerCatalogInstallCommands(
      program,
      new CatalogInstallController({
        gateway: new InstallGateway(),
        files: new FakeFiles(catalogFileText([skillItem()])),
        out: installOut,
        prompt: new FakePrompt(),
        interactive: false,
        cwd: '/work',
        binaryName: 'fy',
      }),
    );
  if (order === 'publisher first') {
    publisher();
    installer();
  } else {
    installer();
    publisher();
  }
  return { program, out, installOut };
}

describe.each<Order>(['publisher first', 'installer first'])('both halves of fy catalog, %s', order => {
  it('should register one catalog command holding every verb of both halves', () => {
    const { program } = build(order);
    const roots = program.commands.filter(command => command.name() === 'catalog');
    should(roots).have.length(1);
    const verbs = (roots[0] as Command).commands.map(command => command.name());
    should(verbs.sort()).eql(
      [
        'add',
        'create',
        'describe',
        'export',
        'install',
        'installs',
        'ls',
        'publish',
        'rename',
        'rm',
        'uninstall',
        'withdraw',
      ].sort(),
    );
    should(new Set(verbs).size).equal(verbs.length);
  });

  it('should answer to the plural alias for a publisher verb and an installer verb', async () => {
    const { program, out, installOut } = build(order);
    await program.parseAsync(['node', 'fy', 'catalogs', 'ls']);
    should(out.text).containEql('Team tools');
    await program.parseAsync(['node', 'fy', 'catalogs', 'installs']);
    should(installOut.reports.length + installOut.successes.length).be.above(0);
  });

  it('should keep --json working on the publisher verbs', async () => {
    const { program, out } = build(order);
    await program.parseAsync(['node', 'fy', 'catalog', 'ls', '--json']);
    should(() => JSON.parse(out.text)).not.throw();
  });
});
