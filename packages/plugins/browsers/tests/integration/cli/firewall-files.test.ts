import { describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { BUNDLED_FIREWALL_FILES } from '../../../cli/adapters/firewall-files.ts';

const HOST = join(import.meta.dir, '../../../../../../scripts/host');

describe('the firewall host files bundled into fy', () => {
  it('are the repository host files, byte for byte, so a brew or nix fy installs what the checkout would', async () => {
    const onDisk = {
      script: await readFile(join(HOST, 'ferretry-loopback-firewall'), 'utf8'),
      unit: await readFile(join(HOST, 'ferretry-loopback-firewall.service'), 'utf8'),
      verifyUnit: await readFile(join(HOST, 'ferretry-loopback-firewall-verify.service'), 'utf8'),
      timer: await readFile(join(HOST, 'ferretry-loopback-firewall-verify.timer'), 'utf8'),
    };
    should(BUNDLED_FIREWALL_FILES).deepEqual(onDisk);
    for (const text of Object.values(BUNDLED_FIREWALL_FILES)) should(text.length).be.above(0);
  });
});
