import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  CliUpdateLauncher,
  type DetachedSpawn,
  FileUpdateDocuments,
  type UpdateStateFiles,
} from '../../../src/adapters/index.ts';
import { waitFor } from '../support/wait-for.ts';

/** The four calls over a real directory, as the state home's filesystem would make them. */
const files: UpdateStateFiles = {
  readText: async path => await readFile(path, 'utf8').catch(() => undefined),
  writeTextAtomic: async (path, text) => await writeFile(path, text),
  removeFile: async path => await rm(path, { force: true }),
  ensureDirectory: async (path, mode) => {
    await mkdir(path, { recursive: true, mode });
  },
};

async function withDirectory(act: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'fy-update-'));
  try {
    await act(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const eventually = async (check: () => Promise<boolean>): Promise<void> => {
  await waitFor(check, 'the update child to log its home');
};

describe('the update documents', () => {
  it('writes each document under its own name and reads it back', async () => {
    await withDirectory(async directory => {
      const documents = new FileUpdateDocuments(files, directory);
      await documents.write('latest', { state: 'never' });
      await documents.write('settings', { autoInstall: true });
      should(await documents.read('latest')).deepEqual({ state: 'never' });
      should(await documents.read('settings')).deepEqual({ autoInstall: true });
      should(await readFile(join(directory, 'config.json'), 'utf8')).equal('{\n  "autoInstall": true\n}\n');
    });
  });

  it('reads a missing, empty or broken document as absent, and removes the report', async () => {
    await withDirectory(async directory => {
      const documents = new FileUpdateDocuments(files, directory);
      should(await documents.read('report')).be.undefined();
      await writeFile(join(directory, 'report.json'), '  ');
      should(await documents.read('report')).be.undefined();
      await writeFile(join(directory, 'report.json'), '{');
      should(await documents.read('report')).be.undefined();
      await documents.remove('report');
      await documents.remove('report');
      should(await stat(join(directory, 'report.json')).catch(() => undefined)).be.undefined();
      const unreadable = new FileUpdateDocuments(
        { ...files, readText: async () => Promise.reject(new Error('EACCES')) },
        directory,
      );
      should(await unreadable.read('latest')).be.undefined();
    });
  });
});

describe('the client update launcher', () => {
  it('starts the client with the contract the client implements, carrying the state home', async () => {
    await withDirectory(async directory => {
      const calls: Parameters<DetachedSpawn>[] = [];
      const launcher = new CliUpdateLauncher({
        client: '/opt/fy/fy',
        stateHome: '/home/kirin/.ferretry',
        files,
        directory: join(directory, 'update'),
        environment: { PATH: '/usr/bin' },
        spawn: (argv, options) => {
          calls.push([argv, options]);
        },
      });
      should(await launcher.launch('4.29.0')).deepEqual({ kind: 'started' });
      const report = join(directory, 'update', 'report.json');
      should(calls).deepEqual([
        [
          ['/opt/fy/fy', 'daemon', 'update', '--yes', '--to', '4.29.0', '--report', report],
          {
            environment: { PATH: '/usr/bin', FY_HOME: '/home/kirin/.ferretry' },
            logFile: join(directory, 'update', 'update.log'),
          },
        ],
      ]);
    });
  });

  it('says why when the client cannot be started', async () => {
    await withDirectory(async directory => {
      const launcher = new CliUpdateLauncher({
        client: join(directory, 'no-such-fy'),
        stateHome: directory,
        files,
        directory: join(directory, 'update'),
        environment: {},
      });
      const outcome = await launcher.launch('4.29.0');
      should(outcome.kind).equal('failed');
      const thrown = new CliUpdateLauncher({
        client: 'fy',
        stateHome: directory,
        files: { ...files, ensureDirectory: async () => Promise.reject('no space') },
        directory,
        environment: {},
      });
      should(await thrown.launch('4.29.0')).deepEqual({ kind: 'failed', reason: 'no space' });
    });
  });

  it('really starts a detached child that writes its own log', async () => {
    await withDirectory(async directory => {
      const client = join(directory, 'fy');
      await writeFile(client, '#!/bin/sh\necho "args: $*"\necho "home: $FY_HOME"\n', { mode: 0o755 });
      const launcher = new CliUpdateLauncher({
        client,
        stateHome: directory,
        files,
        directory: join(directory, 'update'),
        environment: { PATH: '/usr/bin:/bin' },
      });
      should(await launcher.launch('4.29.0')).deepEqual({ kind: 'started' });
      const log = join(directory, 'update', 'update.log');
      await eventually(async () => ((await readFile(log, 'utf8').catch(() => '')) as string).includes('home:'));
      const written = await readFile(log, 'utf8');
      should(written).match(/args: daemon update --yes --to 4\.29\.0 --report /u);
      should(written).containEql(`home: ${directory}`);
    });
  });
});
