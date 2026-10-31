import type { Command } from 'commander';
import type { ConfirmedShareOptions, ShareController, ShareMintOptions } from './controller.ts';

const JSON_HELP = 'print the protocol payload instead of the human rendering';
const YES_HELP = 'skip the y/N question; required when not on a terminal';

const SHARE_HELP = `Sharing mints a link. Whoever opens it joins as the person you name and can read the catalogs you list.
The link is printed ONCE, with a QR; it cannot be shown again.

  fy catalog share "Team tools" --member "Sam" --expires 1h
  fy catalog share "Team tools" --to Sam --expires 15m
  fy catalog shares
  fy catalog unshare shr_…`;

/**
 * Mounts `fy catalog share|shares|unshare` and `fy member …`.
 *
 * `catalog` may already exist (the publisher half makes it), so the verbs hang off whichever made it first.
 */
export function registerShareCommands(program: Command, controller: ShareController): void {
  const catalog = program.commands.find(command => command.name() === 'catalog') ?? program.command('catalog');
  // The group may own `--json` and then takes it from anywhere after `catalog`; read both so neither hides it.
  const merged = <T extends object>(flags: T): T => ({ ...(catalog.opts() as T), ...flags });

  catalog
    .command('share')
    .description('make a link that lets a person read one or more catalogs; shown once')
    .argument('<catalog...>', 'the catalog ids or names to share')
    .option('--member <name>', 'a new person, named by you')
    .option('--to <person>', 'a person who has already joined: id or name')
    .requiredOption('--expires <time>', 'how long the link lives: 15m, 1h, 3h, 8h or 1d')
    .option('--multi', 'let several browsers use the link (it makes its own person; needs --member)')
    .option('--cap <count>', 'with --multi, the most browsers that may join (2 to 200)')
    .option('--large', 'draw the QR at full size, for a camera that will not focus on the compact one')
    .option('--json', JSON_HELP)
    .addHelpText('after', `\n${SHARE_HELP}`)
    .action(async (catalogs: readonly string[], flags: ShareMintOptions) => {
      await controller.share(catalogs, merged(flags));
    });

  catalog
    .command('shares')
    .description('every share and how it stands; a code is never shown')
    .option('--json', JSON_HELP)
    .action(async (flags: { json?: boolean }) => {
      await controller.shares(merged(flags));
    });

  catalog
    .command('unshare')
    .description('end a share so its code stops working')
    .argument('<share>', 'the share id')
    .option('--json', JSON_HELP)
    .action(async (shareId: string, flags: { json?: boolean }) => {
      await controller.unshare(shareId, merged(flags));
    });

  const member = program
    .command('member')
    .alias('members')
    .description('the people catalogs are shared with, and their browsers')
    .addHelpText('after', '\n  fy member ls\n  fy member revoke Sam');

  member
    .command('ls', { isDefault: true })
    .alias('list')
    .description('everyone who has joined, with their catalogs and browsers')
    .option('--json', JSON_HELP)
    .action(async (flags: { json?: boolean }) => {
      await controller.members(merged(flags));
    });

  member
    .command('rename')
    .description("change a person's name")
    .argument('<member>', 'the person id or name')
    .argument('<name>', 'the new name')
    .option('--json', JSON_HELP)
    .action(async (who: string, name: string, flags: { json?: boolean }) => {
      await controller.rename(who, name, flags);
    });

  member
    .command('revoke')
    .description('remove a person: their browsers are signed out and their shares end')
    .argument('<member>', 'the person id or name')
    .option('-y, --yes', YES_HELP)
    .option('--json', JSON_HELP)
    .action(async (who: string, flags: ConfirmedShareOptions) => {
      await controller.revoke(who, flags);
    });

  member
    .command('forget-key')
    .description("remove one of a person's browsers; their others keep working")
    .argument('<member>', 'the person id or name')
    .argument('<key>', 'the browser id (mk_…) or the name it gave itself')
    .option('-y, --yes', YES_HELP)
    .option('--json', JSON_HELP)
    .action(async (who: string, key: string, flags: ConfirmedShareOptions) => {
      await controller.forgetKey(who, key, flags);
    });

  member
    .command('take')
    .description('stop a person reading one catalog')
    .argument('<member>', 'the person id or name')
    .argument('<catalog>', 'the catalog id or name')
    .option('-y, --yes', YES_HELP)
    .option('--json', JSON_HELP)
    .action(async (who: string, target: string, flags: ConfirmedShareOptions) => {
      await controller.take(who, target, flags);
    });
}
