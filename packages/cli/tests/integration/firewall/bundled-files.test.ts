import { describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import should from 'should';
import { BUNDLED_FIREWALL_FILES } from '../../../src/adapters/browser/firewall-files';

const HOST = resolve(import.meta.dir, '../../../../../scripts/host');

const SHIPPED: readonly (readonly [keyof typeof BUNDLED_FIREWALL_FILES, string])[] = [
  ['script', 'ferretry-loopback-firewall'],
  ['unit', 'ferretry-loopback-firewall.service'],
  ['verifyUnit', 'ferretry-loopback-firewall-verify.service'],
  ['timer', 'ferretry-loopback-firewall-verify.timer'],
];

describe('the firewall files fy ships', () => {
  for (const [key, name] of SHIPPED) {
    it(`should ship ${name} byte-for-byte as the repository holds it, so brew and nix users install what CI tested`, async () => {
      // Arrange
      const onDisk = await readFile(resolve(HOST, name), 'utf8');

      // Act
      const printed = BUNDLED_FIREWALL_FILES[key];

      // Assert
      should(printed).equal(onDisk);
    });
  }

  it('should each end in exactly one newline, which is what lets the command print them verbatim', () => {
    // Arrange
    const files = Object.values(BUNDLED_FIREWALL_FILES);

    // Act
    const endings = files.map(text => /\n*$/.exec(text)?.[0]);

    // Assert
    should(endings).deepEqual(['\n', '\n', '\n', '\n']);
  });

  it('should install the script where the units say they run it', () => {
    // Arrange
    const execLines = [BUNDLED_FIREWALL_FILES.unit, BUNDLED_FIREWALL_FILES.verifyUnit]
      .flatMap(unit => unit.split('\n'))
      .filter(line => line.startsWith('Exec'));

    // Act
    const commands = execLines.map(line => line.slice(line.indexOf('=') + 1));

    // Assert
    should(commands).deepEqual([
      '/usr/local/sbin/ferretry-loopback-firewall apply',
      '/usr/local/sbin/ferretry-loopback-firewall stop',
      '/usr/local/sbin/ferretry-loopback-firewall --verify',
    ]);
  });

  it('should have the timer run the verify service every five minutes, from one minute after boot', () => {
    // Arrange
    const timer = BUNDLED_FIREWALL_FILES.timer.split('\n');

    // Act / Assert
    should(timer).containEql('OnBootSec=1min');
    should(timer).containEql('OnUnitActiveSec=5min');
    should(timer).containEql('Persistent=true');
    should(timer).containEql('WantedBy=timers.target');
  });
});
