import { describe, it } from 'bun:test';
import should from 'should';
import { CommandPackageManagers } from '../../../src/adapters/update/package-managers';

describe('CommandPackageManagers', () => {
  it('runs exactly the commands an update is allowed, as the user', async () => {
    const ran: string[] = [];
    const managers = new CommandPackageManagers(argv => {
      ran.push(argv.join(' '));
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    await managers.brewUpgrade('ferretry');
    await managers.nixProfileUpgrade('ferretry');
    await managers.nixProfileRollback();
    await managers.nixProfileInstall('github:kirinnee/ferretry');
    should(ran).deepEqual([
      'brew upgrade --cask ferretry',
      'nix --extra-experimental-features nix-command flakes profile upgrade --refresh ferretry',
      'nix --extra-experimental-features nix-command flakes profile rollback',
      'nix --extra-experimental-features nix-command flakes profile install --refresh github:kirinnee/ferretry',
    ]);
    should(ran.some(command => command.includes('sudo'))).be.false();
  });
});
