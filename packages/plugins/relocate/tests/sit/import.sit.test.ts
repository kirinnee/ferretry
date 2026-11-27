import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toBase64Url } from '@ferretry/std/sealing';
import {
  ExportResponseSchema,
  ImportResponseSchema,
  PreflightResponseSchema,
  RelocateOfferSchema,
  TargetPreflightResponseSchema,
} from '../../contract/index.ts';
import { verifiedOfferKey } from '../../daemon/lib/seal.ts';
import { normalizeRemote } from '../../daemon/lib/remote.ts';
import { crypto, newIdentity, openOffer } from '../support/identity.ts';
import { git, makeRepository, REMOTE_URL } from '../support/real-git.ts';

/**
 * Two REAL fyd daemons, each with its own FY_HOME and its own port in 7480-7499, and the app's part played by this test:
 * it holds a session on both and carries ciphertext between them. A is the source: a stopped Claude Code ferret with a real
 * git working tree (commits, a dirty tracked file, new files, an ignored `.env`), a synthetic transcript in A's own history
 * pool and its turns. B is the target: a project that has the same remote.
 *
 * What is proved over real HTTP, real Gate admission, the real kernel signer and real routes: B's offer is signed by B's own
 * identity and A's check accepts it; A seals and the chunks cross; B opens them with its in-memory key and verifies every hash;
 * and when B cannot take the ferret (no Claude login here, which a SIT has no way to sign in) the import is REFUSED with B's
 * disk exactly as it was, and the spent offer cannot be replayed. The path that goes on to start the ferret on B needs a login
 * and a harness CLI; it is proved with real git and real files in `unit/import.test.ts`, and end to end by the two-sandbox
 * acceptance (U16).
 */
const ROOT = path.resolve(import.meta.dir, '../../../../..');
const STAMP = '2026-11-27T00:00:00.000Z';
const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';

interface Machine {
  readonly name: string;
  readonly home: string;
  readonly url: string;
  readonly environment: Record<string, string>;
  admin: string;
  child?: ReturnType<typeof Bun.spawn>;
  daemonId: string;
}

const taken = new Set<number>();
async function claimTestPort(): Promise<number> {
  for (let candidate = 7480; candidate <= 7499; candidate++) {
    if (taken.has(candidate)) continue;
    try {
      const probe = Bun.serve({ hostname: '127.0.0.1', port: candidate, fetch: () => new Response('') });
      await probe.stop(true);
      taken.add(candidate);
      return candidate;
    } catch {
      /* another test owns this port */
    }
  }
  throw new Error('no test port in 7480-7499 is available');
}

let base: string;
let a: Machine;
let b: Machine;
let fixture: ReturnType<typeof makeRepository>;
let targetRepo: string;
let offer: ReturnType<typeof RelocateOfferSchema.parse>;

async function machine(name: string): Promise<Machine> {
  const root = path.join(base, name);
  const home = path.join(root, 'fy-home');
  await mkdir(path.join(home, 'config'), { recursive: true });
  await mkdir(path.join(root, 'user-home'), { recursive: true });
  await writeFile(
    path.join(home, 'home.json'),
    JSON.stringify({ format: 1, createdBy: 'relocate-sit', createdAt: STAMP }),
  );
  await writeFile(path.join(home, 'config/limits.yaml'), 'enabled: false\n');
  await writeFile(path.join(home, 'config/connections.yaml'), 'relay: []\ntunnel:\n  enabled: false\n');
  const port = await claimTestPort();
  const url = `http://127.0.0.1:${port}`;
  return {
    name,
    home,
    url,
    daemonId: '',
    admin: '',
    environment: {
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
    },
  };
}

async function boot(m: Machine): Promise<void> {
  m.child = Bun.spawn(
    [
      process.execPath,
      '--preload',
      path.join(ROOT, 'packages/plugins/relocate/tests/support/loopback-only.ts'),
      path.join(ROOT, 'packages/core/kernel/host/fyd.ts'),
    ],
    {
      cwd: ROOT,
      env: m.environment,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let logs = '';
  let ready = false;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      logs += new TextDecoder().decode(chunk);
      if (/\bfyd \S+ ready \(/u.test(logs)) ready = true;
    }
  };
  void pump(m.child.stdout as ReadableStream<Uint8Array>);
  void pump(m.child.stderr as ReadableStream<Uint8Array>);
  const until = Date.now() + 120_000;
  while (!ready && Date.now() < until) {
    if (m.child.exitCode !== null) throw new Error(`daemon ${m.name} exited: ${logs.slice(-3000)}`);
    await Bun.sleep(200);
  }
  if (!ready) throw new Error(`daemon ${m.name} did not become ready: ${logs.slice(-3000)}`);
  m.admin = (await readFile(path.join(m.home, 'state/gate/admin-token'), 'utf8')).trim();
}

async function call(
  m: Machine,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: any; bytes: Uint8Array }> {
  const response = await fetch(`${m.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${m.admin}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    json = undefined;
  }
  return { status: response.status, json, bytes };
}

/** Every file below `dir` with its bytes, for "B's disk is exactly as it was". */
async function tree(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}:${(await readFile(full)).length}`);
    }
  };
  await walk(dir, '');
  return out.join('\n');
}

beforeAll(async () => {
  base = path.join(tmpdir(), `fy-relocate-sit-${crypto.randomBytes(4).reduce((s, n) => s + n.toString(16), '')}`);
  await mkdir(base, { recursive: true });
  a = await machine('a');
  b = await machine('b');
  fixture = makeRepository();

  // A: a stopped Claude Code ferret in the fixture's working tree, its conversation in A's own history pool, its turns.
  const folder = fixture.folder;
  const spelling = folder.replaceAll(/[^a-zA-Z0-9]/gu, '-');
  const pool = path.join(a.home, 'state/claude-code/history-pool/projects');
  const home = path.join(a.home, 'state/claude-code/agent-homes/f1');
  await mkdir(path.join(pool, spelling), { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  const records = ['hello there', 'a reply'].map((text, index) =>
    JSON.stringify({
      type: index === 0 ? 'user' : 'assistant',
      uuid: `00000000-0000-4000-8000-00000000000${String(index)}`,
      parentUuid: index === 0 ? null : '00000000-0000-4000-8000-000000000000',
      sessionId: CONVERSATION,
      cwd: folder,
      timestamp: STAMP,
      message: { role: index === 0 ? 'user' : 'assistant', content: [{ type: 'text', text }] },
    }),
  );
  await writeFile(path.join(pool, spelling, `${CONVERSATION}.jsonl`), `${records.join('\n')}\n`, { mode: 0o600 });
  await symlink(pool, path.join(home, 'projects'));
  await writeFile(path.join(home, 'conversation.json'), JSON.stringify({ format: 1, id: CONVERSATION, cwd: folder }));
  await mkdir(path.join(a.home, 'state/ferrets/f1'), { recursive: true });
  await writeFile(
    path.join(a.home, 'state/ferrets/f1/launch-references.json'),
    JSON.stringify({ format: 1, names: [] }),
  );
  await writeFile(
    path.join(a.home, 'state/ferrets/f1/ferret.json'),
    JSON.stringify({
      format: 1,
      id: 'f1',
      name: 'mover',
      role: 'lead',
      mode: 'interactive',
      harness: 'claude-code',
      runner: 'tmux',
      folder,
      state: 'stopped',
      birth: 'person',
      harnessConversation: CONVERSATION,
      createdAt: STAMP,
      stateAt: STAMP,
    }),
  );
  await mkdir(path.join(a.home, 'state/ferrets/sessions/f1/turns'), { recursive: true });
  await writeFile(path.join(a.home, 'state/ferrets/sessions/f1/turns/turn-001.md'), 'the assigned task');

  // B: its own clone of the project (the same remote address) registered as a project.
  const machineB = path.join(base, 'b/machine');
  await mkdir(machineB, { recursive: true });
  targetRepo = path.join(machineB, 'project');
  git(machineB, 'clone', '-q', fixture.remote, targetRepo);
  git(targetRepo, 'remote', 'set-url', 'origin', REMOTE_URL);
  await mkdir(path.join(b.home, 'state/projects'), { recursive: true });
  await writeFile(
    path.join(b.home, 'state/projects/projects.json'),
    JSON.stringify({
      format: 1,
      projects: [
        {
          id: '6f1c2a3e-9b4d-4e5f-8a7b-1c2d3e4f5a6b',
          name: 'project',
          path: targetRepo,
          source: 'existing-folder',
          createdAt: STAMP,
          git: { commonDirectory: path.join(targetRepo, '.git') },
          repos: [{ path: '.', remote: normalizeRemote(REMOTE_URL) }],
        },
      ],
    }),
  );
  await boot(a);
  await boot(b);
}, 240_000);

afterAll(async () => {
  for (const m of [a, b]) {
    const child = m?.child;
    if (child === undefined) continue;
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  if (base !== undefined) await rm(base, { recursive: true, force: true });
}, 60_000);

describe('a move between two real daemons (SIT)', () => {
  it('a daemon-held value in a transferred turn refuses export, naming only the secret and file', async () => {
    const value = 'SYNTHETIC-SIT-ONLY-2649';
    const stored = await call(a, 'POST', '/v1/secrets', { name: 'MOVE_TEST_TOKEN', value });
    expect(stored.status).toBe(200);
    const turn = path.join(a.home, 'state/ferrets/sessions/f1/turns/turn-002.md');
    await writeFile(turn, `a transcript line ${value}\n`);
    const opened = await openOffer(await newIdentity(), { expiresAtMs: Date.now() + 120_000 });
    const refused = await call(a, 'POST', '/v1/relocate/f1/export', { offer: opened.offer });
    expect(refused.status).toBe(409);
    const shown = JSON.stringify(refused.json);
    expect(shown.includes(value)).toBe(false);
    expect(shown).toContain('MOVE_TEST_TOKEN');
    expect(shown).toContain('turns/turn-002.md');
    await rm(turn);
    await call(a, 'DELETE', '/v1/secrets/MOVE_TEST_TOKEN');
  });

  it('B opens an offer signed by its own identity, and A accepts it', async () => {
    const opened = await call(b, 'POST', '/v1/relocate/offers');
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);
    offer = RelocateOfferSchema.parse(opened.json);
    expect(offer.daemonId).not.toBe('');
    b.daemonId = offer.daemonId;
    const refused = await call(b, 'POST', '/v1/relocate/offers');
    expect(refused.status).toBe(409);
    // another daemon, its own identity: the offer verifies as B's
    await verifiedOfferKey(crypto, offer, 'fy_daemon_other', Date.now());
  });

  it('A says what a move would carry, and what the target must have', async () => {
    const view = await call(a, 'POST', '/v1/relocate/f1/preflight', { to: b.daemonId });
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    const parsed = PreflightResponseSchema.parse(view.json);
    expect(parsed.ok, parsed.refusals.join('; ')).toBe(true);
    expect(parsed.needs).toMatchObject({ harness: 'claude-code', remote: normalizeRemote(REMOTE_URL) });
    expect(parsed.ignored).toContain('.env');
  });

  it('the sealed bundle crosses A → B; B refuses what it cannot run, writes nothing, and the offer cannot be replayed', async () => {
    const sealed = await call(a, 'POST', '/v1/relocate/f1/export', { offer });
    expect(sealed.status, JSON.stringify(sealed.json)).toBe(200);
    const exported = ExportResponseSchema.parse(sealed.json);
    expect(exported.header.targetDaemonId).toBe(b.daemonId);
    for (let index = 0; index < exported.header.chunks; index += 1) {
      const chunk = await fetch(`${a.url}/v1/relocate/exports/${exported.exportId}/chunks/${String(index)}`, {
        headers: { authorization: `Bearer ${a.admin}` },
      });
      expect(chunk.status).toBe(200);
      const put = await call(b, 'PUT', `/v1/relocate/offers/${offer.offerId}/chunks/${String(index)}`, {
        chunk: toBase64Url(new Uint8Array(await chunk.arrayBuffer())),
      });
      expect(put.status, JSON.stringify(put.json)).toBe(200);
    }

    const needs = PreflightResponseSchema.parse(
      (await call(a, 'POST', '/v1/relocate/f1/preflight', { to: b.daemonId })).json,
    ).needs;
    const looked = TargetPreflightResponseSchema.parse(
      (await call(b, 'POST', `/v1/relocate/offers/${offer.offerId}/preflight`, { needs })).json,
    );
    expect(looked.project).toBe('found');
    expect(looked.ok).toBe(false);
    expect(looked.refusals.join(' ')).toContain('login');

    const before = {
      project: await tree(targetRepo),
      machine: await readdir(path.join(base, 'b/machine')),
      refs: git(targetRepo, 'for-each-ref'),
    };
    const refused = await call(b, 'POST', `/v1/relocate/offers/${offer.offerId}/import`, {
      header: exported.header,
      sourceDaemonId: exported.header.sourceDaemonId,
    });
    expect(refused.status, JSON.stringify(refused.json)).toBe(409);
    expect(refused.json).toMatchObject({ code: 'move_refused' });
    expect({
      project: await tree(targetRepo),
      machine: await readdir(path.join(base, 'b/machine')),
      refs: git(targetRepo, 'for-each-ref'),
    }).toEqual(before);
    const replay = await call(b, 'POST', `/v1/relocate/offers/${offer.offerId}/import`, {
      header: exported.header,
      sourceDaemonId: exported.header.sourceDaemonId,
    });
    expect(replay.json).toMatchObject({ code: 'offer_spent' });
    // A stopped nothing it had not been asked to, and is still the owner of every file
    expect(await readFile(path.join(fixture.folder, 'new.txt'), 'utf8')).toBe('a new file\n');
    void ImportResponseSchema;
  });
});
