import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FerretRecordSchema } from '../../contract/ids.ts';
import { RepoWorktreeListResponseSchema, MoveProjectWorktreeRequestSchema } from '../../contract/index.ts';
import { generateKeyPairSync } from 'node:crypto';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { WebCryptoSessionCrypto, toBase64Url } from '@ferretry/kernel/session';
import { deviceClient } from '../support/daemon/device-client.ts';
import {
  cleanupTempDirectories,
  setupGit,
  tempDirectory,
  tempRepository,
} from '../integration/daemon/support/repository.ts';

// Real fyd, real HTTP admission and real fy, with no harness or external Git remote.
const ROOT = path.resolve(import.meta.dir, '../../../../..');
const STAMP = '2026-11-16T00:00:00.000Z';
let child: ReturnType<typeof Bun.spawn> | undefined;
let root: string;
let home: string;
let repository: string;
let target: string;
let url: string;
let admin: string;
let environment: Record<string, string>;
const projectId = '00000000-0000-4000-8000-000000000001';
const deviceId = `fy_device_id_${'a'.repeat(22)}`;
let daemonId: string;
let deviceKey: CryptoKey;

beforeAll(async () => {
  root = await tempDirectory('adopt-sit');
  home = path.join(root, 'fy-home');
  repository = (await tempRepository('adopt-sit-repo')).root;
  target = path.join(repository, 'existing');
  await setupGit(repository, 'worktree', 'add', '-b', 'adopt/sit', target);
  await mkdir(path.join(home, 'state/ferrets/F1'), { recursive: true });
  await mkdir(path.join(home, 'config'), { recursive: true });
  for (const folder of ['state/kernel', 'state/access', 'state/projects'])
    await mkdir(path.join(home, folder), { recursive: true });
  const codec = new WebCryptoSessionCrypto();
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  daemonId = (await codec.importDaemonIdentity(pem)).daemonId;
  const device = await codec.generateDeviceKey();
  deviceKey = device.privateKey;
  await writeFile(
    path.join(home, 'state/kernel/identity.json'),
    JSON.stringify({ schemaVersion: 1, privateKeyPem: pem }),
  );
  await writeFile(
    path.join(home, 'state/access/devices.json'),
    JSON.stringify({
      format: 1,
      daemonId,
      devices: [
        {
          id: deviceId,
          daemonId,
          name: 'Synthetic no-filesystem device',
          platform: 'browser',
          createdAt: STAMP,
          lastSeenAt: new Date().toISOString(),
          publicKey: toBase64Url(device.publicKeySpki),
          grants: { ...FULL_DEVICE_GRANTS, filesystem: { use: false, configure: false } },
        },
      ],
    }),
  );
  await writeFile(
    path.join(home, 'state/projects/projects.json'),
    JSON.stringify({
      format: 1,
      projects: [
        {
          id: projectId,
          name: 'Synthetic',
          path: repository,
          source: 'existing-folder',
          createdAt: STAMP,
          git: { commonDirectory: path.join(repository, '.git') },
          repos: [{ path: '.' }],
        },
      ],
    }),
  );
  await mkdir(path.join(root, 'user-home'), { recursive: true });
  await writeFile(
    path.join(home, 'home.json'),
    JSON.stringify({ format: 1, createdBy: 'adopt-sit', createdAt: STAMP }),
  );
  await writeFile(path.join(home, 'config/limits.yaml'), 'enabled: false\n');
  await writeFile(path.join(home, 'config/plugins.yaml'), 'work: on\n');
  await writeFile(
    path.join(home, 'state/ferrets/F1/ferret.json'),
    JSON.stringify(
      FerretRecordSchema.parse({
        format: 1,
        id: 'F1',
        name: 'adopt-fixture',
        role: 'lead',
        mode: 'interactive',
        harness: 'codex',
        runner: 'tmux',
        folder: repository,
        state: 'stopped',
        birth: 'person',
        createdAt: STAMP,
        stateAt: STAMP,
      }),
    ),
  );
  let port: number | undefined;
  for (let candidate = 7480; candidate <= 7499; candidate++) {
    try {
      const probe = Bun.serve({ hostname: '127.0.0.1', port: candidate, fetch: () => new Response('') });
      await probe.stop(true);
      port = candidate;
      break;
    } catch {
      /* another test owns this port */
    }
  }
  if (port === undefined) throw new Error('no test port in 7480-7499 is available');
  url = `http://127.0.0.1:${port}`;
  environment = {
    PATH: process.env.PATH ?? '',
    HOME: path.join(root, 'user-home'),
    FY_HOME: home,
    FY_PORT: String(port),
    FY_URL: url,
    LANG: 'C.UTF-8',
    FY_MODEL_CATALOG: 'off',
    FY_LOCAL_MODELS: 'off',
    FY_RELAY_DIRECTORY_ORIGIN: 'off',
    FY_UPDATE_CHECK: 'off',
    FYD_BACKGROUND_DELAY_SECONDS: '3600',
  };
  child = Bun.spawn([process.execPath, path.join(ROOT, 'packages/core/kernel/host/fyd.ts')], {
    cwd: ROOT,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let logs = '';
  let ready = false;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      logs += new TextDecoder().decode(chunk);
      if (/\bfyd \S+ ready \(/u.test(logs)) ready = true;
    }
  };
  void pump(child.stdout as ReadableStream<Uint8Array>);
  void pump(child.stderr as ReadableStream<Uint8Array>);
  const until = Date.now() + 90_000;
  while (!ready && Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`test daemon exited: ${logs.slice(-2000)}`);
    await Bun.sleep(200);
  }
  if (!ready) throw new Error(`test daemon did not become ready: ${logs.slice(-2000)}`);
  admin = (await readFile(path.join(home, 'state/gate/admin-token'), 'utf8')).trim();
});

afterAll(async () => {
  if (child !== undefined) {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  await cleanupTempDirectories();
  if (home !== undefined) await rm(`${home}-worktrees`, { recursive: true, force: true });
});

async function fy(args: readonly string[]) {
  const cli = Bun.spawn([process.execPath, path.join(ROOT, 'packages/cli/bin/fy.ts'), ...args], {
    cwd: repository,
    env: { ...environment, FY_TOKEN: admin },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  const [code, out, err] = await Promise.all([
    cli.exited,
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
  ]);
  return { code, out, err };
}

describe('adopt and remove over the real daemon (SIT)', () => {
  it('the real Gate refuses a remote caller without filesystem.use before processing a move', async () => {
    const security = await fetch(`${url}/v1/security`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ unlockOnOpen: false }),
    });
    expect(security.status).toBe(200);
    const device = await deviceClient(url, daemonId, deviceId, deviceKey);
    try {
      const answer = await device.request('POST', '/v1/worktrees/move', { path: '/not-even-valid-input' });
      expect(answer.status, answer.body).toBe(403);
      expect(JSON.parse(answer.body ?? '{}').code).toBe('grant_device_not_granted');
    } finally {
      device.close();
    }
    expect(await Bun.file(path.join(target, '.git')).exists()).toBe(true);
  }, 20_000);

  it('moves a reviewed adopted worktree through real HTTP and keeps its registry membership', async () => {
    const linked = path.join(repository, 'to-move');
    await setupGit(repository, 'worktree', 'add', '-b', 'move/sit', linked);
    const call = async (method: string, route: string, body?: unknown) =>
      await fetch(`${url}${route}`, {
        method,
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await call('POST', '/v1/worktrees/adopt', { path: linked })).status).toBe(200);
    const listed = await call('GET', `/v1/worktrees/repo?project=${projectId}`);
    expect(listed.status).toBe(200);
    const offer = RepoWorktreeListResponseSchema.parse(await listed.json()).worktrees.find(
      row => row.path === linked,
    )?.move;
    if (offer?.destination === undefined) throw new Error('no safe move was offered');
    const request = MoveProjectWorktreeRequestSchema.parse({
      project: projectId,
      worktreeId: offer.worktreeId,
      reviewedIdentity: offer.reviewedIdentity,
    });
    const moved = await call('POST', '/v1/worktrees/move', request);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ from: linked, to: offer.destination });
    expect(await Bun.file(path.join(offer.destination!, 'README.md')).text()).toBe('# fixture\n');
    const after = await call('GET', `/v1/worktrees/repo?project=${projectId}`);
    expect(
      RepoWorktreeListResponseSchema.parse(await after.json()).worktrees.find(row => row.path === offer.destination)
        ?.tracked,
    ).toBe('adopted');
  }, 30_000);

  it('should reject unauthenticated adoption without creating a marker', async () => {
    const refused = await fetch(`${url}/v1/worktrees/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    expect(refused.status).toBe(401);
    const gitDir = (await setupGit(target, 'rev-parse', '--absolute-git-dir')).trim();
    expect(await Bun.file(path.join(gitDir, 'worktree-owner')).exists()).toBe(false);
  });

  it('should adopt in place via fy and remove only after acknowledging the unpublished branch', async () => {
    const adopted = await fy(['worktree', 'adopt', target, '--json']);
    expect(adopted.code, adopted.err).toBe(0);
    expect(JSON.parse(adopted.out).worktree).toMatchObject({ path: target, origin: 'adopted', branchPreexisted: true });
    const denied = await fy(['worktree', 'rm', target, '--yes']);
    expect(denied.code).toBe(1);
    expect(await Bun.file(path.join(target, '.git')).exists()).toBe(true);
    const removed = await fy(['worktree', 'rm', target, '--yes', '--accept-unpushed', '--json']);
    expect(removed.code, removed.err).toBe(0);
    expect(JSON.parse(removed.out).path).toBe(target);
    expect(await Bun.file(path.join(target, '.git')).exists()).toBe(false);
  });
});
