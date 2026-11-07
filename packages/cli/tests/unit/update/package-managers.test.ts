import { describe, it } from 'bun:test';
import should from 'should';
import { CommandPackageManagers } from '../../../src/adapters/update/package-managers';

const TAP = 'kirinnee/ferretry';
const URL = 'https://github.com/kirinnee/ferretry';

/** A fake brew: answers `brew tap` with `taps`, fails any command in `failing`, records every argv. */
function fakeBrew(taps: string, failing: readonly string[] = []) {
  const ran: string[] = [];
  const managers = new CommandPackageManagers(argv => {
    const command = argv.join(' ');
    ran.push(command);
    if (failing.includes(command)) return Promise.resolve({ code: 1, stdout: '', stderr: `${command} broke` });
    return Promise.resolve({ code: 0, stdout: command === 'brew tap' ? taps : '', stderr: '' });
  });
  return { ran, managers };
}

describe('CommandPackageManagers', () => {
  it('runs exactly the commands an update is allowed, as the user', async () => {
    const { ran, managers } = fakeBrew(`homebrew/core\n${TAP}\n`);
    await managers.brewRefresh(TAP, URL);
    await managers.brewUpgrade('ferretry');
    await managers.nixProfileUpgrade('ferretry');
    await managers.nixProfileRollback();
    await managers.nixProfileInstall('github:kirinnee/ferretry');
    should(ran).deepEqual([
      'brew tap',
      'brew update',
      'brew upgrade --cask ferretry',
      'nix --extra-experimental-features nix-command flakes profile upgrade --refresh ferretry',
      'nix --extra-experimental-features nix-command flakes profile rollback',
      'nix --extra-experimental-features nix-command flakes profile install --refresh github:kirinnee/ferretry',
    ]);
    should(ran.some(command => command.includes('sudo'))).be.false();
  });

  it('taps the repository first when the tap is gone, then updates', async () => {
    const { ran, managers } = fakeBrew('homebrew/core\n');
    should((await managers.brewRefresh(TAP, URL)).code).equal(0);
    should(ran).deepEqual(['brew tap', `brew tap ${TAP} ${URL}`, 'brew update']);
  });

  it('stops and reports when the tap cannot be added', async () => {
    const { ran, managers } = fakeBrew('', [`brew tap ${TAP} ${URL}`]);
    should((await managers.brewRefresh(TAP, URL)).code).equal(1);
    should(ran).deepEqual(['brew tap', `brew tap ${TAP} ${URL}`]);
  });

  it('still updates when it cannot list taps, and surfaces a failing update', async () => {
    const { ran, managers } = fakeBrew('', ['brew tap', 'brew update']);
    should((await managers.brewRefresh(TAP, URL)).code).equal(1);
    should(ran).deepEqual(['brew tap', 'brew update']);
  });
});

describe('CommandPackageManagers — watched', () => {
  const nix = (event: object): string => `@nix ${JSON.stringify(event)}`;

  it('asks nix for its events only when someone is watching, and reports them as they arrive', async () => {
    const argvs: string[][] = [];
    const managers = new CommandPackageManagers(async (argv, onLine) => {
      argvs.push([...argv]);
      const lines = [
        nix({ action: 'start', id: 1, type: 103, text: 'copying' }),
        nix({ action: 'result', id: 1, type: 105, fields: [0, 3, 0, 0] }),
        nix({ action: 'msg', level: 0, msg: 'error: attribute missing' }),
        'trailing plain line',
      ];
      for (const line of lines) onLine?.(line);
      return await Promise.resolve({ code: 1, stdout: '', stderr: `${lines.join('\n')}\n` });
    });
    const seen: string[] = [];
    const outcome = await managers.nixProfileUpgrade('ferretry', activity => seen.push(JSON.stringify(activity)));
    should(argvs[0]?.join(' ')).equal(
      'nix --extra-experimental-features nix-command flakes profile upgrade --refresh --log-format internal-json -v ferretry',
    );
    should(seen[0]).equal('{"phase":"preparing"}');
    should(seen.some(line => line.includes('"packages":{"done":0,"expected":3}'))).be.true();
    should(outcome.code).equal(1);
    should(outcome.stderr).equal('error: attribute missing\ntrailing plain line');
    await managers.nixProfileInstall('github:kirinnee/ferretry', () => undefined);
    should(argvs[1]?.join(' ')).containEql(
      'profile install --refresh --log-format internal-json -v github:kirinnee/ferretry',
    );
  });

  it("shows brew's last line as the detail of each phase, cleaned", async () => {
    const managers = new CommandPackageManagers(async (argv, onLine) => {
      const command = argv.join(' ');
      if (command === 'brew tap') return { code: 0, stdout: `${TAP}\n`, stderr: '' };
      onLine?.('\u001b[1m==> Upgrading ferretry\u001b[0m');
      onLine?.('   ');
      return await Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    const seen: string[] = [];
    await managers.brewRefresh(TAP, URL, activity => seen.push(`${activity.phase}:${activity.line ?? ''}`));
    await managers.brewUpgrade('ferretry', activity => seen.push(`${activity.phase}:${activity.line ?? ''}`));
    should(seen).deepEqual([
      'refreshing:',
      'refreshing:==> Upgrading ferretry',
      'upgrading:',
      'upgrading:==> Upgrading ferretry',
    ]);
  });

  it('adds a tap with a refreshing step when watched', async () => {
    const ran: string[] = [];
    const managers = new CommandPackageManagers(argv => {
      ran.push(argv.join(' '));
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    const seen: string[] = [];
    await managers.brewRefresh(TAP, URL, activity => seen.push(activity.phase));
    should(ran).deepEqual(['brew tap', `brew tap ${TAP} ${URL}`, 'brew update']);
    should(seen).deepEqual(['refreshing', 'refreshing']);
  });
});
