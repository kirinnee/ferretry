import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXED_SETTINGS_FILE, RUNTIME_STATE_DIRECTORY } from '@ferretry/fleet';
import should from 'should';
import { FileHarnessWrapperSource, FileLaunchSettingsDigest } from '../../../../src/adapters/index.ts';

const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function fleet(): Promise<{ readonly wrapper: string; readonly home: string; readonly fixed: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-launch-settings-'));
  directories.add(root);
  const home = join(root, 'harness');
  await mkdir(join(home, RUNTIME_STATE_DIRECTORY), { recursive: true });
  const wrapper = join(root, 'claude-auto-boot');
  await writeFile(wrapper, `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${home}"\nexec claude --permission-mode auto "$@"\n`);
  return { wrapper, home, fixed: join(home, RUNTIME_STATE_DIRECTORY, FIXED_SETTINGS_FILE) };
}

describe('FileLaunchSettingsDigest', () => {
  it('should change when the wrapper or its fixed settings file change, and only then', async () => {
    // Arrange
    const { wrapper, fixed } = await fleet();
    const subject = new FileLaunchSettingsDigest(new FileHarnessWrapperSource(), {});
    await writeFile(fixed, '{"permissions":{"deny":[]}}');

    // Act
    const first = await subject.digest(wrapper, 'claude');
    const again = await subject.digest(wrapper, 'claude');
    await writeFile(fixed, '{"permissions":{"deny":["Bash(rm:*)"]}}');
    const fixedChanged = await subject.digest(wrapper, 'claude');
    await writeFile(wrapper, '#!/bin/sh\nexec claude --permission-mode default "$@"\n');
    const wrapperChanged = await subject.digest(wrapper, 'claude');

    // Assert
    should(first).match(/^[0-9a-f]{64}$/u);
    should(again).equal(first);
    should(fixedChanged).not.equal(first);
    should(wrapperChanged).not.equal(fixedChanged);
  });

  it('should digest a runtime with no fixed layer, and say nothing for a wrapper it cannot read', async () => {
    // Arrange
    const { wrapper } = await fleet();
    const subject = new FileLaunchSettingsDigest(new FileHarnessWrapperSource(), {});

    // Act / Assert
    should(await subject.digest(wrapper, 'claude')).match(/^[0-9a-f]{64}$/u);
    // A wrapper exporting no home has nowhere to look for a fixed file, which is evidence too.
    should(await subject.digest(wrapper, 'codex')).match(/^[0-9a-f]{64}$/u);
    should(await subject.digest(`${wrapper}-missing`, 'claude')).be.undefined();
  });
});
