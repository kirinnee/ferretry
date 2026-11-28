import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { RelocationStubsFile } from '../../contract/state/relocation-stubs.state.ts';
import type { FerretsService } from '../../daemon/lib/ferrets/service.ts';
import { repointRuntime } from '../../daemon/lib/ferrets/runtime-records.ts';
import { describe, expect, test } from 'bun:test';
import type { FerretId, StatePort } from '@ferretry/kernel/contract';
import { FERRET_READABLE_FOLDERS, Harnesses, JobKeeper } from '../../contract/index.ts';
import relocationFeature, {
  RelocationFence,
  relocationPortFor,
} from '../../daemon/features/relocation-source.feature.ts';
import type { FerretsContext } from '../../daemon/features/types.ts';

const ID = 'f-move-1' as FerretId;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

interface Node {
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly bytes?: Uint8Array;
  readonly links?: number;
}

/** A session folder in memory: every name under it and what it is, as the kernel's `sessions` root reports it. */
function sessionFolder(files: Readonly<Record<string, Node>>) {
  const names = Object.keys(files);
  const root = {
    resolve: (relative: string) =>
      relative.startsWith('/') || relative.split('/').includes('..')
        ? { ok: false as const, error: 'outside' }
        : { ok: true as const, value: relative },
    entries: async (path: string) => {
      const prefix = path === '' ? '' : `${path}/`;
      const direct = new Map<string, Node>();
      for (const name of names)
        if (name.startsWith(prefix)) {
          const rest = name.slice(prefix.length);
          const head = rest.split('/')[0] as string;
          direct.set(head, rest.includes('/') ? { kind: 'directory' } : (files[name] as Node));
        }
      if (direct.size === 0) throw Object.assign(new Error('no such folder'), { code: 'ENOENT' });
      return [...direct].map(([name, node]) => ({
        name,
        kind: node.kind,
        size: node.bytes?.length ?? 0,
        links: node.links ?? 1,
        mode: 0o600,
        modified: '2026-11-27T00:00:00.000Z',
      }));
    },
    lstat: async (path: string) => {
      const node =
        files[path] ?? (names.some(name => name.startsWith(`${path}/`)) ? { kind: 'directory' as const } : undefined);
      return node === undefined
        ? undefined
        : { kind: node.kind, size: node.bytes?.length ?? 0, links: node.links ?? 1, mode: 0o600, modified: '' };
    },
    readBytes: async (path: string, limit?: number) => {
      const bytes = files[path]?.bytes ?? new Uint8Array();
      return bytes.slice(0, limit);
    },
  };
  return root;
}

const SESSION: Readonly<Record<string, Node>> = {
  'turns/turn-001.md': { kind: 'file', bytes: text('task') },
  'turns/turn-001.by.json': { kind: 'file', bytes: text('{}') },
  'channel/queued-s1.md': { kind: 'file', bytes: text('queued') },
  'attachments/a1/photo.txt': { kind: 'file', bytes: text('photo') },
  'attachments/link': { kind: 'symlink' },
  'attachments/hard.txt': { kind: 'file', bytes: text('hard'), links: 2 },
  // beside the readable folders, and never listed or readable through the member
  'environment.json': { kind: 'file', bytes: text('SESSION-CREDENTIAL') },
  'effects/ledger.json': { kind: 'file', bytes: text('ledger') },
  'media/pic.png': { kind: 'file', bytes: text('media') },
  done: { kind: 'file', bytes: text('marker') },
};

function build(options: {
  readonly files?: Readonly<Record<string, Node>>;
  readonly state?: string;
  readonly jobs?: readonly { readonly state: string }[];
  readonly packConversation?: () => Promise<unknown>;
  readonly known?: boolean;
  readonly listingError?: { readonly path: string; readonly code: string };
  readonly names?: readonly string[];
  readonly namesUnreadable?: boolean;
  readonly peers?: readonly { id: string; folder: string }[];
}) {
  const harness = { packConversation: options.packConversation };
  const folder = sessionFolder(options.files ?? SESSION);
  const entries = folder.entries;
  folder.entries = async path => {
    if (options.listingError?.path === path)
      throw Object.assign(new Error(`synthetic ${options.listingError.code}`), { code: options.listingError.code });
    return await entries(path);
  };
  const context = {
    kernel: {
      state: {
        read: async () =>
          options.namesUnreadable
            ? { ok: false }
            : { ok: true, value: options.names === undefined ? undefined : { names: options.names } },
      },
    },
    hooks: {
      contributions: (token: unknown) =>
        token === JobKeeper && options.jobs !== undefined ? [{ item: { jobs: async () => options.jobs } }] : [],
      provider: (token: unknown) => (token === Harnesses ? harness : 'unavailable'),
    },
    registry: {
      list: () => options.peers ?? [{ id: ID, folder: '/work' }],
      get: (id: string) =>
        options.known === false || id !== ID
          ? undefined
          : { state: options.state ?? 'idle', harness: 'claude-code', folder: '/work' },
    },
    sessionFiles: { root: () => folder },
    sessionStore: {
      replay: async (_id: string, after: number) =>
        after === 0
          ? {
              events: [
                { sequence: 1, type: 'a' },
                { sequence: 2, type: 'b' },
              ],
              hasMore: true,
              nextSequence: 2,
            }
          : { events: [{ sequence: 3, type: 'c' }], hasMore: false },
    },
    ready: async () => {},
  } as unknown as FerretsContext;
  const contribution = relocationFeature.register(context);
  return contribution?.port?.relocationSource as (
    ferret: FerretId,
  ) => Promise<import('../../contract/index.ts').RelocationSource | undefined>;
}

describe('relocationSource lists a closed set', () => {
  test('launch references are names only, and missing/unreadable metadata refuses rather than claiming none', async () => {
    expect(await (await build({ names: ['MCP_TOKEN', 'ENV_TOKEN'] })(ID))?.secretNames()).toEqual([
      'MCP_TOKEN',
      'ENV_TOKEN',
    ]);
    await expect((await build({})(ID))?.secretNames()).rejects.toThrow('launch secret names');
    await expect((await build({ namesUnreadable: true })(ID))?.secretNames()).rejects.toThrow('launch secret names');
  });
  test('only turns/, channel/ and attachments/ and the journal; never environment.json, the ledger, media or markers', async () => {
    const source = await build({})(ID);
    const files = await source?.files();
    const listed = files?.map(file => `${file.area}:${file.path}`) ?? [];
    expect(listed).toEqual([
      'session:turns/turn-001.by.json',
      'session:turns/turn-001.md',
      'session:channel/queued-s1.md',
      'session:attachments/a1/photo.txt',
      'history:history.jsonl',
    ]);
    expect([...FERRET_READABLE_FOLDERS].sort()).toEqual(['attachments', 'channel', 'turns']);
    const joined = listed.join('\n');
    for (const hidden of ['environment', 'effects', 'media', 'done', 'link', 'hard.txt'])
      expect(joined).not.toContain(hidden);
  });

  test('a link and a file with a second hard link are never listed, and read answers only what is listed', async () => {
    const source = await build({})(ID);
    await expect(source?.read({ area: 'session', path: 'environment.json' }, 1024)).rejects.toThrow();
    await expect(source?.read({ area: 'session', path: 'media/pic.png' }, 1024)).rejects.toThrow();
    await expect(source?.read({ area: 'session', path: 'turns/../environment.json' }, 1024)).rejects.toThrow();
    await expect(source?.read({ area: 'session', path: 'attachments/link' }, 1024)).rejects.toThrow();
    await expect(source?.read({ area: 'session', path: 'attachments/hard.txt' }, 1024)).rejects.toThrow();
    await expect(source?.read({ area: 'history', path: 'environment.json' }, 1024)).rejects.toThrow();
    expect(new TextDecoder().decode(await source?.read({ area: 'session', path: 'turns/turn-001.md' }, 1024))).toBe(
      'task',
    );
  });

  test('the journal is read page by page into JSON lines, and a limit is honoured', async () => {
    const source = await build({})(ID);
    const bytes = await source?.read({ area: 'history', path: 'history.jsonl' }, 1024);
    expect(
      new TextDecoder()
        .decode(bytes)
        .trim()
        .split('\n')
        .map(line => (JSON.parse(line) as { sequence: number }).sequence),
    ).toEqual([1, 2, 3]);
    await expect(source?.read({ area: 'history', path: 'history.jsonl' }, 5)).rejects.toThrow();
  });

  test('a ferret this machine does not know has no source', async () => {
    expect(await build({ known: false })(ID)).toBeUndefined();
  });
});

describe('busy says why a ferret cannot move right now', () => {
  for (const otherFirst of [true, false])
    test(`shared-folder preflight refuses before snapshot in either list order (${String(otherFirst)})`, async () => {
      const peers = [
        { id: ID, folder: '/work' },
        { id: 'other', folder: '/work' },
      ];
      if (otherFirst) peers.reverse();
      expect(await (await build({ peers })(ID))?.busy()).toContain(
        'another ferret shares this folder; move it to a separate folder before moving machines',
      );
    });
  test.each([
    ['working', ['the ferret is still working; let it finish its turn first']],
    ['starting', ['the ferret is still working; let it finish its turn first']],
    ['idle', []],
    ['stopped', []],
  ])('%s', async (state, expected) => {
    expect(await (await build({ state })(ID))?.busy()).toEqual(expected);
  });

  test('a running background job refuses; a finished one does not', async () => {
    expect(await (await build({ jobs: [{ state: 'running' }, { state: 'running' }] })(ID))?.busy()).toEqual([
      '2 background jobs are still running; a job cannot move',
    ]);
    expect(await (await build({ jobs: [{ state: 'exited' }] })(ID))?.busy()).toEqual([]);
  });
});

describe('the conversation comes from the harness, or is refused with a sentence', () => {
  test('a harness with no packConversation is refused', async () => {
    const result = await (await build({})(ID))?.conversation();
    expect(result).toMatchObject({ ok: false, error: { reason: expect.stringContaining('cannot pack') } });
  });

  test('a harness that packs is asked for this ferret', async () => {
    const packed = { ok: true, value: { relPath: 'a/b.jsonl', bytes: text('x') } };
    expect(await (await build({ packConversation: async () => packed })(ID))?.conversation()).toEqual(packed as never);
  });
});

describe('only Relocate is handed the member', () => {
  test('every other consumer’s port has no relocationSource', () => {
    const port = { relocationSource: async () => undefined, get: async () => undefined };
    expect(relocationPortFor('relocate', port as never)).toHaveProperty('relocationSource');
    for (const other of ['conversation', 'tidy', 'mcp', 'projects', 'warden', 'connector'])
      expect(relocationPortFor(other, port as never)).not.toHaveProperty('relocationSource');
    expect(relocationPortFor('mcp', port as never)).toHaveProperty('get');
  });
});

test('MUST 4 session listing refuses depth overflow instead of dropping files', async () => {
  const source = await build({ files: { 'attachments/a/b/c/d/e/f/g.txt': { kind: 'file', bytes: text('kept') } } })(ID);
  await expect(source?.files()).rejects.toThrow('too deep');
});
test('MUST 4 session listing refuses count overflow instead of dropping files', async () => {
  const files: Record<string, Node> = {};
  for (let i = 0; i <= 20_000; i++) files[`turns/${String(i)}`] = { kind: 'file', bytes: text('x') };
  const source = await build({ files })(ID);
  await expect(source?.files()).rejects.toThrow('too many');
});

test('MUST 4 a session file over the read limit is refused, never truncated by the root', async () => {
  const source = await build({})(ID);
  await expect(source?.read({ area: 'session', path: 'turns/turn-001.md' }, 1)).rejects.toThrow();
});

test.each(['EIO', 'EACCES', 'ENOENT'])(
  'R3 a known attachment directory failing with %s refuses instead of losing files',
  async code => {
    const source = await build({ listingError: { path: 'attachments', code } })(ID);
    await expect(source?.files()).rejects.toThrow('attachments');
  },
);

test('R3 a nested attachment directory disappearing refuses instead of losing files', async () => {
  const source = await build({ listingError: { path: 'attachments/a1', code: 'ENOENT' } })(ID);
  await expect(source?.files()).rejects.toThrow('attachments/a1');
});

test('R3 ENOENT on an absent optional root is the only listing error treated as empty', async () => {
  const source = await build({ files: { 'turns/turn-001.md': SESSION['turns/turn-001.md'] as Node } })(ID);
  expect((await source?.files())?.map(file => file.path)).toEqual(['turns/turn-001.md', 'history.jsonl']);
});

describe('relocationRestore writes a move’s session files into the NEW ferret, and only those', () => {
  function restorer(existing: readonly string[] = [], known = true) {
    const written = new Map<string, Uint8Array>();
    const folder = {
      resolve: (relative: string) =>
        relative.startsWith('/') || relative.split('/').includes('..')
          ? { ok: false as const, error: 'outside' }
          : { ok: true as const, value: relative },
      lstat: async (path: string) =>
        existing.includes(path) || written.has(path)
          ? { kind: 'file', size: 0, links: 1, mode: 0o600, modified: '' }
          : undefined,
      publish: async (path: string, bytes: Uint8Array, options: { exclusive?: boolean; mode?: number }) => {
        expect(options).toEqual({ exclusive: true, mode: 0o600 });
        written.set(path, bytes);
        return { created: true };
      },
    };
    const context = {
      kernel: { state: { read: async () => ({ ok: true, value: undefined }) } },
      hooks: { contributions: () => [], provider: () => 'unavailable' },
      registry: { get: (id: string) => (known && id === ID ? { state: 'idle', harness: 'claude-code' } : undefined) },
      sessionFiles: { root: () => folder },
      sessionStore: {},
      ready: async () => {},
    } as unknown as FerretsContext;
    const restore = relocationFeature.register(context)?.port?.relocationRestore as (
      ferret: FerretId,
      files: readonly { path: string; bytes: Uint8Array }[],
    ) => Promise<void>;
    return { restore, written };
  }

  test('writes each file below turns/, channel/ and attachments/ as a new file, byte for byte', async () => {
    const { restore, written } = restorer();
    await restore(ID, [
      { path: 'turns/turn-001.md', bytes: text('task') },
      { path: 'attachments/a1/photo.txt', bytes: text('photo') },
    ]);
    expect([...written.keys()]).toEqual(['turns/turn-001.md', 'attachments/a1/photo.txt']);
    expect(new TextDecoder().decode(written.get('turns/turn-001.md'))).toBe('task');
  });

  test('refuses before the first write: a credential, a journal, a path out of the folder, a name already there', async () => {
    for (const path of [
      'environment.json',
      'history.jsonl',
      'turns',
      'turns/../environment.json',
      '/etc/passwd',
      'media/x.png',
    ]) {
      const { restore, written } = restorer();
      await expect(
        restore(ID, [
          { path: 'turns/turn-001.md', bytes: text('ok') },
          { path, bytes: text('x') },
        ]),
      ).rejects.toThrow();
      expect(written.size).toBe(0);
    }
    const taken = restorer(['turns/turn-002.md']);
    await expect(
      taken.restore(ID, [
        { path: 'turns/turn-001.md', bytes: text('a') },
        { path: 'turns/turn-002.md', bytes: text('b') },
      ]),
    ).rejects.toThrow('already exists');
    expect(taken.written.size).toBe(0);
  });

  test('refuses a ferret this machine does not know', async () => {
    const { restore } = restorer([], false);
    await expect(restore(ID, [{ path: 'turns/turn-001.md', bytes: text('a') }])).rejects.toThrow('does not know');
  });

  test('only Relocate is handed it', () => {
    const port = { relocationRestore: async () => undefined, get: async () => undefined };
    expect(relocationPortFor('relocate', port as never)).toHaveProperty('relocationRestore');
    for (const other of ['conversation', 'tidy', 'mcp', 'warden'])
      expect(relocationPortFor(other, port as never)).not.toHaveProperty('relocationRestore');
  });
});

const id = 'f1' as FerretId;
const to = { daemonId: 'beta-daemon', ferretId: 'g1', machine: 'Laptop' };
const records = () => [{ id, name: 'marin', folder: '/synthetic/work', state: 'stopped' as const }];

test('the durable fence survives a new reader and resolves callsigns with the daemon’s address rules', async () => {
  const state = new MemoryStateFolder().port([RelocationStubsFile]);
  const fence = new RelocationFence(state, records);
  await fence.loaded;
  expect(fence.refusal(id)).toBeUndefined();
  await fence.protect(id, to);
  const restarted = new RelocationFence(state, records);
  await restarted.loaded;
  for (const reference of [id, 'marin', ' MARIN '])
    expect(restarted.refusal(reference)).toBe('This ferret moved to Laptop and is read-only here.');
  expect(restarted.refusal('unrelated')).toBeUndefined();
});

for (const otherFirst of [true, false])
  test(`folder fence uses a moved record in either order and judges existing ferrets by id (${String(otherFirst)})`, async () => {
    const rows = [
      ...records(),
      { id: 'f2' as FerretId, name: 'other', folder: '/synthetic/work', state: 'stopped' as const },
    ];
    if (otherFirst) rows.reverse();
    const state = new MemoryStateFolder().port([RelocationStubsFile]);
    const shared = new RelocationFence(state, () => rows);
    await expect(shared.protect(id, to)).rejects.toThrow('another ferret shares this folder');
    expect(shared.destination(id)).toBeUndefined();
    await state.update(RelocationStubsFile, () => ({ moved: { [id]: to } }));
    const fence = new RelocationFence(state, () => rows);
    await fence.loaded;
    expect(fence.refusal('f2', '/synthetic/work')).toBeUndefined();
    expect(fence.refusal('', '/synthetic/work')).toContain('read-only');
    expect(fence.refusal('', '/synthetic/work/sub')).toContain('read-only');
    expect(fence.refusal('', '/synthetic/work-other')).toBeUndefined();
  });

test('an unreadable fence fails closed; a running source cannot be committed as a moved-away stub', async () => {
  const broken = new RelocationFence({ read: async () => ({ ok: false }) } as unknown as StatePort, records);
  await expect(broken.loaded).rejects.toThrow('could not be read');
  expect(broken.refusal(id)).toContain('could not be checked');
  const guarded = broken.guard({
    get: async () => 'read works',
    rename: async () => 'write happened',
  } as unknown as FerretsService);
  expect(await guarded.get(id)).toBe('read works' as never);
  await expect(guarded.rename(id, { name: 'new-name' })).rejects.toMatchObject({
    status: 503,
    code: 'fence_unavailable',
  });
  const state = new MemoryStateFolder().port([RelocationStubsFile]);
  const running = new RelocationFence(state, () => [{ ...records()[0]!, state: 'idle' }]);
  await expect(running.protect(id, to)).rejects.toThrow('only a stopped ferret');
});

test('repointRuntime skips a stub before any session/record rewrite and still updates unrelated ferrets', async () => {
  const state = new MemoryStateFolder().port([RelocationStubsFile]);
  const fence = new RelocationFence(state, () => records().map(record => ({ ...record, runtime: 'old-runtime' })));
  await fence.protect(id, to);
  const calls: string[] = [];
  const rows = [id, 'f2'].map(id => ({ id, runtime: 'old-runtime', state: 'stopped' }));
  const moved = await repointRuntime(
    {
      registry: { list: () => rows, get: (id: string) => rows.find(row => row.id === id) },
      serial: { run: async (_id: string, work: () => Promise<unknown>) => await work() },
      ports: {
        mutationAllowed: (id: string) => fence.assert(id),
        session: {
          repointRuntime: async (id: string) => {
            calls.push(`session:${id}`);
            return true;
          },
        },
      },
      write: async (record: { id: string }) => {
        calls.push(`record:${record.id}`);
      },
    } as never,
    { from: 'old-runtime', to: 'new-runtime', fromWrapper: '/synthetic/old', toWrapper: '/synthetic/new' },
  );
  expect(moved).toBe(1);
  expect(calls).toEqual(['session:f2', 'record:f2']);
});

test('in-process launch and mutation families cannot bypass the fence through the Ferrets service', async () => {
  const state = new MemoryStateFolder().port([RelocationStubsFile]);
  const fence = new RelocationFence(state, records);
  await fence.protect(id, to);
  const called: string[] = [];
  const fake = Object.fromEntries(
    [
      'start',
      'resume',
      'rename',
      'stop',
      'launchHeld',
      'move',
      'attach',
      'revokeToken',
      'get',
      'repointRuntime',
      'withWorktreeMove',
    ].map(key => [
      key,
      async () => {
        called.push(key);
      },
    ]),
  );
  const service = fence.guard(fake as unknown as FerretsService);
  for (const key of ['resume', 'rename', 'stop', 'launchHeld', 'move', 'attach', 'revokeToken'])
    await expect(
      (service as unknown as Record<string, (id: FerretId) => Promise<unknown>>)[key]!(id),
    ).rejects.toMatchObject({
      status: 409,
      code: 'moved_away',
      message: 'This ferret moved to Laptop and is read-only here.',
    });
  await expect(service.start({ folder: '/synthetic/work' } as never, { kind: 'person' })).rejects.toMatchObject({
    code: 'moved_away',
  });
  expect(called).toEqual([]);
  await expect(service.withWorktreeMove('/synthetic/work', async () => undefined)).rejects.toMatchObject({
    code: 'moved_away',
  });
  await service.get(id);
  expect(called).toEqual(['get']);
});
