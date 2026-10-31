import type { Command } from 'commander';
import type { CatalogInstallController } from './controller.ts';

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** Mounts `fy catalog install | installs | uninstall` on the shared `catalog` command, making it when absent. */
export function registerCatalogInstallCommands(program: Command, controller: CatalogInstallController): void {
  const catalog =
    program.commands.find(command => command.name() === 'catalog') ??
    program.command('catalog').description('shared catalogs of skills and MCP setups');
  catalog
    .command('install')
    .description('install one skill or MCP setup from a signed catalog file, after you review all of it')
    .argument('<file>', 'a catalog file')
    .option('--item <name>', 'which item to install (needed when the file carries several)')
    .option('--project <root>', 'install into this project folder')
    .option('--harness <harness>', 'claude or codex: which agent CLI the project is for')
    .option('--runtime <name>', 'install into this runtime')
    .option('--profile <name>', 'the runtime profile that gets it')
    .option('--bind <placeholder=secret>', 'fill a placeholder with one of YOUR secrets (repeatable)', collect, [])
    .option('--unbound <placeholder>', 'leave a placeholder unfilled (repeatable)', collect, [])
    .option('--older', 'allow installing an older version than the one installed')
    .option('--yes', 'do not ask before installing')
    .action(async (file: string, options) => {
      await controller.install(file, options);
    });
  catalog
    .command('installs')
    .description('list what is installed from catalogs, and where')
    .action(async () => {
      await controller.installs();
    });
  catalog
    .command('uninstall')
    .description('remove one install, and only the files it wrote')
    .argument('<installId>', 'an install id from "catalog installs"')
    .option('--yes', 'do not ask before removing')
    .action(async (installId: string, options) => {
      await controller.uninstall(installId, options);
    });
}
