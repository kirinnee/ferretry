/**
 * `fy catalog` LISTS, ADDS AND INSTALLS SKILL AND MCP ITEMS ON THE REAL DAEMON REGISTRY (rebuild/catalogs-items; v4 listed
 * "Rich team tools · 1 item", and 5.0 answered every one of these with "Skills is not available to publish or install
 * this item." because no plugin offered `catalog.items`).
 *
 * The REAL daemon registry of this commit, booted over a temp home an owner wrote by hand (one login, one runtime, one
 * profile naming `mcp/acme`, the `acme` server) and a temp project holding one skill. Every answer comes from a route;
 * nothing is faked. Fixtures only: no network, no real home, no credential.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realDaemonRegistry } from '../../../../../scripts/test/two-release/real-release.ts';
import type { DaemonRegistry } from '../../../../../scripts/test/two-release/releases.ts';
import { type StartedDaemon, startDaemon } from '../../../../../scripts/test/two-release/daemon.ts';

let registry: DaemonRegistry;
let daemon: StartedDaemon | undefined;
const folders: string[] = [];

beforeAll(async () => {
  registry = await realDaemonRegistry();
});

afterEach(async () => {
  await daemon?.stop().catch(() => undefined);
  daemon = undefined;
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const OWNER_CONFIG = {
  'logins/claude-you.yaml': 'harness: claude-code\nstore: ferretry\n',
  'runtimes/claude-default.yaml': 'login: claude-you\nprofile: default\nagent: true\n',
  'profiles/default.yaml': 'contents:\n  - mcp/acme\n',
  'mcp/acme.yaml': 'command: npx\nargs:\n  - acme-mcp\n',
} as const;

const SKILL = '---\nname: pdf-tools\ndescription: Split and merge PDFs\n---\nUse the scripts.\n';

async function write(home: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const full = join(home, 'config', path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, text);
  }
}

/** A project with one skill, registered with the daemon by its own route. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-catalog-items-'));
  folders.push(root);
  await mkdir(join(root, '.claude', 'skills', 'pdf-tools', 'scripts'), { recursive: true });
  await writeFile(join(root, '.claude', 'skills', 'pdf-tools', 'SKILL.md'), SKILL);
  await writeFile(join(root, '.claude', 'skills', 'pdf-tools', 'scripts', 'split.sh'), 'echo split\n');
  return root;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, any>;
}

async function call(started: StartedDaemon, method: string, path: string, body?: unknown): Promise<Answer> {
  const token = await started.adminToken();
  const response = await fetch(`${started.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
}

const ok = (answer: Answer, what: string, started: StartedDaemon): Answer => {
  if (answer.status >= 400)
    throw new Error(`${what} answered ${String(answer.status)} ${JSON.stringify(answer.body)}\n${started.diagnose()}`);
  return answer;
};

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function boot(): Promise<{ started: StartedDaemon; root: string }> {
  const root = await project();
  const started = await startDaemon({ name: 'A', daemon: registry } as never, {
    version: '5.0.0',
    seed: async home => await write(home, OWNER_CONFIG),
  });
  daemon = started;
  ok(
    await call(started, 'POST', '/v1/projects', { kind: 'existing-folder', path: root }),
    'registering the project',
    started,
  );
  // The once-after-start publish is a job: the server is in the machine inventory a moment after the listener is up.
  await until(
    async () =>
      (await call(started, 'GET', '/v1/mcp')).body.servers?.map((server: { name: string }) => server.name) ?? [],
    names => names.includes('acme'),
  );
  return { started, root };
}

describe('a catalog on the real daemon lists, adds, exports and installs skill and MCP items', () => {
  test('the list answers (it was 503 "Skills is not available"), and a skill and an MCP server are added from this machine', async () => {
    const { started } = await boot();

    const made = ok(
      await call(started, 'POST', '/v1/catalogs', { name: 'Rich team tools' }),
      'creating the catalog',
      started,
    );
    const id = made.body.id as string;
    const listed = ok(await call(started, 'GET', '/v1/catalogs?sourceState=1'), 'listing the catalogs', started);
    expect(listed.body.catalogs.map((catalog: { name: string }) => catalog.name)).toEqual(['Rich team tools']);

    for (const source of [
      { kind: 'skill', skill: 'pdf-tools' },
      { kind: 'mcp', mcp: 'acme' },
    ]) {
      const preview = ok(
        await call(started, 'POST', `/v1/catalogs/${id}/items/preview`, { source, summary: 'Shared on purpose' }),
        `previewing ${source.kind}`,
        started,
      );
      ok(
        await call(started, 'POST', `/v1/catalogs/${id}/items`, {
          source,
          digest: preview.body.digest,
          summary: 'Shared on purpose',
        }),
        `adding ${source.kind}`,
        started,
      );
    }

    const after = ok(await call(started, 'GET', '/v1/catalogs?sourceState=1'), 'listing again', started);
    expect(after.body.catalogs[0].items.map((item: { name: string }) => item.name).toSorted()).toEqual([
      'acme',
      'pdf-tools',
    ]);
  }, 90_000);

  test('an exported catalog installs its skill into a runtime (item, layer and files) and takes it out again', async () => {
    const { started } = await boot();
    const made = ok(await call(started, 'POST', '/v1/catalogs', { name: 'Rich team tools' }), 'creating', started);
    const id = made.body.id as string;
    const source = { kind: 'skill', skill: 'pdf-tools' };
    const preview = ok(
      await call(started, 'POST', `/v1/catalogs/${id}/items/preview`, { source, summary: 'PDFs' }),
      'preview',
      started,
    );
    ok(
      await call(started, 'POST', `/v1/catalogs/${id}/items`, { source, digest: preview.body.digest, summary: 'PDFs' }),
      'add',
      started,
    );
    const file = ok(await call(started, 'POST', `/v1/catalogs/${id}/export`, {}), 'export', started).body;

    const installPreview = ok(
      await call(started, 'POST', '/v1/catalog-installs/runtime/preview', {
        signedManifest: file.signedManifest,
        item: file.items[0],
        target: { scope: 'runtime', runtime: 'claude-default', profile: 'default' },
      }),
      'previewing the runtime install',
      started,
    );
    const installed = ok(
      await call(started, 'POST', '/v1/catalog-installs/runtime', {
        previewId: installPreview.body.previewId,
        secretBindings: {},
      }),
      'installing into the runtime',
      started,
    );

    const item = await readFile(join(started.home, 'config', 'skills', 'pdf-tools.yaml'), 'utf8');
    expect(item).toContain('pdf-tools');
    expect(item).toContain('installedFrom');
    expect(await readFile(join(started.home, 'config', 'profiles', 'default.yaml'), 'utf8')).toContain(
      'skills/pdf-tools',
    );
    expect(await readFile(join(started.home, 'state', 'skills', 'installed', 'pdf-tools', 'SKILL.md'), 'utf8')).toBe(
      SKILL,
    );
    expect(
      await readFile(join(started.home, 'state', 'skills', 'installed', 'pdf-tools', 'scripts', 'split.sh'), 'utf8'),
    ).toBe('echo split\n');

    const installId = (installed.body.install?.installId ?? installed.body.installId) as string;
    ok(await call(started, 'DELETE', `/v1/catalog-installs/runtime/${installId}`), 'removing the install', started);
    await expect(readFile(join(started.home, 'config', 'skills', 'pdf-tools.yaml'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(started.home, 'config', 'profiles', 'default.yaml'), 'utf8')).not.toContain(
      'skills/pdf-tools',
    );
    await expect(
      readFile(join(started.home, 'state', 'skills', 'installed', 'pdf-tools', 'SKILL.md'), 'utf8'),
    ).rejects.toThrow();
  }, 90_000);

  test('an exported MCP server installs into a project’s .mcp.json', async () => {
    const { started, root } = await boot();
    const made = ok(await call(started, 'POST', '/v1/catalogs', { name: 'Rich team tools' }), 'creating', started);
    const id = made.body.id as string;
    const source = { kind: 'mcp', mcp: 'acme' };
    const preview = ok(
      await call(started, 'POST', `/v1/catalogs/${id}/items/preview`, { source, summary: 'Acme' }),
      'preview',
      started,
    );
    ok(
      await call(started, 'POST', `/v1/catalogs/${id}/items`, { source, digest: preview.body.digest, summary: 'Acme' }),
      'add',
      started,
    );
    const file = ok(await call(started, 'POST', `/v1/catalogs/${id}/export`, {}), 'export', started).body;

    const installPreview = ok(
      await call(started, 'POST', '/v1/catalog-installs/project/preview', {
        signedManifest: file.signedManifest,
        item: file.items[0],
        target: { scope: 'project', projectRoot: root, harness: 'claude' },
      }),
      'previewing the project install',
      started,
    );
    ok(
      await call(started, 'POST', '/v1/catalog-installs/project', {
        previewId: installPreview.body.previewId,
        secretBindings: {},
      }),
      'installing into the project',
      started,
    );
    const written = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(written.mcpServers.acme?.command).toBe('npx');
  }, 90_000);
});
