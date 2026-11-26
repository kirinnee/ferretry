import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, rename } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { FerretRecordSchema } from '@ferretry/core-ferrets/contract';
import { ProjectInfoSchema } from '@ferretry/plugin-projects/contract';
import { cleanupTempDirectories, setupGit, tempDirectory, tempRemote, tempRepository } from './support/repository.ts';
import { deviceClient } from './support/device.ts';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { WebCryptoSessionCrypto, toBase64Url } from '@ferretry/kernel/session';
import { TidyWorktreesSchema, TidyWorktreeRemoveResultSchema } from '../../contract/index.ts';

const ROOT = path.resolve(import.meta.dir, '../../../../..');
const STAMP = '2026-11-16T00:00:00.000Z';
const projectId = '00000000-0000-4000-8000-000000000001';
let child: ReturnType<typeof Bun.spawn> | undefined;
let home: string;
let repository: string;
let target: string;
let url: string;
let admin: string;
let daemonId: string;
let deviceKey: CryptoKey;
let pullFile: string;
const deviceId = `fy_device_id_${'a'.repeat(22)}`;
const pullAnswers: Record<string, unknown> = {};

beforeAll(async () => {
  const root = await tempDirectory('tidy-worktrees-sit');
  home = path.join(root, 'fy-home');
  repository = (await tempRepository('tidy-worktrees-sit-repo')).root;
  await tempRemote(repository, 'origin', 'main');
  await setupGit(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  target = path.join(repository, 'linked');
  await setupGit(repository, 'worktree', 'add', '-b', 'feature', target);
  await setupGit(target, 'push', '-u', 'origin', 'feature');
  const head = (await setupGit(target, 'rev-parse', 'HEAD')).trim();
  for (const folder of ['config', 'state/ferrets/F1', 'state/projects', 'state/kernel', 'state/access'])
    await mkdir(path.join(home, folder), { recursive: true });
  const codec = new WebCryptoSessionCrypto();
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  daemonId = (await codec.importDaemonIdentity(pem)).daemonId;
  const device = await codec.generateDeviceKey();
  deviceKey = device.privateKey;
  await Bun.write(
    path.join(home, 'state/kernel/identity.json'),
    JSON.stringify({ schemaVersion: 1, privateKeyPem: pem }),
  );
  await Bun.write(
    path.join(home, 'state/access/devices.json'),
    JSON.stringify({
      format: 1,
      daemonId,
      devices: [
        {
          id: deviceId,
          daemonId,
          name: 'Synthetic use-only device',
          platform: 'browser',
          createdAt: STAMP,
          lastSeenAt: new Date().toISOString(),
          publicKey: toBase64Url(device.publicKeySpki),
          grants: { ...FULL_DEVICE_GRANTS, filesystem: { use: true, configure: false } },
        },
      ],
    }),
  );
  await mkdir(path.join(root, 'user-home'));
  await Bun.write(path.join(home, 'home.json'), JSON.stringify({ format: 1, createdBy: 'tidy-sit', createdAt: STAMP }));
  await Bun.write(path.join(home, 'config/limits.yaml'), 'enabled: false\n');
  await Bun.write(path.join(home, 'config/plugins.yaml'), 'work: on\n');
  await Bun.write(
    path.join(home, 'state/ferrets/F1/ferret.json'),
    JSON.stringify(
      FerretRecordSchema.parse({
        format: 1,
        id: 'F1',
        name: 'tidy-fixture',
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
  await Bun.write(
    path.join(home, 'state/projects/projects.json'),
    JSON.stringify({
      format: 1,
      projects: [
        ProjectInfoSchema.parse({
          id: projectId,
          name: 'Synthetic',
          path: repository,
          source: 'existing-folder',
          createdAt: STAMP,
          git: { commonDirectory: path.join(repository, '.git') },
          repos: [{ path: '.', remote: 'https://github.com/synthetic/repo', provider: 'github' }],
        }),
      ],
    }),
  );
  // Only the external PR port is synthetic. The daemon, HTTP router, Gate, project join, Git and removal are real.
  const preload = path.join(root, 'pulls-preload.ts');
  pullFile = path.join(root, 'pulls.json');
  pullAnswers.feature = merged('feature', head);
  await Bun.write(pullFile, JSON.stringify(pullAnswers));
  const branchModule = path.join(ROOT, 'packages/plugins/pulls/daemon/features/branches/index.ts');
  await Bun.write(
    preload,
    `import { mock } from 'bun:test';
mock.module(${JSON.stringify(branchModule)}, () => ({
  branchesRoutes: () => ({ 'GET /v1/pulls/:project/:repo/branches': async () => ({ status: 503, headers: new Map(), body: '{}' }) }),
  branchPullsPort: () => ({ branchPulls: async (_project, _repo, branches) => {
    const answers = JSON.parse(await Bun.file(${JSON.stringify(pullFile)}).text());
    return branches.flatMap(branch => answers[branch] ?? []);
  } })
}));`,
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
  child = Bun.spawn([process.execPath, '--preload', preload, path.join(ROOT, 'packages/core/kernel/host/fyd.ts')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: path.join(root, 'user-home'),
      FY_HOME: home,
      FY_PORT: String(port),
      LANG: 'C.UTF-8',
      FY_MODEL_CATALOG: 'off',
      FY_LOCAL_MODELS: 'off',
      FY_RELAY_DIRECTORY_ORIGIN: 'off',
      FY_UPDATE_CHECK: 'off',
      FYD_BACKGROUND_DELAY_SECONDS: '3600',
    },
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
}, 100_000);

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

const call = async (method: string, route: string, body?: unknown) =>
  await fetch(`${url}${route}`, {
    method,
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function merged(branch: string, headSha: string) {
  return {
    branch,
    outcome: 'pull' as const,
    pull: {
      number: 1,
      state: 'merged' as const,
      headSha,
      createdAt: STAMP,
      mergedAt: STAMP,
      url: 'https://github.com/synthetic/repo/pull/1',
    },
  };
}

async function tree(branch: string) {
  const target = path.join(repository, branch);
  await setupGit(repository, 'worktree', 'add', '-b', branch, target);
  await Bun.write(path.join(target, 'README.md'), `# ${branch}\n`);
  await setupGit(target, 'commit', '-am', `feat: ${branch}`);
  await setupGit(target, 'push', '-u', 'origin', branch);
  const head = (await setupGit(target, 'rev-parse', 'HEAD')).trim();
  expect((await call('POST', '/v1/worktrees/adopt', { path: target })).status).toBe(200);
  pullAnswers[branch] = merged(branch, head);
  await Bun.write(pullFile, JSON.stringify(pullAnswers));
  return { target, branch, head };
}

async function verdict(target: string) {
  const response = await call('GET', `/v1/tidy/worktrees/${projectId}`);
  expect(response.status).toBe(200);
  return TidyWorktreesSchema.parse(await response.json()).rows.find(row => row.worktree.path === target);
}

async function apply(target: string) {
  const response = await call('POST', `/v1/tidy/worktrees/${projectId}/remove`, { paths: [target] });
  expect(response.status).toBe(200);
  return TidyWorktreeRemoveResultSchema.parse(await response.json());
}

describe('Tidy worktrees through the real daemon', () => {
  test('requires authentication before reading a verdict or an apply body', async () => {
    for (const [method, suffix] of [
      ['GET', ''],
      ['POST', '/remove'],
      ['POST', '/clean-merged'],
    ]) {
      const response = await fetch(`${url}/v1/tidy/worktrees/${projectId}${suffix}`, { method });
      expect(response.status).toBe(401);
    }
  });

  test('the real Gate refuses a filesystem.use-only device before any removal body is processed', async () => {
    expect((await call('PATCH', '/v1/security', { unlockOnOpen: false })).status).toBe(200);
    const device = await deviceClient(url, daemonId, deviceId, deviceKey);
    try {
      for (const [method, suffix] of [
        ['GET', ''],
        ['POST', '/remove'],
        ['POST', '/clean-merged'],
      ]) {
        const response = await device.request(method!, `/v1/tidy/worktrees/${projectId}${suffix}`, { paths: [target] });
        expect(response.status, response.body).toBe(403);
        expect(JSON.parse(response.body ?? '{}').code).toBe('grant_device_not_granted');
      }
      expect(await Bun.file(path.join(target, '.git')).exists()).toBe(true);
    } finally {
      device.close();
    }
  }, 20_000);

  test('adopt, list, and bulk-remove only the reviewed merged paths, with removed/skipped results', async () => {
    expect((await call('POST', '/v1/worktrees/adopt', { path: target })).status).toBe(200);
    const response = await call('GET', `/v1/tidy/worktrees/${projectId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const view = TidyWorktreesSchema.parse(await response.json());
    expect(view.rows.find(row => row.worktree.path === target)?.verdict.removable).toBe(true);
    expect(view.rows.find(row => row.worktree.main)?.verdict.removable).toBe(false);
    const result = await call('POST', `/v1/tidy/worktrees/${projectId}/clean-merged`, { paths: [target, repository] });
    expect(result.status).toBe(200);
    const applied = TidyWorktreeRemoveResultSchema.parse(await result.json());
    expect(applied.removed.map(row => row.path)).toEqual([target]);
    expect(applied.skipped.map(row => row.path)).toEqual([repository]);
    expect(await Bun.file(path.join(target, '.git')).exists()).toBe(false);
    expect(await Bun.file(path.join(repository, 'README.md')).exists()).toBe(true);
  }, 30_000);

  test('apply re-reads a PR reopened after the displayed verdict', async () => {
    const w = await tree('reopened');
    expect((await verdict(w.target))?.verdict.removable).toBe(true);
    pullAnswers[w.branch] = { ...merged(w.branch, w.head), pull: { ...merged(w.branch, w.head).pull, state: 'open' } };
    await Bun.write(pullFile, JSON.stringify(pullAnswers));
    const result = await apply(w.target);
    expect(result.removed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('open');
    expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(true);
  }, 30_000);

  test('apply refuses a swapped folder even when the replacement copies its Git metadata', async () => {
    const w = await tree('swapped');
    expect((await verdict(w.target))?.verdict.removable).toBe(true);
    await rename(w.target, `${w.target}-original`);
    await mkdir(w.target);
    await Bun.write(path.join(w.target, '.git'), await Bun.file(path.join(`${w.target}-original`, '.git')).text());
    await Bun.write(path.join(w.target, 'README.md'), '# swapped\n');
    expect((await apply(w.target)).removed).toEqual([]);
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# swapped\n');
  }, 30_000);

  test('a squash-merged exact head can be removed even though Git says it is not integrated', async () => {
    const w = await tree('squashed');
    await setupGit(repository, 'merge', '--squash', w.branch);
    await setupGit(repository, 'commit', '-m', 'feat: squash');
    await setupGit(repository, 'push', 'origin', 'main');
    const row = await verdict(w.target);
    expect(row?.worktree.live.integrated).toBe(false);
    expect(row?.verdict.removable).toBe(true);
    expect((await apply(w.target)).removed.map(row => row.path)).toEqual([w.target]);
  }, 30_000);

  test('clean published work after merge is kept, and core rechecks the expected head at removal', async () => {
    const w = await tree('new-work');
    expect((await verdict(w.target))?.verdict.removable).toBe(true);
    await Bun.write(path.join(w.target, 'README.md'), '# more work\n');
    await setupGit(w.target, 'commit', '-am', 'feat: after merge');
    await setupGit(w.target, 'push', 'origin', w.branch);
    expect((await apply(w.target)).removed).toEqual([]);
    const guarded = await call('POST', '/v1/worktrees/remove', {
      path: w.target,
      expectedHead: w.head,
      overrides: [],
      deleteBranch: false,
      confirmations: [],
    });
    expect(guarded.status).toBe(409);
    expect(await Bun.file(path.join(w.target, 'README.md')).text()).toBe('# more work\n');
  }, 30_000);
});
