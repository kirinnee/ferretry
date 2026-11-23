import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { ApiRequest } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import { conversationFiles } from '../../../daemon/links/adapters/conversation-files.ts';
import { keepInSyncFrom } from '../../../daemon/links/index.ts';
import { FileConversationDescriber } from '../../../daemon/links/lib/conversation-describer.ts';
import { ConversationIndex, type IndexSource } from '../../../daemon/links/lib/conversation-index.ts';
import { LinkService } from '../../../daemon/links/lib/service.ts';
import { linkRoutes } from '../../../daemon/links/routes.ts';
import { claudeRecord, codexRollout, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

const ID = '3b1a4a52-0000-4000-8000-000000000001';
const CODEX = '5c1e0e3a-0000-4000-8000-0000000000aa';
const TRANSCRIPT = `${claudeRecord('user', 'please add a login page', '2026-02-01T09:00:00.000Z')}\n${claudeRecord('assistant', 'done, it is on /login', '2026-02-01T09:05:00.000Z')}\n`;
const PATH = `projects/-work-app/${ID}.jsonl`;

const build = async (
  options: { held?: Record<string, string>; copyFails?: boolean; keepInSync?: () => boolean; never?: boolean } = {},
) => {
  const owner = new MemoryHistory();
  owner.set(PATH, TRANSCRIPT);
  for (const [path, text] of Object.entries(options.held ?? {})) owner.set(path, text);
  const sources: IndexSource[] = [
    { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: owner },
    ...(options.held === undefined ? [] : []),
  ];
  const index = new ConversationIndex({
    sqlite: () => memorySqlite(),
    sources: async () => sources,
    ferretNames: async () => new Map(),
    parsers: PARSERS,
    nowMs: () => 0,
  });
  const stored = {
    format: 1 as const,
    links: [] as Array<{ id: string; harness: string; ferret: FerretId; linkedAt: Instant; copied?: true }>,
  };
  const kept: Array<[string, string]> = [];
  const copies: Array<{ id: string; path: string }> = [];
  const asked: Array<{ copy: boolean }> = [];
  const needs: ConstructorParameters<typeof LinkService>[0] = {
    index,
    previewer: {
      preview: async (conversation, count) =>
        await new FileConversationDescriber(conversationFiles(owner), PARSERS).preview(
          {
            harness: conversation.parser,
            source: conversation.path,
            relativePath: conversation.path,
            nameId: conversation.row.id,
          },
          count,
        ),
    },
    ledger: {
      read: async () => stored,
      add: async link => {
        stored.links.push(link);
      },
    },
    keeper: {
      keep: async input => {
        asked.push({ copy: input.copy });
        return ok({
          ferret: 'login-page' as FerretId,
          name: input.name,
          state: input.start ? ('working' as const) : ('stopped' as const),
        });
      },
    },
    copier: {
      copy: async ({ id, location }) => {
        if (options.copyFails === true) return err({ reason: 'the disk is full' });
        copies.push({ id, path: location.path });
        return ok(undefined);
      },
    },
    now: () => '2026-02-02T00:00:00.000Z' as Instant,
    keptPublished: (ferret, link) => void kept.push([ferret, link]),
    ...(options.keepInSync === undefined ? {} : { keepInSync: options.keepInSync }),
  };
  await index.refresh();
  return { service: new LinkService(needs), needs, stored, kept, copies, asked, owner, index };
};

describe('links', () => {
  test('a listing is the index’s answer: each conversation as its own file describes it, newest first', async () => {
    const { service } = await build();
    const listing = await service.list({});
    expect(listing.matched).toBe(1);
    expect(listing.indexing).toBeUndefined();
    expect(listing.conversations[0]).toMatchObject({
      id: ID,
      harness: 'claude-code',
      project: '/work/app',
      preview: 'please add a login page',
      turns: 1,
      keptIn: 'computer',
      name: 'Add a Login Page',
    });
  });

  test('a listing says the index is still being read when a first build is under way, and does not wait for it', async () => {
    const { service, needs } = await build();
    // A source that never answers: the build never finishes.
    const stuck = new LinkService({
      ...needs,
      index: new ConversationIndex({
        sqlite: () => memorySqlite(),
        sources: () => new Promise(() => undefined),
        ferretNames: async () => new Map(),
        parsers: PARSERS,
        nowMs: () => 0,
      }),
    });
    const listing = await stuck.list({});
    expect(listing).toMatchObject({ matched: 0, indexing: true });
    expect((await service.list({})).indexing).toBeUndefined();
  });

  test('Keep in sync off hides the computer’s conversations and says so; on lists them; read fresh on every listing', async () => {
    let on = false;
    const { service } = await build({ keepInSync: () => on });
    const hidden = await service.list({});
    expect(hidden.conversations).toEqual([]);
    expect(hidden.matched).toBe(0);
    expect(hidden.computerListed).toBe(false);
    on = true;
    const shown = await service.list({});
    expect(shown.matched).toBe(1);
    expect(shown.computerListed).toBeUndefined();
  });

  test('the daemon reads keepInSync from the conversation.yaml in effect on every listing: off hides, an edit shows again', async () => {
    let inEffect: { keepInSync: boolean } | undefined = { keepInSync: false };
    const config = { file: () => inEffect } as unknown as Parameters<typeof keepInSyncFrom>[0];
    const { service } = await build({ keepInSync: keepInSyncFrom(config) });
    expect((await service.list({})).computerListed).toBe(false);
    inEffect = { keepInSync: true };
    expect((await service.list({})).matched).toBe(1);
    inEffect = { keepInSync: false };
    expect((await service.list({})).matched).toBe(0);
    // A file that is absent says nothing: on.
    inEffect = undefined;
    expect((await service.list({})).matched).toBe(1);
  });

  test('with no Keep in sync reader the computer’s conversations are listed, as on a machine whose file says nothing', async () => {
    const { service } = await build();
    expect((await service.list({})).matched).toBe(1);
  });

  test('a query narrows by every word, and a source of ferretry lists only Ferretry’s own copies', async () => {
    const { service } = await build();
    expect((await service.list({ q: 'login nothing' })).matched).toBe(0);
    expect((await service.list({ q: 'LOGIN page' })).matched).toBe(1);
    expect((await service.list({ source: 'ferretry' })).conversations).toEqual([]);
    expect((await service.list({ source: 'computer' })).matched).toBe(1);
  });

  test('a preview is the last exchanges, cleaned; an unknown conversation is nothing', async () => {
    const { service } = await build();
    expect(await service.preview('claude-code', ID)).toMatchObject({
      id: ID,
      harness: 'claude-code',
      messages: [
        { role: 'user', text: 'please add a login page' },
        { role: 'assistant', text: 'done, it is on /login' },
      ],
    });
    expect(await service.preview('claude-code', 'nope-nope')).toBeUndefined();
  });

  test('Q19 keeping links the conversation: it is copied into the harness pool first, the ledger names the ferret and the original is only read', async () => {
    const { service, stored, kept, copies } = await build();
    const result = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: ID, start: false }],
    });
    expect(result.kept).toEqual([
      { id: ID, ferret: 'login-page' as FerretId, name: 'Add a Login Page', state: 'stopped' },
    ]);
    expect(stored.links).toEqual([
      {
        id: ID,
        harness: 'claude-code',
        ferret: 'login-page' as FerretId,
        linkedAt: '2026-02-02T00:00:00.000Z' as Instant,
        copied: true,
      },
    ] as unknown as typeof stored.links);
    // The copy is asked of the harness for the file the computer holds, whether or not the caller asked for one.
    expect(copies).toEqual([{ id: ID, path: PATH }]);
    expect(kept).toEqual([['login-page', ID]]);
    const again = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: ID, start: false }],
    });
    expect(again.refused).toEqual([{ id: ID, code: 'already_kept', reason: 'Ferret login-page already keeps it.' }]);
    const listed = await service.list({});
    expect(listed.conversations[0]?.keptBy).toBe('login-page');
  });

  test('Q19 a copy on request: Ferretry copies the file, then keeps it, and the ledger says it was copied', async () => {
    const { service, stored, copies, asked } = await build();
    const result = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: ID, start: false, copy: true }],
    });
    expect(result.kept).toHaveLength(1);
    expect(copies).toEqual([{ id: ID, path: PATH }]);
    expect(asked).toEqual([{ copy: true }]);
    expect(stored.links[0]).toMatchObject({ id: ID, copied: true });
  });

  test('a copy that fails keeps nothing and says why', async () => {
    const { service, stored } = await build({ copyFails: true });
    const result = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: ID, start: false, copy: true }],
    });
    expect(result.refused).toEqual([{ id: ID, code: 'failed', reason: 'the disk is full' }]);
    expect(stored.links).toEqual([]);
  });

  test('keeping a conversation no history holds is not_found', async () => {
    const { service } = await build();
    const result = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: 'ffffffff-0000-4000-8000-000000000009', start: false }],
    });
    expect(result.refused[0]).toMatchObject({ code: 'not_found' });
    expect(result.kept).toEqual([]);
  });

  test('O8-12 stage copies a host-only Claude transcript into the pool by the index’s own path, and starts no ferret and writes no link', async () => {
    const { service, copies, asked, stored } = await build();
    expect(await service.stage('claude-code', ID)).toEqual(ok(undefined));
    // The source is the file's path below the harness's history folder, exactly what `Harness.importConversation` takes.
    expect(copies).toEqual([{ id: ID, path: PATH }]);
    expect(asked).toEqual([]);
    expect(stored.links).toEqual([]);
  });

  test('O8-12 stage copies a host-only Codex rollout the same way', async () => {
    const home = new MemoryHistory();
    const rollout = `sessions/2026/10/10/rollout-2026-10-10T09-00-00-${CODEX}.jsonl`;
    home.set(rollout, codexRollout(CODEX, '/work/notes', 'take notes'));
    const { needs, copies } = await build();
    const index = new ConversationIndex({
      sqlite: () => memorySqlite(),
      sources: async () => [{ harness: 'codex', parser: 'codex', kind: 'computer', label: 'owner', files: home }],
      ferretNames: async () => new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
    });
    await index.refresh();
    expect(await new LinkService({ ...needs, index }).stage('codex', CODEX)).toEqual(ok(undefined));
    expect(copies).toEqual([{ id: CODEX, path: rollout }]);
  });

  test('O8-12 stage refuses a conversation no history holds (not_found), and one that cannot be copied (failed), each in a plain sentence', async () => {
    const { service } = await build();
    const missing = await service.stage('claude-code', 'ffffffff-0000-4000-8000-000000000009');
    expect(missing).toEqual(
      err({
        code: 'not_found',
        reason: 'No claude-code conversation ffffffff-0000-4000-8000-000000000009 is on this machine.',
      }),
    );
    // The same id under the other harness is not this machine's Codex conversation either.
    expect((await service.stage('codex', ID)).ok).toBe(false);
    const full = await build({ copyFails: true });
    expect(await full.service.stage('claude-code', ID)).toEqual(err({ code: 'failed', reason: 'the disk is full' }));
  });

  test('O8-12 stage reports a copier that throws in its own words', async () => {
    const { needs } = await build();
    const service = new LinkService({
      ...needs,
      copier: {
        copy: async () => {
          throw new Error('permission denied');
        },
      },
    });
    expect(await service.stage('claude-code', ID)).toEqual(err({ code: 'failed', reason: 'permission denied' }));
  });

  test('the routes refuse a bad query with 400 and an unknown preview with 404', async () => {
    const { service } = await build();
    const routes = linkRoutes(service);
    const call = (query: Record<string, string>, params: Record<string, string> = {}) =>
      ({
        request: {
          query: new Map(Object.entries(query).map(([k, v]) => [k, [v]])),
          headers: new Map(),
          text: async () => '',
        } as unknown as ApiRequest,
        params: new Map(Object.entries(params)),
      }) as never;
    const failure = async (promise: Promise<unknown>) =>
      await promise.then(
        () => undefined,
        (error: unknown) => error as { status: number; code?: string },
      );
    expect(await failure(routes['GET /v1/links/conversations'](call({ limit: '0' })))).toMatchObject({
      status: 400,
      code: 'invalid_query',
    });
    expect(
      await failure(
        routes['GET /v1/links/conversations/:harness/:conversationId/preview'](
          call({}, { harness: 'claude-code', conversationId: 'abcdef0123' }),
        ),
      ),
    ).toMatchObject({ status: 404 });
    const listed = JSON.parse((await routes['GET /v1/links/conversations'](call({}))).body) as { matched: number };
    expect(listed.matched).toBe(1);
    const history = JSON.parse((await routes['GET /v1/links/history'](call({}))).body) as {
      entries: { id: string; turns: number }[];
      skipped: number;
    };
    expect(history.entries.map(entry => entry.id)).toEqual([ID]);
    expect(history.entries[0]?.turns).toBeGreaterThan(0);
    expect(history.skipped).toBe(0);
    const entry = JSON.parse((await routes['GET /v1/links/history/:entryId'](call({}, { entryId: ID }))).body) as {
      messages: unknown[];
    };
    expect(entry.messages).toHaveLength(2);
  });

  /** The service of `build`, with some of its ports replaced. */
  const variant = async (replace: Partial<ConstructorParameters<typeof LinkService>[0]>) => {
    const { needs } = await build();
    return new LinkService({ ...needs, ...replace });
  };
  const keepIt = (service: LinkService, copy = false) =>
    service.keep({ harness: 'claude-code', runtime: 'default', conversations: [{ id: ID, start: false, copy }] });
  const copier = (copy: () => Promise<never>) => ({ copy });

  test('a copier that throws is reported in its own words, or in ours when it gave none', async () => {
    const worded = await keepIt(
      await variant({
        copier: copier(async () => {
          throw new Error('permission denied');
        }),
      }),
      true,
    );
    expect(worded.refused[0]).toMatchObject({ code: 'failed', reason: 'permission denied' });
    const silent = await keepIt(
      await variant({
        copier: copier(async () => {
          throw new Error('');
        }),
      }),
      true,
    );
    expect(silent.refused[0]).toMatchObject({ code: 'failed', reason: 'It could not be copied.' });
  });

  test('a keeper that refuses, or throws, keeps nothing and says why', async () => {
    const refuses = await variant({
      keeper: { keep: async () => err({ code: 'unavailable', reason: 'No such runtime.' }) },
    });
    expect((await keepIt(refuses)).refused).toEqual([{ id: ID, code: 'unavailable', reason: 'No such runtime.' }]);
    const worded = await variant({
      keeper: {
        keep: async () => {
          throw new Error('no room');
        },
      },
    });
    expect((await keepIt(worded)).refused).toEqual([{ id: ID, code: 'failed', reason: 'no room' }]);
    const silent = await variant({
      keeper: {
        keep: async () => {
          throw new Error('');
        },
      },
    });
    expect((await keepIt(silent)).refused).toEqual([
      { id: ID, code: 'failed', reason: 'The ferret could not be created.' },
    ]);
  });

  test('lists Codex conversations from their rollouts, named by Codex’s own index', async () => {
    const home = new MemoryHistory();
    home.set(
      `sessions/2026/10/10/rollout-2026-10-10T09-00-00-${CODEX}.jsonl`,
      codexRollout(CODEX, '/work/notes', 'take notes'),
    );
    home.set('session_index.jsonl', JSON.stringify({ id: CODEX, thread_name: 'Meeting notes' }));
    const { needs } = await build();
    const index = new ConversationIndex({
      sqlite: () => memorySqlite(),
      sources: async () => [{ harness: 'codex', parser: 'codex', kind: 'computer', label: 'owner', files: home }],
      ferretNames: async () => new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
    });
    await index.refresh();
    const listing = await new LinkService({ ...needs, index }).list({});
    expect(listing.conversations[0]).toMatchObject({ id: CODEX, harness: 'codex', name: 'Meeting notes' });
  });

  test('a conversation a ferret runs shows the ferret’s name on every row, and is marked as that ferret’s', async () => {
    const { needs } = await build();
    const owner = new MemoryHistory();
    owner.set(PATH, TRANSCRIPT);
    const index = new ConversationIndex({
      sqlite: () => memorySqlite(),
      sources: async () => [
        { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: owner },
      ],
      ferretNames: async () => new Map([[`claude-code:${ID}`, { ferret: 'scout', name: 'Login scout' }]]),
      parsers: PARSERS,
      nowMs: () => 0,
    });
    await index.refresh();
    const service = new LinkService({ ...needs, index });
    const listing = await service.list({ q: 'scout' });
    // The ferret's callsign finds the row; it never names it (a title made from the first message does).
    expect(listing.conversations[0]).toMatchObject({
      name: 'Add a Login Page',
      ferretName: 'Login scout',
      keptBy: 'scout',
    });
  });
});
