import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { toBase64Url, WebCryptoSessionCrypto } from '@ferretry/kernel/session';
import type { Machine } from '../../app/lib/move.ts';
import { carry, review } from '../../app/lib/move.ts';
import { MovedDocumentSchema } from '../../contract/index.ts';
import { normalizeRemote } from '../../daemon/lib/remote.ts';
import { deviceClient } from '../support/device-client.ts';
import { git, makeRepository, REMOTE_URL } from '../support/real-git.ts';

setDefaultTimeout(180_000);

/**
 * THE TWO-SANDBOX ACCEPTANCE (C-45, U16): two REAL `fyd` daemons on free ports in 7480-7499, loopback only, each with its own
 * temp FY_HOME and temp HOME, and the app's own move flow (`app/lib/move.ts`, the same functions the dialog calls) driven through
 * a seeded synthetic device paired to each over the DIRECT carrier. No `fy pair`, no pairing code, no real login, no real
 * Claude or Codex: B launches the ferret with a TEST-ONLY scripted harness CLI that only records how it was started.
 *
 * A holds one stopped Claude Code ferret in a real synthetic git worktree (two commits the remote lacks one of, a dirty tracked
 * file, an untracked file, files named like secrets, an ignored `.env`), its transcript, turns and an attachment. The move
 * A → B is asserted point by point below, and every request and answer the device saw is searched for any secret value.
 */
const ROOT = path.resolve(import.meta.dir, '../../../../..');
const STAMP = '2026-11-27T00:00:00.000Z';
const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
/** Synthetic values: the secret B's login holds, and an attachment that is not text. */
const LOGIN_SECRET = 'SYNTHETIC-LOGIN-VALUE-u16-5c1e9a';
const ATTACHMENT = Buffer.from([0, 1, 2, 250, 251, 252, 0, 80, 78, 71, 13, 10, 26, 10, 255]);
const TURN_ONE = 'the assigned task\n';
const TURN_TWO = 'a second turn with “unicode” and a plain line\n';

interface Sandbox {
  readonly name: string;
  readonly home: string;
  readonly url: string;
  readonly environment: Record<string, string>;
  readonly daemonId: string;
  readonly full: { readonly id: string; readonly key: CryptoKey };
  readonly limited: { readonly id: string; readonly key: CryptoKey };
  admin: string;
  child?: ReturnType<typeof Bun.spawn>;
  logs: string;
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

let base = '';
let a: Sandbox;
let b: Sandbox;
let fixture: ReturnType<typeof makeRepository>;
let targetRepo = '';
let scriptedLog = '';

/** Every request and answer a device saw, as text, so a secret value can be searched for in all of it. */
const traffic: {
  readonly machine: string;
  readonly method: string;
  readonly path: string;
  readonly sent: string;
  readonly got: string;
}[] = [];

async function sandbox(name: string): Promise<Sandbox> {
  const root = path.join(base, name);
  const home = path.join(root, 'fy-home');
  const codec = new WebCryptoSessionCrypto();
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const daemonId = (await codec.importDaemonIdentity(pem)).daemonId;
  for (const folder of ['config', 'state/kernel', 'state/access', 'state/projects'])
    await mkdir(path.join(home, folder), { recursive: true });
  await mkdir(path.join(root, 'user-home'), { recursive: true });
  await writeFile(
    path.join(home, 'home.json'),
    JSON.stringify({ format: 1, createdBy: 'relocate-u16-sit', createdAt: STAMP }),
  );
  await writeFile(path.join(home, 'config/limits.yaml'), 'enabled: false\n');
  await writeFile(path.join(home, 'config/connections.yaml'), 'relay: []\ntunnel:\n  enabled: false\n');
  for (const folder of ['', 'state', 'state/kernel', 'state/access', 'state/projects'])
    await chmod(path.join(home, folder), 0o700);
  await writeFile(
    path.join(home, 'state/kernel/identity.json'),
    JSON.stringify({ schemaVersion: 1, privateKeyPem: pem }),
  );
  const seeded = async (suffix: string, grants: object) => {
    const device = await codec.generateDeviceKey();
    return {
      id: `fy_device_id_${suffix.repeat(22)}`,
      key: device.privateKey,
      record: (id: string) => ({
        id,
        daemonId,
        name: `Synthetic ${name} device ${suffix}`,
        platform: 'browser',
        createdAt: STAMP,
        lastSeenAt: new Date().toISOString(),
        publicKey: toBase64Url(device.publicKeySpki),
        grants,
      }),
    };
  };
  const full = await seeded('a', FULL_DEVICE_GRANTS);
  const limited = await seeded('b', LIMITED_DEVICE_GRANTS);
  await writeFile(
    path.join(home, 'state/access/devices.json'),
    JSON.stringify({ format: 1, daemonId, devices: [full.record(full.id), limited.record(limited.id)] }),
  );
  const port = await claimTestPort();
  const url = `http://127.0.0.1:${port}`;
  return {
    name,
    home,
    url,
    daemonId,
    full: { id: full.id, key: full.key },
    limited: { id: limited.id, key: limited.key },
    admin: '',
    logs: '',
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

async function boot(m: Sandbox, extra: Record<string, string> = {}): Promise<void> {
  m.child = Bun.spawn(
    [
      process.execPath,
      '--preload',
      path.join(ROOT, 'packages/plugins/relocate/tests/support/loopback-only.ts'),
      path.join(ROOT, 'packages/core/kernel/host/fyd.ts'),
    ],
    { cwd: ROOT, env: { ...m.environment, ...extra }, stdout: 'pipe', stderr: 'pipe' },
  );
  let ready = false;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      m.logs += new TextDecoder().decode(chunk);
      if (/\bfyd \S+ ready \(/u.test(m.logs)) ready = true;
    }
  };
  void pump(m.child.stdout as ReadableStream<Uint8Array>);
  void pump(m.child.stderr as ReadableStream<Uint8Array>);
  const until = Date.now() + 150_000;
  while (!ready && Date.now() < until) {
    if (m.child.exitCode !== null) throw new Error(`daemon ${m.name} exited: ${m.logs.slice(-3000)}`);
    await Bun.sleep(200);
  }
  if (!ready) throw new Error(`daemon ${m.name} did not become ready: ${m.logs.slice(-3000)}`);
  m.admin = (await readFile(path.join(m.home, 'state/gate/admin-token'), 'utf8')).trim();
}

/** The owner's own loopback token: only for seeding and for reading what is on disk, never for the move. */
async function admin(m: Sandbox, method: string, route: string, body?: unknown) {
  const response = await fetch(`${m.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${m.admin}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

type Device = Awaited<ReturnType<typeof deviceClient>>;
const devices = new Map<string, Device>();
async function deviceOf(m: Sandbox, kind: 'full' | 'limited'): Promise<Device> {
  const key = `${m.name}:${kind}`;
  const known = devices.get(key);
  if (known !== undefined) return known;
  const who = m[kind];
  const device = await deviceClient(m.url, m.daemonId, who.id, who.key);
  devices.set(key, device);
  return device;
}

/**
 * One machine as the app's flow sees it: the plugin's client, every body captured. `owner` is the host's own loopback token
 * (ungoverned, as at the machine: the SIT has no passkey to confirm a governed device's step-up); `full` and `limited` are the
 * synthetic paired devices, over the DIRECT carrier and under the real Gate.
 */
function machineOf(m: Sandbox, kind: 'owner' | 'full' | 'limited' = 'owner'): Machine {
  return {
    daemon: m.daemonId,
    name: m.name,
    press: async act => await act(),
    client: {
      call: (async (route: string, init?: { params?: Record<string, string>; body?: unknown }) => {
        const [method = 'GET', template = ''] = route.split(' ');
        const target = template.replace(/:(\w+)/gu, (_, key: string) => encodeURIComponent(init?.params?.[key] ?? ''));
        const sent = init?.body === undefined ? '' : JSON.stringify(init.body);
        let status: number;
        let bytes: Uint8Array;
        if (kind === 'owner') {
          const response = await fetch(`${m.url}${target}`, {
            method,
            headers: { authorization: `Bearer ${m.admin}`, 'content-type': 'application/json' },
            ...(init?.body === undefined ? {} : { body: sent }),
          });
          status = response.status;
          bytes = new Uint8Array(await response.arrayBuffer());
        } else {
          const answer = await (await deviceOf(m, kind)).request(method, target, init?.body);
          status = answer.status ?? 0;
          bytes = new TextEncoder().encode(answer.body ?? '');
        }
        const got = new TextDecoder('latin1').decode(bytes);
        traffic.push({ machine: m.name, method, path: target, sent, got });
        if (status >= 400) {
          let sentence = String(status);
          try {
            sentence = (JSON.parse(got) as { error?: string }).error ?? sentence;
          } catch {
            /* not JSON */
          }
          throw Object.assign(new Error(sentence), {
            status,
            code: (() => {
              try {
                return (JSON.parse(got) as { code?: string }).code;
              } catch {
                return undefined;
              }
            })(),
          });
        }
        if (route.startsWith('GET /v1/relocate/exports/') && route.includes('/chunks/')) return bytes;
        return bytes.length === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes));
      }) as Machine['client']['call'],
    },
  };
}

/** Every file below `dir`, by relative path, with its SHA-256: "A keeps every original byte". */
async function hashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}/`);
      else if (entry.isFile())
        out[`${prefix}${entry.name}`] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
    }
  };
  await walk(dir, '');
  return out;
}

async function messages(m: Sandbox, ferret: string): Promise<string[]> {
  const page = await admin(m, 'GET', `/v1/ferrets/${ferret}/messages?tail=1`);
  expect(page.status, `${page.text}\n${m.logs.slice(-1500)}`).toBe(200);
  return (page.json.messages as { text: string }[]).map(message => message.text);
}

beforeAll(async () => {
  base = path.join(tmpdir(), `fy-relocate-u16-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(base, { recursive: true });
  a = await sandbox('alpha');
  b = await sandbox('beta');
  fixture = makeRepository();
  await mkdir(path.join(a.home, 'state/ferrets/f1'), { recursive: true });

  // ── A: one stopped Claude Code ferret in the fixture's working tree, with its conversation, turns and an attachment ──
  const folder = fixture.folder;
  const spelling = folder.replaceAll(/[^a-zA-Z0-9]/gu, '-');
  const pool = path.join(a.home, 'state/claude-code/history-pool/projects');
  const agentHome = path.join(a.home, 'state/claude-code/agent-homes/f1');
  await mkdir(path.join(pool, spelling), { recursive: true, mode: 0o700 });
  await mkdir(agentHome, { recursive: true, mode: 0o700 });
  const records = ['hello there', 'a reply', 'one more question', 'one more answer'].map((text, index) =>
    JSON.stringify({
      type: index % 2 === 0 ? 'user' : 'assistant',
      uuid: `00000000-0000-4000-8000-00000000000${String(index)}`,
      parentUuid: index === 0 ? null : `00000000-0000-4000-8000-00000000000${String(index - 1)}`,
      sessionId: CONVERSATION,
      cwd: folder,
      timestamp: `2026-11-01T10:0${String(index)}:00.000Z`,
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index % 2 === 0 ? text : [{ type: 'text', text }],
      },
    }),
  );
  await writeFile(path.join(pool, spelling, `${CONVERSATION}.jsonl`), `${records.join('\n')}\n`, { mode: 0o600 });
  await symlink(pool, path.join(agentHome, 'projects'));
  await writeFile(
    path.join(agentHome, 'conversation.json'),
    JSON.stringify({ format: 1, id: CONVERSATION, cwd: folder }),
  );
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
  const session = path.join(a.home, 'state/ferrets/sessions/f1');
  await mkdir(path.join(session, 'turns'), { recursive: true });
  await mkdir(path.join(session, 'attachments/a1'), { recursive: true });
  await writeFile(path.join(session, 'turns/turn-001.md'), TURN_ONE);
  await writeFile(path.join(session, 'turns/turn-002.md'), TURN_TWO);
  await writeFile(path.join(session, 'attachments/a1/pic.png'), ATTACHMENT);
  for (const folderName of [
    '',
    'state',
    'state/claude-code',
    'state/claude-code/agent-homes',
    'state/claude-code/history-pool',
  ])
    await chmod(path.join(a.home, folderName), 0o700);

  // ── B: its own clone of the project (the same remote address), a login for Claude Code, and the scripted harness CLI ──
  const machineB = path.join(base, 'beta/machine');
  await mkdir(machineB, { recursive: true });
  targetRepo = path.join(machineB, 'project');
  git(machineB, 'clone', '-q', fixture.remote, targetRepo);
  git(targetRepo, 'remote', 'set-url', 'origin', REMOTE_URL);
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
  for (const [file, text] of [
    [
      'config/logins/synthetic.yaml',
      'harness: claude-code\nstore: environment\nlabel: Synthetic\nenv:\n  ANTHROPIC_AUTH_TOKEN: ${secret:SIT_LOGIN_TOKEN}\n',
    ],
    ['config/profiles/plain.yaml', 'contents: []\n'],
    ['config/runtimes/claude-default.yaml', 'login: synthetic\nprofile: plain\n'],
  ] as const) {
    await mkdir(path.dirname(path.join(b.home, file)), { recursive: true });
    await writeFile(path.join(b.home, file), text);
  }
  // TEST-ONLY harness CLI: it only records how it was started, then waits; no real Claude or Codex is ever started.
  scriptedLog = path.join(base, 'beta/scripted-harness.log');
  // It is named `claude` and sits first on B's PATH, which is what the daemon's test-mode guard requires before any launch.
  await mkdir(path.join(base, 'beta/bin'), { recursive: true });
  const scripted = path.join(base, 'beta/bin/claude');
  await writeFile(
    scripted,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.327 (Claude Code)"; exit 0; fi',
      `printf 'cwd=%s\\nargs=%s\\n' "$PWD" "$*" >> '${scriptedLog}'`,
      'exec sleep 240',
      '',
    ].join('\n'),
  );
  await chmod(scripted, 0o755);
  // B's whole PATH: the scripted CLI first, the two tools the daemon needs (linked from where this box has them) and the system
  // folders. No real claude or codex can be reached, which is what the daemon's test-mode guard proves before a launch.
  for (const tool of ['git', 'tmux']) {
    const found = Bun.which(tool);
    if (found === null) throw new Error(`${tool} is needed for the two-daemon acceptance`);
    await symlink(found, path.join(base, 'beta/bin', tool));
  }

  await boot(a);
  await boot(b, { FY_CLAUDE_BIN: scripted, PATH: `${path.dirname(scripted)}:/usr/bin:/bin` });
  for (const m of [a, b]) {
    const security = await admin(m, 'PATCH', '/v1/security', { unlockOnOpen: false });
    expect(security.status, security.text).toBe(200);
  }
  const stored = await admin(b, 'POST', '/v1/secrets', { name: 'SIT_LOGIN_TOKEN', value: LOGIN_SECRET });
  expect(stored.status, stored.text).toBe(200);
  // The login names a secret, so the owner confirms it (the loosening is held for them): as the owner would at the machine.
  const held = (await admin(b, 'GET', '/v1/config/status')).json.pending as { path: string; etag: string }[];
  for (const pending of held.filter(item => item.path.startsWith('logins/'))) {
    const confirmed = await admin(b, 'POST', '/v1/config/confirm', { path: pending.path, etag: pending.etag });
    expect(confirmed.status, confirmed.text).toBe(200);
  }
}, 360_000);

afterAll(async () => {
  for (const device of devices.values()) device.close();
  for (const m of [a, b]) {
    const child = m?.child;
    if (child === undefined) continue;
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    // the daemon's own private tmux server (its socket is inside this sandbox's FY_HOME), asked to stop by its own socket
    const socket = path.join(m.home, 'state/terminals/tmux.sock');
    if (
      await stat(socket).then(
        () => true,
        () => false,
      )
    )
      await Bun.spawn(['tmux', '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;
  }
  if (base !== '') await rm(base, { recursive: true, force: true });
}, 60_000);

describe('moving a ferret between two real daemons, driven by the app’s own flow (SIT)', () => {
  const sourceBefore: {
    tree?: Record<string, string>;
    transcript?: Buffer;
    messages?: string[];
    head?: string;
    diff?: string;
  } = {};
  let moved: Awaited<ReturnType<typeof carry>>;
  let reviewed: Awaited<ReturnType<typeof review>>;

  it('shows what moves and what stays, and both machines agree it can go', async () => {
    sourceBefore.tree = {
      ...(await hashes(path.join(a.home, 'state/ferrets/f1'))),
      ...Object.fromEntries(
        Object.entries(await hashes(path.join(a.home, 'state/ferrets/sessions/f1'))).map(([k, v]) => [
          `sessions/${k}`,
          v,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(await hashes(path.join(a.home, 'state/claude-code'))).map(([k, v]) => [`claude-code/${k}`, v]),
      ),
    };
    sourceBefore.messages = await messages(a, 'f1');
    sourceBefore.head = git(fixture.folder, 'rev-parse', 'HEAD');
    sourceBefore.diff = git(fixture.folder, 'diff', 'HEAD');
    reviewed = await review('f1', machineOf(a), machineOf(b));
    expect(reviewed.refusals, reviewed.refusals.join('; ')).toEqual([]);
    expect(reviewed.ok).toBe(true);
    expect(reviewed.source.moves.map(row => row.id)).toContain('conversation');
    expect(reviewed.source.stays.map(row => row.id)).toEqual(
      expect.arrayContaining(['ignored-files', 'secret-values']),
    );
    expect(reviewed.source.ignored).toContain('.env');
    expect(reviewed.source.withheld).toEqual(expect.arrayContaining(['.env.local', 'deploy.pem']));
    expect(reviewed.target.project).toBe('found');
    expect(reviewed.target.missingSecrets).toEqual([]);
  });

  it('seals on A, carries every chunk A → B and starts the ferret on B’s own login', async () => {
    const steps: string[] = [];
    moved = await carry('f1', machineOf(a), machineOf(b), reviewed, { onProgress: p => steps.push(p.step) });
    expect(steps).toEqual(expect.arrayContaining(['sealing', 'carrying', 'receiving', 'finishing', 'done']));
    expect(moved.received.recovery, JSON.stringify(moved.received.recovery)).toBeUndefined();
    expect(moved.stub).toBe('marked');
    expect(moved.received.movedFrom).toEqual({ daemonId: a.daemonId, ferretId: 'f1' });
    expect(moved.received.ferretId).not.toBe('f1');
  });

  it('B’s working tree has the same HEAD, the same uncommitted diff and the untracked file, and no secret file', async () => {
    const folder = moved.received.folder;
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(sourceBefore.head as string);
    expect(git(folder, 'diff', 'HEAD')).toBe(sourceBefore.diff as string);
    expect(await readFile(path.join(folder, 'new.txt'), 'utf8')).toBe('a new file\n');
    for (const name of ['.env', '.env.local', 'deploy.pem'])
      expect(
        await stat(path.join(folder, name)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    expect(
      await stat(path.join(folder, 'node_modules')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it('the turns and the attachment are byte-identical on B, in the new ferret’s own session folder', async () => {
    const session = path.join(b.home, 'state/ferrets/sessions', moved.received.ferretId);
    expect((await readFile(path.join(session, 'turns/turn-001.md'))).equals(Buffer.from(TURN_ONE))).toBe(true);
    expect((await readFile(path.join(session, 'turns/turn-002.md'))).equals(Buffer.from(TURN_TWO))).toBe(true);
    expect((await readFile(path.join(session, 'attachments/a1/pic.png'))).equals(ATTACHMENT)).toBe(true);
    // only the three folders a move restores came from A; whatever else is in the folder B made for itself
    const credential = await readFile(path.join(session, 'environment.json'), 'utf8').catch(() => '');
    expect(credential.includes(a.daemonId)).toBe(false);
  });

  it('B’s reader shows the same transcript, and the scripted harness was launched in B’s own tree', async () => {
    expect(await messages(b, moved.received.ferretId)).toEqual(sourceBefore.messages as string[]);
    const until = Date.now() + 30_000;
    let launched = '';
    while (Date.now() < until && launched === '') {
      launched = await readFile(scriptedLog, 'utf8').catch(() => '');
      if (launched === '') await Bun.sleep(300);
    }
    expect(launched, b.logs.slice(-2000)).toContain(`cwd=${moved.received.folder}`);
    const listed = await admin(b, 'GET', `/v1/ferrets/${moved.received.ferretId}`);
    expect(listed.status, listed.text).toBe(200);
    const received = JSON.parse(await readFile(path.join(b.home, 'state/relocate/received.json'), 'utf8'));
    expect(received.received[moved.received.ferretId]).toMatchObject({ daemonId: a.daemonId, ferretId: 'f1' });
  });

  it('A keeps every original byte as a stub that says where the ferret went', async () => {
    const after = {
      ...(await hashes(path.join(a.home, 'state/ferrets/f1'))),
      ...Object.fromEntries(
        Object.entries(await hashes(path.join(a.home, 'state/ferrets/sessions/f1'))).map(([k, v]) => [
          `sessions/${k}`,
          v,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(await hashes(path.join(a.home, 'state/claude-code'))).map(([k, v]) => [`claude-code/${k}`, v]),
      ),
    };
    expect(after).toEqual(sourceBefore.tree as Record<string, string>);
    expect(git(fixture.folder, 'rev-parse', 'HEAD')).toBe(sourceBefore.head as string);
    expect(await readFile(path.join(fixture.folder, '.env'), 'utf8')).toBe(`${fixture.secrets['.env']}\n`);
    const ledger = MovedDocumentSchema.parse(await machineOf(a).client.call('GET /v1/relocate/moved'));
    expect(ledger.moved.f1).toMatchObject({ daemonId: b.daemonId, ferretId: moved.received.ferretId });
    const still = await admin(a, 'GET', '/v1/ferrets/f1');
    expect(still.status, still.text).toBe(200);
  });

  it('no secret value, key or plaintext crossed anywhere the app could see', () => {
    const everything = traffic.map(line => `${line.sent}\n${line.got}`).join('\n');
    expect(traffic.length).toBeGreaterThan(8);
    for (const value of [LOGIN_SECRET, ...Object.values(fixture.secrets)])
      expect(everything.includes(value)).toBe(false);
    // the app carries ciphertext only: not a word of the transcript, the turns, the diff or the attachment
    for (const plain of ['hello there', 'one more answer', 'the assigned task', 'a new file', 'changed'])
      expect(everything.includes(plain)).toBe(false);
    expect(everything.includes(ATTACHMENT.toString('base64'))).toBe(false);
    expect(/BEGIN (PRIVATE|OPENSSH) /u.test(everything)).toBe(false);
  });

  it('a limited device is refused on both machines, and nothing changed there', async () => {
    const limitedA = machineOf(a, 'limited');
    const limitedB = machineOf(b, 'limited');
    const refusedB = await limitedB.client
      .call('POST /v1/relocate/offers')
      .catch((error: { status?: number }) => error);
    expect((refusedB as { status?: number }).status).toBe(403);
    const refusedA = await limitedA.client
      .call('POST /v1/relocate/:ferretId/preflight', { params: { ferretId: 'f1' }, body: { to: b.daemonId } })
      .catch((error: { status?: number }) => error);
    expect((refusedA as { status?: number }).status).toBe(403);
    // and a read of where ferrets went is the fleet's use, which that device keeps
    const seen = await limitedA.client.call('GET /v1/relocate/moved');
    expect(MovedDocumentSchema.parse(seen).moved.f1?.daemonId).toBe(b.daemonId);
  });

  it('a governed device holding every grant is still asked for its passkey on each machine before any step', async () => {
    // The SIT has no passkey to give, so this is the Gate's own answer: the app's `press` is what raises that prompt, per machine.
    const fullA = machineOf(a, 'full');
    const fullB = machineOf(b, 'full');
    for (const refused of [
      await fullB.client.call('POST /v1/relocate/offers').catch((error: unknown) => error),
      await fullA.client
        .call('POST /v1/relocate/:ferretId/preflight', { params: { ferretId: 'f1' }, body: { to: b.daemonId } })
        .catch((error: unknown) => error),
    ])
      expect((refused as { code?: string }).code).toBe('grant_step_up_required');
  });
});
