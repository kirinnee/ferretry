import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_RUN_FILE } from '@ferretry/kernel/contract';
import { buildUpdateMachine } from '../../../src/adapters/update/machine.ts';
import type { IDaemonUpdateViewPort } from '../../../src/lib/update/ports.ts';
import { capturedIo } from '../fakes.ts';

// Synthetic fixtures only: a temp FY_HOME, a fake fetch, no daemon and no network.
const unusedView: IDaemonUpdateViewPort = {
  view: async () => {
    throw new Error('the update view is not part of the health probe');
  },
};

let root = '';
let home = '';
let dialled: string[] = [];
let fetcher: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-update-health-'));
  home = join(root, 'fy-home');
  await mkdir(join(home, 'run'), { recursive: true });
  await mkdir(join(home, 'config'), { recursive: true });
  // A decoy at the old address: if anything still read config/daemon.json it would dial 7431.
  await writeFile(join(home, 'config', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 7431 }));
  dialled = [];
  fetcher = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        dialled.push(url);
        if (url === 'http://127.0.0.1:17458/healthz')
          return Response.json({ protocol: 1, version: '5.0.0', pid: 4321 });
        return new Response(null, { status: 503 });
      },
      {
        preconnect: () => {
          throw new Error('no real preconnect may run');
        },
      },
    ),
  );
});

afterEach(async () => {
  fetcher?.mockRestore();
  await rm(root, { recursive: true, force: true });
});

function machine() {
  return buildUpdateMachine(
    {
      environment: { FY_HOME: home, FY_URL: 'http://127.0.0.1:19999', PATH: '' },
      userHome: root,
      home,
      product: 'ferretry',
      clientName: 'fy',
      daemonName: 'fyd',
      binaries: ['fy', 'fyd'],
      io: capturedIo(),
      selfPath: join(root, 'bin', 'fy'),
    },
    unusedView,
  );
}

async function record(host: string, port: number): Promise<void> {
  await writeFile(
    join(home, DAEMON_RUN_FILE),
    JSON.stringify({ format: 1, socket: join(home, 'run', 'fyd.sock'), host, port, pid: 4321, version: '5.0.0' }),
  );
}

test('P89 fy update health dials the port the kernel recorded, not config/daemon.json and not FY_URL', async () => {
  await record('127.0.0.1', 17458);
  expect(await machine().deps.lifecycle.probe()).toMatchObject({ protocol: 1, version: '5.0.0' });
  expect(dialled).toEqual(['http://127.0.0.1:17458/healthz']);
});

test('P89 fy update health reaches a wildcard bind on loopback at the recorded port', async () => {
  await record('0.0.0.0', 17458);
  expect(await machine().deps.lifecycle.probe()).toMatchObject({ protocol: 1, version: '5.0.0' });
  expect(dialled).toEqual(['http://127.0.0.1:17458/healthz']);
});

test('P89 fy update health with no run record dials the daemon default, never the old 7431', async () => {
  expect(await machine().deps.lifecycle.probe()).toBeUndefined();
  expect(dialled).toEqual(['http://127.0.0.1:7457/healthz']);
});
