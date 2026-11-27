import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { FERRET_READABLE_FOLDERS, Harnesses, JobKeeper } from '../../contract/index.ts';
import relocationFeature, { relocationPortFor } from '../../daemon/features/relocation-source.feature.ts';
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
      if (direct.size === 0) throw new Error('no such folder');
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
      const node = files[path];
      return node === undefined
        ? undefined
        : { kind: node.kind, size: node.bytes?.length ?? 0, links: node.links ?? 1, mode: 0o600, modified: '' };
    },
    readBytes: async (path: string, limit?: number) => {
      const bytes = files[path]?.bytes ?? new Uint8Array();
      if (typeof limit === 'number' && bytes.length > limit) throw new Error('too large');
      return bytes;
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
  readonly state?: string;
  readonly jobs?: readonly { readonly state: string }[];
  readonly packConversation?: () => Promise<unknown>;
  readonly known?: boolean;
}) {
  const harness = { packConversation: options.packConversation };
  const folder = sessionFolder(SESSION);
  const context = {
    hooks: {
      contributions: (token: unknown) =>
        token === JobKeeper && options.jobs !== undefined ? [{ item: { jobs: async () => options.jobs } }] : [],
      provider: (token: unknown) => (token === Harnesses ? harness : 'unavailable'),
    },
    registry: {
      get: (id: string) =>
        options.known === false || id !== ID ? undefined : { state: options.state ?? 'idle', harness: 'claude-code' },
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
