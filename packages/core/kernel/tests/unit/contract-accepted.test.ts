/** The accepted-loosenings state def is on the kernel contract, so a converter can carry today's record across. */
import { describe, expect, test } from 'bun:test';
import { acceptedConfigFile, acceptedName, pathOfAcceptedName } from '../../contract/index.ts';
import { createStatePort } from '../../host/state/state-port.ts';
import { createMemoryHostFs } from '../../host/state/memory-fs.ts';

describe('accepted config record (contract)', () => {
  test('is the kernel state def over { etag, text }, one document per config path', () => {
    expect(acceptedConfigFile.name).toBe('accepted-config');
    expect(acceptedConfigFile.store).toBe('json');
    expect(acceptedConfigFile.schema?.safeParse({ etag: 'e1', text: 'limit: 3\n' }).success).toBe(true);
    expect(acceptedConfigFile.schema?.safeParse({ etag: '', text: '' }).success).toBe(false);
    expect(acceptedConfigFile.schema?.safeParse({ etag: 'e1', text: '', extra: 1 }).success).toBe(false);
  });

  test('a path names its own document and the name reads back to the path', () => {
    for (const path of ['updates.yaml', 'logins/work.yaml', 'weird name/ü.yaml']) {
      expect(acceptedName(path)).toMatch(/^[A-Za-z0-9._~%-]+$/u);
      expect(pathOfAcceptedName(acceptedName(path))).toBe(path);
    }
    expect(acceptedName('logins/work.yaml')).toBe('logins%2Fwork.yaml');
  });

  test('a converter writes one record per path and the kernel state port reads it back', async () => {
    const fs = createMemoryHostFs();
    const state = createStatePort({ home: '/home/fy', pluginId: 'kernel', files: [acceptedConfigFile], fs });
    const converted = { etag: 'abc', text: 'limit: 20\n' };
    await state.write(acceptedConfigFile, converted, acceptedName('updates.yaml'));
    expect(await state.read(acceptedConfigFile, acceptedName('updates.yaml'))).toEqual({ ok: true, value: converted });
    expect(await state.read(acceptedConfigFile, acceptedName('other.yaml'))).toEqual({ ok: true, value: undefined });
  });
});
