import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { ApiRequest } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { ok } from '@ferretry/std';
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
  info: async file => (map[file] === undefined ? undefined : { modifiedAtMs: 1_770_000_000_000, size: map[file].length }),
  head: async (file, max) => map[file]?.slice(0, max),
  tail: async (file, max) => map[file]?.slice(-max),
});

const harness: LinkHarness = {
  key: 'claude-code',
  parser: 'claude',
  home: '.claude',
  list: async () => [{ id: ID, folder: '/work/app', title: 'login page', updatedAt: '2026-02-01T09:05:00.000Z' as Instant }],
};

const build = (kept: Array<[string, string]> = [], held: Record<string, string> = {}) => {
  const fs = files({ [`.claude/projects/-work-app/${ID}.jsonl`]: TRANSCRIPT, ...held });
  const stored = { format: 1 as const, links: [] as Array<{ id: string; harness: string; ferret: FerretId; linkedAt: Instant }> };
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
    finder: { read: async () => cache, write: async files => void (cache = files as typeof cache) },
    keeper: {
      keep: async input =>
        ok({ ferret: 'login-page' as FerretId, name: input.name, state: input.start ? ('working' as const) : ('stopped' as const) }),
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
    const result = await service.keep({ harness: 'claude-code', runtime: 'default', conversations: [{ id: ID, start: false }] });
    expect(result.kept).toEqual([{ id: ID, ferret: 'login-page' as FerretId, name: 'login page', state: 'stopped' }]);
    expect(stored.links).toEqual([
      { id: ID, harness: 'claude-code', ferret: 'login-page' as FerretId, linkedAt: '2026-02-02T00:00:00.000Z' as Instant },
    ]);
    expect(kept).toEqual([['login-page', ID]]);
    const again = await service.keep({ harness: 'claude-code', runtime: 'default', conversations: [{ id: ID, start: false }] });
    expect(again.refused).toEqual([{ id: ID, code: 'already_kept', reason: 'Ferret login-page already keeps it.' }]);
    const listed = await service.list({});
    expect(listed.conversations[0]?.keptBy).toBe('login-page');
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
        request: { query: new Map(Object.entries(query).map(([k, v]) => [k, [v]])), headers: new Map(), text: async () => '' } as unknown as ApiRequest,
        params: new Map(Object.entries(params)),
      }) as never;
    const failure = async (promise: Promise<unknown>) =>
      await promise.then(() => undefined, (error: unknown) => error as { status: number; code?: string });
    expect(await failure(routes['GET /v1/links/conversations'](call({ limit: '0' })))).toMatchObject({ status: 400, code: 'invalid_query' });
    expect(
      await failure(
        routes['GET /v1/links/conversations/:harness/:conversationId/preview'](
          call({}, { harness: 'claude-code', conversationId: 'abcdef0123' }),
        ),
      ),
    ).toMatchObject({ status: 404 });
    const listed = JSON.parse((await routes['GET /v1/links/conversations'](call({}))).body) as { matched: number };
    expect(listed.matched).toBe(1);
    const history = JSON.parse((await routes['GET /v1/links/history'](call({}))).body) as { entries: { id: string }[] };
    expect(history.entries.map(entry => entry.id)).toEqual([ID]);
    const entry = JSON.parse((await routes['GET /v1/links/history/:entryId'](call({}, { entryId: ID }))).body) as {
      messages: unknown[];
    };
    expect(entry.messages).toHaveLength(2);
  });
});
