import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import { FakeHarness, FakeRunner } from '../../../contract/testing/index.ts';
import { FerretsPort } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { host } from '../daemon/ferrets/route-fixture.ts';
import {
  effectFileName,
  FileSessionEffectLedger,
} from '../../../daemon/adapters/session/effects/file-session-effect-ledger.ts';
import { FileSessionEnvironmentStore } from '../../../daemon/adapters/session/lifecycle/index.ts';
import { OwnFolder } from '../../../daemon/adapters/session/sessions-root.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';

const fresh = async () => await host([], { harness: new FakeHarness(), runner: new FakeRunner() });

describe('storage parity', () => {
  test('F-0232 a started ferret lands in state/ferrets/names.json as { format: 1, claims: [{ callsign, ownerId }] }', async () => {
    const h = await fresh();
    const started = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'parity-names-1' },
      body: { folder: '/work/a', name: 'wren' },
    });
    expect(started.status).toBeLessThan(300);
    const { id } = started.json<{ id: string }>();
    const stored = JSON.parse(h.state('ferrets').files.get('names.json') as string) as {
      format: number;
      claims: { callsign: string; ownerId: string }[];
    };
    expect(stored.format).toBe(1);
    expect(stored.claims.map(({ callsign, ownerId }) => ({ callsign, ownerId }))).toEqual([
      { callsign: 'wren', ownerId: id },
    ]);
    expect(manifest.data.state.map(file => file.path)).toContain('names.json');
  });

  test('F-0349 the first system callsign for a prefix lands in state/ferrets/system-callsigns.json as { learning: 1 }', async () => {
    const h = await fresh();
    expect(await h.provided(FerretsPort).systemCallsign?.('learning')).toBe('learning-000001');
    const stored = JSON.parse(h.state('ferrets').files.get('system-callsigns.json') as string) as Record<
      string,
      number
    >;
    expect(stored).toEqual({ format: 1, learning: 1 });
    expect(manifest.data.state.map(file => file.path)).toContain('system-callsigns.json');
  });
});

describe('session-private files parity (the internal sessions root, state/ferrets/sessions/<ferret>/)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const FERRET = parseSessionId('mw7bp88g-50e00159');
  const mode = async (path: string) => (await lstat(path)).mode & 0o777;
  const sessionsRoot = async () => {
    const parent = await mkdtemp(`${tmpdir()}/fy-parity-sessions-`);
    dirs.push(parent);
    return { parent, ...(await diskSessionsRoot(parent, FERRET)) };
  };

  test('F-0094 environment.json is a flat string map the environment store publishes 0600 in the ferret folder, and reads back only for the launch', async () => {
    const { root, folder } = await sessionsRoot();
    const store = new FileSessionEnvironmentStore(root, FERRET);
    await store.write(FERRET, { FY_SESSION_BOARD_CAPABILITY: 'fixture-value' });
    expect(String(store.file(FERRET))).toBe(`${folder}/environment.json`);
    expect(await mode(`${folder}/environment.json`)).toBe(0o600);
    expect(await store.read(FERRET)).toEqual({ FY_SESSION_BOARD_CAPABILITY: 'fixture-value' });
  });

  test('F-0324 FY_HOME/state/ferrets/sessions/{ferret}/environment.json: the environment lives under the sessions root, in a 0700 folder', async () => {
    const { parent, root, folder } = await sessionsRoot();
    await new FileSessionEnvironmentStore(root, FERRET).write(FERRET, { A: 'b' });
    expect(folder).toBe(`${parent}/home/state/ferrets/sessions/${FERRET}`);
    expect(await mode(folder)).toBe(0o700);
    expect(await mode(`${parent}/home/state/ferrets/sessions`)).toBe(0o700);
  });

  test('F-0323 FY_HOME/state/ferrets/sessions/{ferret}/effects/{effectFileName}.json: an effect record is a 0600 file named by the hash of its id', async () => {
    const { root, folder } = await sessionsRoot();
    const ledger = new FileSessionEffectLedger(root, FERRET);
    const key = { sessionId: FERRET, effectId: '../../etc/fixture' };
    expect(await ledger.begin(key, 'fingerprint', '2026-11-08T10:00:00.000Z')).toBe('perform');
    expect(String(ledger.file(key))).toBe(`${folder}/effects/${effectFileName(key.effectId)}.json`);
    expect(await mode(`${folder}/effects/${effectFileName(key.effectId)}.json`)).toBe(0o600);
    expect(await mode(`${folder}/effects`)).toBe(0o700);
  });

  test('F-0303 the per-ferret folder is state/ferrets/sessions/{ferret}, held 0700 when the ferret starts even if it was wider', async () => {
    const { root, folder } = await sessionsRoot();
    await mkdir(folder, { recursive: true, mode: 0o755 });
    await chmod(folder, 0o755);
    await new OwnFolder(root).ensure();
    expect(await mode(folder)).toBe(0o700);
  });
});
