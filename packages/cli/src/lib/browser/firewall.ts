import type { Command } from 'commander';

/** The two files a host admin installs, exactly as the repository ships them. */
export interface IFirewallFiles {
  readonly script: string;
  readonly unit: string;
}

/** Stdout, one line added to whatever is given — which is why the files each end in exactly one newline. */
export interface IFirewallOutput {
  report(message: string): void;
}

const withoutFinalNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text);

/**
 * `fy browser firewall script` and `fy browser firewall unit`: the loopback firewall's two files, printed
 * verbatim, so an admin whose `fy` came from brew or nix (no repository checkout) can install them.
 *
 * Mounted on the `browser` group, which must be registered first, and on its `firewall` subgroup when
 * another registration has already made it.
 */
export function registerFirewallCommands(program: Command, files: IFirewallFiles, output: IFirewallOutput): void {
  const browser = program.commands.find(command => command.name() === 'browser');
  if (browser === undefined) throw new Error('the browser command group must be registered before its firewall verbs');
  const firewall =
    browser.commands.find(command => command.name() === 'firewall') ??
    browser
      .command('firewall')
      .description('the loopback firewall a host admin installs on a shared Linux host; run by root, not by a user');

  firewall
    .command('script')
    .description(
      'print the root script that applies the firewall (install it as /usr/local/sbin/ferretry-loopback-firewall)',
    )
    .action(() => {
      output.report(withoutFinalNewline(files.script));
    });

  firewall
    .command('unit')
    .description(
      'print the systemd unit that runs it (install it as /etc/systemd/system/ferretry-loopback-firewall.service)',
    )
    .action(() => {
      output.report(withoutFinalNewline(files.unit));
    });
}
