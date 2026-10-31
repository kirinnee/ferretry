import type { Command } from 'commander';

/** The files a host admin installs, exactly as the repository ships them. */
export interface IFirewallFiles {
  readonly script: string;
  readonly unit: string;
  readonly verifyUnit: string;
  readonly timer: string;
}

/** Stdout, one line added to whatever is given — which is why the files each end in exactly one newline. */
export interface IFirewallOutput {
  report(message: string): void;
}

const withoutFinalNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text);

/**
 * `fy browser firewall script|unit|verify-unit|timer`: the loopback firewall's files, printed verbatim, so an
 * admin whose `fy` came from brew or nix (no repository checkout) can install them.
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

  const verbs: readonly (readonly [string, keyof IFirewallFiles, string])[] = [
    ['script', 'script', 'the root script (install it as /usr/local/sbin/ferretry-loopback-firewall)'],
    ['unit', 'unit', 'the systemd unit that applies it (/etc/systemd/system/ferretry-loopback-firewall.service)'],
    [
      'verify-unit',
      'verifyUnit',
      'the systemd unit that verifies it (/etc/systemd/system/ferretry-loopback-firewall-verify.service)',
    ],
    [
      'timer',
      'timer',
      'the systemd timer that runs the verify unit (/etc/systemd/system/ferretry-loopback-firewall-verify.timer)',
    ],
  ];
  for (const [verb, file, what] of verbs) {
    firewall
      .command(verb)
      .description(`print ${what}`)
      .action(() => {
        output.report(withoutFinalNewline(files[file]));
      });
  }
}
