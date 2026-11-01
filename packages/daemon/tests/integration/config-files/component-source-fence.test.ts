import { afterEach, describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigStatusViewSchema } from '@ferretry/protocol';
import should from 'should';
import { bootDaemon, stopBootedDaemons } from '../support/booted-daemon.ts';
import { cleanupTempDirectories } from '../support/repository.ts';

/**
 * The component-source fence as the REAL daemon wires it (docs/secrets.md#what-the-state-home-fence-refuses): a
 * component whose `file:` names this daemon's own admin token is an error in the configuration it reports, so it
 * never comes into effect. A daemon built without the check context would report it as a good file.
 */

afterEach(async () => {
  await stopBootedDaemons();
  await cleanupTempDirectories();
});

describe("the daemon's configuration check", () => {
  it('should report a component source inside its own state home as an error, and one in its asset tree as fine', async () => {
    // Arrange: two instructions components, one naming the admin token, one an asset.
    const daemon = await bootDaemon('source-fence', {
      seed: async home => {
        const components = join(home, 'config', 'components', 'instructions');
        await mkdir(components, { recursive: true });
        await writeFile(join(components, 'token.yaml'), `file: ${join(home, 'api-token')}\n`);
        await writeFile(join(components, 'asset.yaml'), 'file: instructions/main.md\n');
      },
    });

    // Act
    const status = ConfigStatusViewSchema.parse(await (await daemon.get('/v1/config/status')).json());

    // Assert
    const errors = status.issues.filter(issue => issue.severity === 'error');
    should(errors.map(issue => issue.path)).deepEqual(['components/instructions/token.yaml']);
    should(errors[0]?.message).match(/^file: .*inside this daemon's state home/u);
    should(errors.some(issue => issue.path === 'components/instructions/asset.yaml')).be.false();
  });
});
