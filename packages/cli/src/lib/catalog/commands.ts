import type { Command } from 'commander';
import type {
  CatalogAddOptions,
  CatalogCommandOptions,
  CatalogConfirmedOptions,
  CatalogController,
  CatalogCreateOptions,
  CatalogExportOptions,
} from './controller.ts';

const OVERVIEW = `A catalog is a set of skills and MCP setups you publish from this machine. Each add
FREEZES a copy; "publish" freezes a newer one. "export" writes a signed file someone else can install.

  fy catalog create "Team tools"
  fy catalog add "Team tools" --skill ~/.claude/skills/review/SKILL.md
  fy catalog add "Team tools" --mcp github
  fy catalog export "Team tools"`;

const JSON_HELP = 'print the protocol payload instead of the human rendering';
const YES_HELP = 'skip the y/N question; required when not on a terminal';

const collect = (value: string, previous: readonly string[] | undefined): readonly string[] => [
  ...(previous ?? []),
  value,
];

/**
 * Mounts `fy catalog …` onto the program.
 *
 * `ls` is the default verb. Each verb is one block below, so a new one (the install side lives in its
 * own file) is added without touching the others.
 */
export function registerCatalogCommands(program: Command, controller: CatalogController): void {
  const catalog = program
    .command('catalog')
    .alias('catalogs')
    .description('publish skills and MCP setups as a catalog, and export it as a signed file')
    .option('--json', JSON_HELP)
    .addHelpText('after', `\n${OVERVIEW}`);

  const merged = <T extends CatalogCommandOptions>(command: Command): T => ({
    ...(catalog.opts() as T),
    ...(command.opts() as T),
  });

  catalog
    .command('ls', { isDefault: true })
    .alias('list')
    .description('every catalog on this machine, with its items')
    .option('--json', JSON_HELP)
    .action(async (_flags: unknown, command: Command) => {
      await controller.list(merged(command));
    });

  catalog
    .command('create')
    .description('make an empty catalog')
    .argument('<name>', 'what people will see it called')
    .option('--description <text>', 'a line about what it is for')
    .option('--json', JSON_HELP)
    .action(async (name: string, _flags: unknown, command: Command) => {
      await controller.create(name, merged<CatalogCreateOptions>(command));
    });

  catalog
    .command('rename')
    .description("change a catalog's name")
    .argument('<catalog>', 'the catalog id or name')
    .argument('<name>', 'the new name')
    .option('--json', JSON_HELP)
    .action(async (name: string, newName: string, _flags: unknown, command: Command) => {
      await controller.rename(name, newName, merged(command));
    });

  catalog
    .command('describe')
    .description("change a catalog's description")
    .argument('<catalog>', 'the catalog id or name')
    .argument('<description>', 'the new description')
    .option('--json', JSON_HELP)
    .action(async (name: string, description: string, _flags: unknown, command: Command) => {
      await controller.describe(name, description, merged(command));
    });

  catalog
    .command('rm')
    .alias('remove')
    .description('delete a catalog and every version in it')
    .argument('<catalog>', 'the catalog id or name')
    .option('-y, --yes', YES_HELP)
    .option('--json', JSON_HELP)
    .action(async (name: string, _flags: unknown, command: Command) => {
      await controller.remove(name, merged<CatalogConfirmedOptions>(command));
    });

  catalog
    .command('add')
    .description('freeze a skill or an MCP setup into a catalog, after showing you all of it')
    .argument('<catalog>', 'the catalog id or name')
    .option('--skill <source>', 'a SKILL.md path from the skills inventory, or a skill name')
    .option('--mcp <source>', 'an MCP inventory server id, or a server name')
    .option('--summary <text>', "your own words for what it does, instead of the skill's description")
    .option('-y, --yes', YES_HELP)
    .option('--json', JSON_HELP)
    .action(async (name: string, _flags: unknown, command: Command) => {
      await controller.add(name, merged<CatalogAddOptions>(command));
    });

  catalog
    .command('publish')
    .description("freeze the item's source as its next version, after showing you all of it")
    .argument('<catalog>', 'the catalog id or name')
    .argument('<item>', 'the item id or name')
    .option('-y, --yes', YES_HELP)
    .option('--json', JSON_HELP)
    .action(async (name: string, item: string, _flags: unknown, command: Command) => {
      await controller.publish(name, item, merged<CatalogConfirmedOptions>(command));
    });

  catalog
    .command('withdraw')
    .description('take an item out of the catalog; installers are told it is gone')
    .argument('<catalog>', 'the catalog id or name')
    .argument('<item>', 'the item id or name')
    .option('-y, --yes', YES_HELP)
    .option('--json', JSON_HELP)
    .action(async (name: string, item: string, _flags: unknown, command: Command) => {
      await controller.withdraw(name, item, merged<CatalogConfirmedOptions>(command));
    });

  catalog
    .command('export')
    .description('write the catalog as a signed file')
    .argument('<catalog>', 'the catalog id or name')
    .option(
      '--item <item>',
      'carry only this item in the file (repeat for more). The signed list still names every live item, and the ask above shows them',
      collect,
    )
    .option('--out <file>', 'where to write it; <catalog-name>.catalog.json in this directory otherwise')
    .option('--force', 'replace the file if it is already there')
    .option(
      '-y, --yes',
      'sign without asking; the list of what is signed is still printed. Required when not on a terminal',
    )
    .option('--json', JSON_HELP)
    .action(async (name: string, _flags: unknown, command: Command) => {
      await controller.export(name, merged<CatalogExportOptions>(command));
    });
}
