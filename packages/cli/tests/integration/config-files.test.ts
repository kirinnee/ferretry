/**
 * The configuration directory as `fy config` reads it with no daemon (`src/adapters/config-files.ts`): over a memory
 * filesystem, so no test touches a real home. It reads what the daemon's own reader reads, never follows a link, and
 * writes nothing.
 */
import { describe, expect, it } from 'bun:test';
import { config, state } from '@ferretry/kernel/host';
import { createConfigFiles } from '../../src/adapters/config-files.ts';

const HOME = '/fake-home';

async function home() {
  const fs = state.createMemoryHostFs();
  const put = async (path: string, text: string) => await fs.writeAtomic(`${HOME}/config/${path}`, text, 0o600);
  return { fs, put, files: createConfigFiles({ home: HOME, fs }) };
}

describe('the configuration directory, read without a daemon', () => {
  it('names its directory and reads every .yaml file at every depth the layout has, in order', async () => {
    const { put, files } = await home();
    await put('warden.yaml', 'enabled: true\n');
    await put('runtimes/b.yaml', 'a: 1\n');
    await put('runtimes/a.yaml', 'a: 1\n');
    await put('notes.txt', 'not configuration');
    await put('.schema/warden.json', '{}');
    await put('.warden.yaml.swp', 'an editor’s swap file');

    expect(files.directory).toBe(`${HOME}/config`);
    expect(await files.list()).toEqual([
      { path: 'runtimes/a.yaml', disk: { kind: 'text', text: 'a: 1\n' } },
      { path: 'runtimes/b.yaml', disk: { kind: 'text', text: 'a: 1\n' } },
      { path: 'warden.yaml', disk: { kind: 'text', text: 'enabled: true\n' } },
    ]);
  });

  it('reads an empty list when there is no config directory yet', async () => {
    const { files } = await home();
    expect(await files.list()).toEqual([]);
    expect(await files.accepted()).toEqual({});
  });

  it('names a file over the size a configuration file may be as unreadable, and reads none of it', async () => {
    const { put, files } = await home();
    await put('big.yaml', `a: ${'x'.repeat(config.CONFIG_FILE_MAX_BYTES)}\n`);
    expect(await files.list()).toEqual([{ path: 'big.yaml', disk: { kind: 'unreadable' } }]);
  });

  it('reads the daemon’s accepted record by the path it was filed under, with the plugin it is in effect for', async () => {
    const { fs, files } = await home();
    const port = state.createStatePort({
      home: HOME,
      pluginId: 'kernel',
      files: [config.acceptedConfigFile],
      fs,
    });
    await port.write(
      config.acceptedConfigFile,
      { etag: 'e1', text: 'enabled: true\n', plugin: 'warden' },
      config.acceptedName('warden.yaml'),
    );
    await port.write(config.acceptedConfigFile, { etag: 'e2', text: 'a: 1\n' }, config.acceptedName('runtimes/a.yaml'));
    expect(await files.accepted()).toEqual({
      'warden.yaml': { etag: 'e1', text: 'enabled: true\n', plugin: 'warden' },
      'runtimes/a.yaml': { etag: 'e2', text: 'a: 1\n' },
    });
  });

  it('digests text as sha256 of its UTF-8 bytes, hex', async () => {
    const { files } = await home();
    expect(files.digest('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('writes nothing: no file, no folder, no record', async () => {
    const { fs, files } = await home();
    await files.list();
    await files.accepted();
    expect(await fs.list(HOME)).toEqual([]);
  });
});
