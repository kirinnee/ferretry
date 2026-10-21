/**
 * The record that this daemon holds a tunnel: written atomically and owner-only, never a token, and
 * damage reported rather than read as "nothing held".
 */

import { afterEach, describe, it } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { FileTunnelHolding } from '../../../src/adapters/tunnel/file-tunnel-holding.ts';
import { removeTempDirectories, tempDirectory } from './support.ts';

afterEach(removeTempDirectories);

const HELD = {
  origin: 'https://ferretry-hosted-relay.example.workers.dev',
  tunnelUrl: 'https://quiet-otter.tunnels.example',
};

describe('the tunnel holding record', () => {
  it('should read nothing before a record, the record after one, and nothing once forgotten', async () => {
    // Arrange
    const directory = await tempDirectory('tunnel-holding');
    const file = join(directory, 'state', 'tunnel.json');
    const holding = new FileTunnelHolding(file);

    // Act
    const before = await holding.read();
    await holding.record(HELD);
    const during = await holding.read();
    const document = JSON.parse(await readFile(file, 'utf8'));
    const mode = (await stat(file)).mode & 0o777;
    await holding.forget();
    await holding.forget();

    // Assert
    should(before).be.undefined();
    should(during).deepEqual(HELD);
    should(document).deepEqual({ version: 1, ...HELD });
    should(mode).equal(0o600);
    should(await holding.read()).be.undefined();
  });

  it('should report a damaged record rather than forget the tunnel it named', async () => {
    // Arrange
    const directory = await tempDirectory('tunnel-holding');
    const file = join(directory, 'tunnel.json');
    await writeFile(file, '{"version":1,"origin":"x","tunnelUrl":"http://plain.example"}');
    const unreadable = join(directory, 'a-directory');
    await mkdir(unreadable);

    // Act / Assert
    await should(new FileTunnelHolding(file).read()).be.rejectedWith(
      `the tunnel record ${file} is damaged and cannot be read`,
    );
    await should(new FileTunnelHolding(unreadable).read()).be.rejected();
  });
});
