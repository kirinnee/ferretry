import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFleetManifest } from '../../daemon/lib/manifest.ts';

// Production fyd, synthetic executables only. No model, network, real home or real tmux server is used.
const ROOT = join(import.meta.dir, '../../../../..');
const STAMP = '2026-11-13T00:00:00.000Z';
let root: string;
let home: string;
let url: string;
let admin: string;
let child: ReturnType<typeof Bun.spawn> | undefined;
let logs = '';

async function put(path: string, text: string, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode });
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      'x-ferretry-client': 'cli',
      'x-fy-request-id': crypto.randomUUID(),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-mode-admission-'));
  home = join(root, 'fy-home');
  await put(join(home, 'home.json'), JSON.stringify({ format: 1, createdBy: 'mode-test', createdAt: STAMP }));
  await put(join(home, 'config/limits.yaml'), 'enabled: false\n');
  await put(join(home, 'config/plugins.yaml'), 'plugins:\n  git-accounts: off\n  pulls: off\n  shells: off\n');
  await put(join(home, 'config/runtimes.yaml'), 'defaultRuntime: play\nautoResume: false\n');
  await put(join(home, 'config/harness-claude-code.yaml'), 'permissionMode: auto\nchannels: false\n');
  await put(join(home, 'config/logins/test.yaml'), 'harness: claude-code\nstore: environment\nenv: {}\n');
  await put(join(home, 'config/profiles/plain.yaml'), 'contents: []\n');
  await put(join(home, 'config/runtimes/play.yaml'), 'login: test\nprofile: plain\n');
  await put(join(home, 'state/ferrets/tokens.json'), JSON.stringify({ format: 1, tokens: [] }));
  await put(
    join(home, 'fleet/ids.json'),
    JSON.stringify({
      version: 1,
      runtimes: { play: { id: '00000000-0000-4000-8000-000000000001', formerNames: ['work'] } },
    }),
  );
  const id = '00000000-0000-4000-8000-000000000001';
  const wrapper = join(root, 'bin/play');
  await put(
    join(home, 'fleet/manifest.json'),
    JSON.stringify(
      buildFleetManifest({
        generatedAt: STAMP,
        accounts: [
          {
            id,
            kind: 'claude',
            mode: 'auto',
            wrapper,
            home: join(home, 'fleet/homes', id),
            displayName: 'Synthetic Claude',
            defaultModel: 'synthetic',
            models: [{ id: 'synthetic', displayName: 'Synthetic', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
        runtimes: [
          {
            id,
            name: 'play',
            harness: 'claude',
            credential: 'test',
            profile: 'plain',
            wrapper,
            models: [{ id: 'synthetic', displayName: 'Synthetic', available: true }],
            defaultModel: 'synthetic',
          },
        ],
      }),
    ),
  );
  await mkdir(join(root, 'user-home'), { recursive: true });
  for (const [id, state] of [
    ['auto-running', 'starting'],
    ['auto-stopped', 'stopped'],
  ]) {
    await put(
      join(home, `state/ferrets/${id}/ferret.json`),
      JSON.stringify({
        format: 1,
        id,
        name: id,
        role: 'lead',
        mode: 'auto',
        harness: 'claude-code',
        runner: 'tmux',
        runtime: 'work',
        login: 'test',
        folder: root,
        state,
        birth: 'person',
        createdAt: STAMP,
        stateAt: STAMP,
        harnessConversation: '00000000-0000-4000-8000-000000000002',
      }),
    );
  }
  await put(join(root, 'bin/codex'), '#!/bin/sh\nexit 0\n', 0o700);
  await put(
    join(root, 'bin/claude'),
    `#!/bin/sh
case "$1" in
  --version) echo '2.1.0 (Claude Code)';;
  --help) echo '  --permission-mode <mode> (choices: "default", "acceptEdits", "bypassPermissions")';;
  *) exit 90;;
esac
`,
    0o700,
  );
  // This executable never starts a server or a process. Its launch receipt proves admission reached the runner.
  await put(
    join(root, 'bin/tmux'),
    `#!/bin/sh
case " $* " in
  *' -V '*) echo 'tmux 3.6a';;
  *' has-session '*) exit 1;;
  *' start-server '*) printf 'on\\nDISPLAY\\n';;
  *' source-file '*) cat >/dev/null; echo launch >> '${root}/launches'; echo '%1|';;
  *' display-message '*) echo '3.6a';;
esac
`,
    0o700,
  );
  let port: number | undefined;
  const offset = Math.floor(Math.random() * 20);
  for (let index = 0; index < 20; index++) {
    const candidate = 7480 + ((offset + index) % 20);
    try {
      const probe = Bun.serve({ hostname: '127.0.0.1', port: candidate, fetch: () => new Response('') });
      await probe.stop(true);
      port = candidate;
      break;
    } catch {
      /* another isolated test owns it */
    }
  }
  if (port === undefined) throw new Error('no isolated test port available');
  url = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, join(ROOT, 'packages/core/kernel/host/fyd.ts')], {
    cwd: ROOT,
    env: {
      PATH: `${root}/bin:${process.env.PATH ?? ''}`,
      HOME: join(root, 'user-home'),
      FY_HOME: home,
      FY_PORT: String(port),
      FY_MODEL_CATALOG: 'off',
      FY_LOCAL_MODELS: 'off',
      FY_RELAY_DIRECTORY_ORIGIN: 'off',
      FY_UPDATE_CHECK: 'off',
      FYD_BACKGROUND_DELAY_SECONDS: '0',
      LANG: 'C.UTF-8',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
  };
  void pump(child.stdout as ReadableStream<Uint8Array>);
  void pump(child.stderr as ReadableStream<Uint8Array>);
  const until = Date.now() + 90_000;
  while (!/\bfyd \S+ ready \(/u.test(logs) && Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`fyd exited: ${logs.slice(-3000)}`);
    await Bun.sleep(100);
  }
  if (!/\bfyd \S+ ready \(/u.test(logs)) throw new Error(`fyd not ready: ${logs.slice(-3000)}`);
  admin = (await readFile(join(home, 'state/gate/admin-token'), 'utf8')).trim();
}, 100_000);

afterAll(async () => {
  if (child !== undefined) {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const start = (runtime: string, mode: 'auto' | 'interactive') =>
  call('POST', '/v1/ferrets', {
    folder: root,
    runtime,
    mode,
    ...(mode === 'auto' ? { prompt: 'synthetic admission test' } : { detach: true }),
  });

test('MUST 1: installed Claude without Auto admits normal launches and refuses auto through fyd', async () => {
  const normal = await start('play', 'interactive');
  expect(normal.status, `${normal.text}\n${logs}`).toBe(201);
  const receiptBy = Date.now() + 3000;
  while (!(await Bun.file(join(root, 'launches')).exists()) && Date.now() < receiptBy) await Bun.sleep(30);
  const launches = await readFile(join(root, 'launches'), 'utf8');
  expect(launches).toContain('launch');
  const auto = await start('play', 'auto');
  expect(auto.status, auto.text).toBe(409);
  expect(auto.text).toContain('does not accept Auto mode');
  expect(await readFile(join(root, 'launches'), 'utf8')).toBe(launches);
});

test('MUST 2: former names retain published auto refusals on start', async () => {
  const path = join(home, 'fleet/manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const account of manifest.accounts) account.autoRefusal = 'synthetic wrapper refuses Auto';
  await writeFile(path, JSON.stringify(manifest));
  const auto = await start('work', 'auto');
  expect(auto.status, auto.text).toBe(409);
  expect(auto.text).toContain('synthetic wrapper refuses Auto');
});

test('MUST 2: former names retain published auto refusals on restart', async () => {
  const restart = await call('POST', '/v1/restarts', { scope: 'ids', ids: ['auto-running'], when: 'now' });
  expect(restart.status, restart.text).toBe(200);
  expect(JSON.parse(restart.text)).toMatchObject({
    restarted: [],
    queued: [{ id: 'auto-running', reason: 'blocked' }],
  });
});

test('MUST 2: former names retain published auto refusals on resume', async () => {
  const resume = await call('POST', '/v1/ferrets/auto-stopped/resume', {});
  expect(resume.status, resume.text).toBe(409);
  expect(resume.text).toContain('synthetic wrapper refuses Auto');
});

test('MUST 2: failed published-facts reads refuse auto before launch admission', async () => {
  const path = join(home, 'fleet/manifest.json');
  await rm(path);
  await mkdir(path);
  const auto = await start('play', 'auto');
  expect(auto.status, auto.text).toBe(409);
  expect(auto.text).toContain('auto launch could not be checked');
});
