import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOME_PORT_REFUSAL, homePortAccepted, homePortAcceptedPath } from '../../../contract/home-port.ts';
import type { ConfigFileDef } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { type LoadImplementations, settingsForRun } from '../../../host/home-settings.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { declaredKinds } from '../host-config/real-schemas.ts';
import { captureLog, manualClock } from '../host-config/support.ts';

/**
 * The daemon binds the port the configuration service has IN EFFECT, never a port from an edit it holds for the owner
 * (review batch D, P1 security), and never prints a malformed value from the file. The service is the REAL one, over the
 * REAL Connections declaration.
 */
const def = declaredKinds().find(kind => kind.path === 'connections.yaml')?.def as ConfigFileDef<{
  direct?: { port?: number };
}>;
const text = (port: number | string): string => `direct:\n  host: 127.0.0.1\n  port: ${String(port)}\n`;
const load: LoadImplementations = async () => daemonImplementations;
const MARKER = 'FAKE_CONFIG_VALUE_DO_NOT_PRINT';

async function inTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'home-settings-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const write = async (path: string, data: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
};

describe('the daemon binds the version in effect, not the file on disk', () => {
  test('startup preserves the accepted port while a port edit is held for owner confirmation (and so does fy)', async () => {
    await inTempHome(async home => {
      const fs = createMemoryHostFs();
      const options = {
        home,
        fs,
        clock: manualClock(),
        log: captureLog(),
        binary: 'fy',
        defs: [{ plugin: 'connections', def }],
      };
      const files = createConfigFiles(options);
      await files.reload();
      expect((await files.write('connections', def, undefined, text(43_210), { confirmedLoosening: true })).kind).toBe(
        'applied',
      );
      expect((await files.write('connections', def, undefined, text(43_211))).kind).toBe('held');
      expect(files.port('connections').file(def)?.direct?.port).toBe(43_210);
      for (const [path, data] of fs.snapshot()) await write(path, data);
      // The held edit really is the text on disk, and a raw read of it would say 43211.
      expect(await readFile(join(home, 'config/connections.yaml'), 'utf8')).toContain('43211');

      const restarted = createConfigFiles({ ...options, clock: manualClock(), log: captureLog() });
      await restarted.reload();
      expect(restarted.port('connections').file(def)?.direct?.port).toBe(43_210);

      const result = await settingsForRun({ FY_HOME: home }, {}, '/unused', load);
      expect(result.kind === 'settings' && result.settings.port).toEqual({
        value: 43_210,
        origin: 'home config',
        source: 'config/connections.yaml direct.port',
      });
      // fy, with no daemon to ask, reads the service's record of what is in effect: the same port.
      expect(homePortAccepted(await readFile(homePortAcceptedPath(home), 'utf8'))).toEqual({
        kind: 'port',
        port: 43_210,
      });
    });
  });

  test('an owner-confirmed port is the one bound', async () => {
    await inTempHome(async home => {
      const fs = createMemoryHostFs();
      const files = createConfigFiles({
        home,
        fs,
        clock: manualClock(),
        log: captureLog(),
        binary: 'fy',
        defs: [{ plugin: 'connections', def }],
      });
      await files.reload();
      await files.write('connections', def, undefined, text(43_210), { confirmedLoosening: true });
      await files.write('connections', def, undefined, text(43_212), { confirmedLoosening: true });
      for (const [path, data] of fs.snapshot()) await write(path, data);
      const result = await settingsForRun({ FY_HOME: home }, {}, '/unused', load);
      expect(result.kind === 'settings' && result.settings.port.value).toBe(43_212);
    });
  });

  test('a port the service never accepted (a first edit, held) binds nothing of the file: the default stands', async () => {
    await inTempHome(async home => {
      await write(join(home, 'config/connections.yaml'), text(43_211));
      const result = await settingsForRun({ FY_HOME: home }, {}, '/unused', load);
      expect(result.kind === 'settings' && result.settings.port).toEqual({ value: 7457, origin: 'default' });
    });
  });

  test('--port and FY_PORT never read the home’s configuration at all', async () => {
    const never: LoadImplementations = async () => {
      throw new Error('the registry was loaded');
    };
    const flag = await settingsForRun({ FY_HOME: '/nowhere' }, { port: 9 }, '/u', never);
    expect(flag.kind === 'settings' && flag.settings.port.origin).toBe('flag');
    const variable = await settingsForRun({ FY_HOME: '/nowhere', FY_PORT: '8' }, {}, '/u', never);
    expect(variable.kind === 'settings' && variable.settings.port.origin).toBe('environment');
  });

  test('a home with no connections.yaml never loads the registry', async () => {
    await inTempHome(async home => {
      const never: LoadImplementations = async () => {
        throw new Error('the registry was loaded');
      };
      const result = await settingsForRun({ FY_HOME: home }, {}, '/unused', never);
      expect(result.kind === 'settings' && result.settings.port.origin).toBe('default');
    });
  });
});

describe('a malformed port is refused by a fixed sentence that carries nothing from the file', () => {
  test.each([
    ['scalar', `${MARKER}`],
    ['list', `[${MARKER}]`],
    ['mapping', `{token: ${MARKER}}`],
    ['nested mapping', `\n    api:\n      token: ${MARKER}`],
  ])('a %s port', async (_name, written) => {
    await inTempHome(async home => {
      await write(join(home, 'config/connections.yaml'), text(written));
      const result = await settingsForRun({ FY_HOME: home }, {}, '/unused', load);
      expect(result.kind).toBe('refused');
      const sentence = result.kind === 'refused' ? result.sentence : '';
      expect(sentence).toBe(HOME_PORT_REFUSAL);
      expect(sentence).not.toContain(MARKER);
    });
  });
});
