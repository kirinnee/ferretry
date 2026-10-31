import { describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import should from 'should';
import { BUNDLED_FIREWALL_FILES } from '../../../src/adapters/browser/firewall-files';

const HOST = resolve(import.meta.dir, '../../../../../scripts/host');

describe('the firewall files fy ships', () => {
  it('should be byte-for-byte the script the repository holds, so brew and nix users install what CI tested', async () => {
    // Arrange
    const onDisk = await readFile(resolve(HOST, 'ferretry-loopback-firewall'), 'utf8');

    // Act
    const printed = BUNDLED_FIREWALL_FILES.script;

    // Assert
    should(printed).equal(onDisk);
  });

  it('should be byte-for-byte the systemd unit the repository holds', async () => {
    // Arrange
    const onDisk = await readFile(resolve(HOST, 'ferretry-loopback-firewall.service'), 'utf8');

    // Act
    const printed = BUNDLED_FIREWALL_FILES.unit;

    // Assert
    should(printed).equal(onDisk);
  });

  it('should each end in exactly one newline, which is what lets the command print them verbatim', () => {
    // Arrange
    const files = [BUNDLED_FIREWALL_FILES.script, BUNDLED_FIREWALL_FILES.unit];

    // Act
    const endings = files.map(text => /\n*$/.exec(text)?.[0]);

    // Assert
    should(endings).deepEqual(['\n', '\n']);
  });

  it('should install the script where the unit says it runs it', () => {
    // Arrange
    const execLines = BUNDLED_FIREWALL_FILES.unit.split('\n').filter(line => line.startsWith('Exec'));

    // Act
    const programs = execLines.map(line => line.split('=')[1]?.split(' ')[0]);

    // Assert
    should(programs).deepEqual([
      '/usr/local/sbin/ferretry-loopback-firewall',
      '/usr/local/sbin/ferretry-loopback-firewall',
    ]);
  });
});
