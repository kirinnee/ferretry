import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { ApiRequest } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import { FileConversationDescriber } from '../../../daemon/links/lib/conversation-describer.ts';
import type { ConversationFiles } from '../../../daemon/links/lib/conversation-describer.ts';
import { type LinkHarness, LinkService } from '../../../daemon/links/lib/service.ts';
import { linkRoutes } from '../../../daemon/links/routes.ts';
import { ClaudeTranscriptParser } from '../../../daemon/reader/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../daemon/reader/lib/transcript/codex.ts';
import { PacedTranscriptParser } from '../../../daemon/reader/lib/transcript/sliced.ts';

const ID = '3b1a4a52-0000-4000-8000-000000000001';
const NO_WAIT = { now: () => 0, yieldToLoop: async (): Promise<void> => undefined };
const record = (type: string, text: string, at: string) =>
  JSON.stringify({ type, cwd: '/work/app', timestamp: at, message: { role: type, content: text } });
const TRANSCRIPT = `${record('user', 'please add a login page', '2026-02-01T09:00:00.000Z')}\n${record('assistant', 'done, it is on /login', '2026-02-01T09:05:00.000Z')}\n`;

const files = (map: Record<string, string>): ConversationFiles => ({
  entries: async directory => {
    const prefix = `${directory}/`;
    const names = new Map<string, 'file' | 'directory'>();
    for (const path of Object.keys(map)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      names.set(rest.split('/')[0] as string, rest.includes('/') ? 'directory' : 'file');
    }
    return [...names].map(([name, kind]) => ({ name, kind }));
  },
  info: async file =>
    map[file] === undefined ? undefined : { modifiedAtMs: 1_770_000_000_000, size: map[file].length },
  head: async (file, max) => map[file]?.slice(0, max),
  tail: async (file, max) => map[file]?.slice(-max),
});

const harness: LinkHarness = {
  key: 'claude-code',
  parser: 'claude',
  home: '.claude',
  list: async () => [
    { id: ID, folder: '/work/app', title: 'login page', updatedAt: '2026-02-01T09:05:00.000Z' as Instant },
  ],
};

const build = (
  kept: Array<[string, string]> = [],
  held: Record<string, string> = {},
  copies: Array<{ id: string; source: string }> = [],
  copyFails = false,
  kept2: Array<{ copy: boolean }> = [],
) => {
  const fs = files({ [`.claude/projects/-work-app/${ID}.jsonl`]: TRANSCRIPT, ...held });
  const stored = {
    format: 1 as const,
    links: [] as Array<{ id: string; harness: string; ferret: FerretId; linkedAt: Instant }>,
  };
  let cache: Record<string, Record<string, string>> = {};
  const service = new LinkService({
    harnesses: () => [harness],
    files: fs,
    describer: new FileConversationDescriber(fs, {
      claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), NO_WAIT),
      codex: new PacedTranscriptParser(new CodexTranscriptParser(), NO_WAIT),
    }),
    ledger: {
      read: async () => stored,
      add: async link => {
        stored.links.push(link);
      },
    },
    finder: {
      read: async () => cache,
      write: async files => {
        cache = files as typeof cache;
      },
    },
    keeper: {
      keep: async input => {
        kept2.push({ copy: input.copy });
        return ok({
          ferret: 'login-page' as FerretId,
          name: input.name,
          state: input.start ? ('working' as const) : ('stopped' as const),
        });
      },
    },
    copier: {
      copy: async ({ id, source }) => {
        if (copyFails) return err({ reason: 'the disk is full' });
        copies.push({ id, source });
        return ok(undefined);
      },
    },
    now: () => '2026-02-02T00:00:00.000Z' as Instant,
    keptPublished: (ferret, link) => void kept.push([ferret, link]),
  });
  return { service, stored, cache: () => cache, kept };
};

describe('links', () => {
  test('a listing describes each conversation from its own file, newest first, and remembers where the file is', async () => {
    const { service, cache } = build();
    const listing = await service.list({});
    expect(listing.matched).toBe(1);
    expect(listing.conversations[0]).toMatchObject({
      id: ID,
      harness: 'claude-code',
      project: '/work/app',
      preview: 'please add a login page',
      turns: 1,
      keptIn: 'computer',
    });
    expect(cache()['claude-code']?.[ID]).toBe(`projects/-work-app/${ID}.jsonl`);
  });

  test('a query narrows by every word, and a source of ferretry lists nothing (those are ferrets)', async () => {
    const { service } = build();
    expect((await service.list({ q: 'login nothing' })).matched).toBe(0);
    expect((await service.list({ q: 'LOGIN page' })).matched).toBe(1);
    expect((await service.list({ source: 'ferretry' })).conversations).toEqual([]);
  });

  test('a conversation whose file cannot be found is still listed from what its finder said, turns as a floor', async () => {
    const { service } = build([], {});
    const lone = new LinkService({
      ...(service as unknown as { needs: ConstructorParameters<typeof LinkService>[0] }).needs,
      files: files({}),
    });
    const listing = await lone.list({});
    expect(listing.conversations[0]).toMatchObject({ id: ID, preview: 'login page', turns: 0, turnsAtLeast: true });
  });

  test('a preview is the last exchanges, cleaned; an unknown conversation is nothing', async () => {
    const { service } = build();
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

  test('Q19 keeping links the conversation: the ledger names the ferret, the harness file is only read', async () => {
    const kept: Array<[string, string]> = [];
    const { service, stored } = build(kept);
    const result = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: ID, start: false }],
    });
    expect(result.kept).toEqual([{ id: ID, ferret: 'login-page' as FerretId, name: 'login page', state: 'stopped' }]);
    expect(stored.links).toEqual([
      {
        id: ID,
        harness: 'claude-code',
        ferret: 'login-page' as FerretId,
        linkedAt: '2026-02-02T00:00:00.000Z' as Instant,
      },
    ]);
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
    const copies: Array<{ id: string; source: string }> = [];
    const asked: Array<{ copy: boolean }> = [];
    const { service, stored } = build([], {}, copies, false, asked);
    const result = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: ID, start: false, copy: true }],
    });
    expect(result.kept).toHaveLength(1);
    expect(copies).toEqual([{ id: ID, source: `.claude/projects/-work-app/${ID}.jsonl` }]);
    expect(asked).toEqual([{ copy: true }]);
    expect(stored.links[0]).toMatchObject({ id: ID, copied: true });
  });

  test('a copy that fails keeps nothing and says why', async () => {
    const { service, stored } = build([], {}, [], true);
    const result = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: ID, start: false, copy: true }],
    });
    expect(result.refused).toEqual([{ id: ID, code: 'failed', reason: 'the disk is full' }]);
    expect(stored.links).toEqual([]);
  });

  test('keeping a conversation no history holds is not_found', async () => {
    const { service } = build();
    const result = await service.keep({
      harness: 'claude-code',
      runtime: 'default',
      conversations: [{ id: 'ffffffff-0000-4000-8000-000000000009', start: false }],
    });
    expect(result.refused[0]).toMatchObject({ code: 'not_found' });
    expect(result.kept).toEqual([]);
  });

  test('the routes refuse a bad query with 400 and an unknown preview with 404', async () => {
    const { service } = build();
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
  const variant = (replace: Partial<ConstructorParameters<typeof LinkService>[0]>) => {
    const { service } = build();
    return new LinkService({
      ...(service as unknown as { needs: ConstructorParameters<typeof LinkService>[0] }).needs,
      ...replace,
    });
  };
  const keepIt = (service: LinkService, copy = false) =>
    service.keep({ harness: 'claude-code', runtime: 'default', conversations: [{ id: ID, start: false, copy }] });
  const copier = (copy: () => Promise<never>) => ({ copy });

  test('a copy asked for a conversation whose file cannot be found says so, and keeps nothing', async () => {
    const result = await keepIt(variant({ files: files({}) }), true);
    expect(result.refused).toEqual([{ id: ID, code: 'failed', reason: 'Its file could not be found to copy.' }]);
  });

  test('a copier that throws is reported in its own words, or in ours when it gave none', async () => {
    const worded = await keepIt(
      variant({
        copier: copier(async () => {
          throw new Error('permission denied');
        }),
      }),
      true,
    );
    expect(worded.refused[0]).toMatchObject({ code: 'failed', reason: 'permission denied' });
    const silent = await keepIt(
      variant({
        copier: copier(async () => {
          throw new Error('');
        }),
      }),
      true,
    );
    expect(silent.refused[0]).toMatchObject({ code: 'failed', reason: 'It could not be copied.' });
  });

  test('a keeper that refuses, or throws, keeps nothing and says why', async () => {
    const refuses = variant({
      keeper: { keep: async () => err({ code: 'unavailable', reason: 'No such runtime.' }) },
    });
    expect((await keepIt(refuses)).refused).toEqual([{ id: ID, code: 'unavailable', reason: 'No such runtime.' }]);
    const worded = variant({
      keeper: {
        keep: async () => {
          throw new Error('no room');
        },
      },
    });
    expect((await keepIt(worded)).refused).toEqual([{ id: ID, code: 'failed', reason: 'no room' }]);
    const silent = variant({
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
    const CODEX = '5c1e0e3a-0000-4000-8000-0000000000aa';
    const rollout = `.codex/sessions/2026/10/10/rollout-2026-10-10T09-00-00-${CODEX}.jsonl`;
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-10T09:00:00.000Z',
        payload: { id: CODEX, cwd: '/work/notes' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-10-10T09:01:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'take notes' }] },
      }),
    ].join('\n');
    const held = {
      [rollout]: lines,
      '.codex/sessions/2026/10/10/notes.txt': 'not a rollout',
      '.codex/sessions/2026/10/10/rollout-no-id.jsonl': 'x',
      '.codex/session_index.jsonl': JSON.stringify({ id: CODEX, thread_name: 'Meeting notes' }),
      '.codex/sessions/a/b/c/d/e/rollout-too-deep.jsonl': 'x',
    };
    const fs = files(held);
    const codex: LinkHarness = {
      key: 'codex',
      parser: 'codex',
      home: '.codex',
      list: async () => [
        { id: CODEX, folder: '/work/notes', title: 'notes', updatedAt: '2026-10-10T09:01:00.000Z' as Instant },
      ],
    };
    const { service } = build();
    const needs = (service as unknown as { needs: ConstructorParameters<typeof LinkService>[0] }).needs;
    const listing = await new LinkService({ ...needs, files: fs, harnesses: () => [codex] }).list({});
    expect(listing.conversations[0]).toMatchObject({ id: CODEX, harness: 'codex', name: 'Meeting notes' });

    // Without an index Codex has named nothing, and the rollout's own record stands.
    const { '.codex/session_index.jsonl': _index, ...bare } = held;
    const unnamed = await new LinkService({ ...needs, files: files(bare), harnesses: () => [codex] }).list({});
    expect(unnamed.conversations[0]?.id).toBe(CODEX);
  });
});
