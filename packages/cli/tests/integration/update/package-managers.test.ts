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
