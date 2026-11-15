import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import should from 'should';
import { MonitorFiles } from '../../../../../daemon/adapters/session/monitor/index.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * The monitor's two artifacts, written through the kernel's handles: a ferret's heartbeat into that ferret's own session
 * folder, the loop's record to its state. Everything runs on a temp home; nothing here touches a real one.
 */

const homes = new Set<string>();
const ONE = parseSessionId('20260806-one');

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function subject() {
  const home = await mkdtemp(join(tmpdir(), 'fy-monitor-files-'));
  homes.add(home);
  const { root } = await diskSessionsRoot(home, ONE);
  const recorded: string[] = [];
  const asked: string[] = [];
  const files = new MonitorFiles(
    ferret => {
      asked.push(ferret);
      return root;
    },
    { name: 'monitor-tick.json', write: async text => void recorded.push(text) },
  );
  const folder = join(root.resolve('.').ok ? (root.resolve('.') as { value: string }).value : home);
  return { files, recorded, asked, folder };
}

describe('MonitorFiles', () => {
  it('should write a ferret’s heartbeat into its own session folder, private, and make the folders it needs', async () => {
    // Arrange
    const { files, folder, asked } = await subject();

    // Act
    await files.writeTextAtomic(`${ONE}/checks/waiting.json`, '{"at":"now"}\n');

    // Assert
    should(asked).eql([ONE]);
    should(await readFile(join(folder, 'checks', 'waiting.json'), 'utf8')).equal('{"at":"now"}\n');
    should((await stat(join(folder, 'checks', 'waiting.json'))).mode & 0o777).equal(0o600);
    should((await stat(join(folder, 'checks'))).mode & 0o777).equal(0o700);
  });

  it('should hand the loop’s own record to its sink and write nothing to any session', async () => {
    // Arrange
    const { files, recorded, asked } = await subject();

    // Act
    await files.writeTextAtomic('monitor-tick.json', '{"armed":true}\n');

    // Assert
    should(recorded).eql(['{"armed":true}\n']);
    should(asked).eql([]);
  });

  it('should refuse a name that is neither its record nor a path inside a ferret’s folder', async () => {
    // Arrange
    const { files, asked } = await subject();

    // Act / Assert: no ferret, a parent folder, a bare name, and a name that leaves the folder
    for (const name of ['elsewhere.json', '/abs/path.json', '../escape/waiting.json', `${ONE}/`, './x/y.json'])
      await files.writeTextAtomic(name, 'x').then(
        () => should.fail(name, undefined, `${name} was written`),
        (error: Error) => should(error.message).match(/only its own record/),
      );
    await files.writeTextAtomic(`${ONE}/../../escape.json`, 'x').then(
      () => should.fail('escape', undefined, 'escaped'),
      (error: Error) => should(error.message).match(/outside the ferret/),
    );
    should(asked.length).equal(1);
  });

  it('should have nothing to do for ensureDirectory, because a publish makes its own folders', async () => {
    // Arrange
    const { files } = await subject();

    // Act / Assert
    should(await files.ensureDirectory()).be.undefined();
  });
});
