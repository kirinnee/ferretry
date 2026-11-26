import { describe, expect, test } from 'bun:test';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import {
  byRecordedHarnessKey,
  isRecordedHarnessKey,
  RECORDED_HARNESS_KEYS,
  recordedKeyOfWord,
  UnsupportedHarnessFamilyError,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import type { RuntimeHome } from '@ferretry/plugin-runtimes/contract';
import { McpInventorySchema, McpItemSchema } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { hostImportPut } from '../../daemon/features/host-import/put.ts';
import { accountsOf } from '../../daemon/lib/inventory/runtime-wiring.ts';
import { mcpParts } from '../../daemon/lib/launch-parts.ts';
import manifest from '../../manifest.ts';

/**
 * U4b part 4b, MCP: a ferret on a harness the family table has no row for is never read as Claude's or Codex's. `fake-third`
 * is a third harness key; `claude` is a third harness registered UNDER the family word, which must not borrow Claude's
 * policy either (a plugin KEY is not a harness FAMILY).
 */

const THIRD_KEYS = ['fake-third', 'claude'] as const;

describe('the sessions MCP lists, over the mounted route', () => {
  const build = (ferrets: FakeFerrets) =>
    daemon.build?.({
      manifest,
      needs: { ferrets, vault: new FakeVault(), sealed: new FakeSealedDocuments() },
      uses: {
        claudeCode: { current: () => undefined },
        logins: { current: () => undefined },
        projects: { current: () => undefined },
        runtimes: { current: () => undefined },
      },
      hooks: {} as never,
      kernel: {
        identity: { binaries: { client: 'fy' } },
        config: { collection: () => new Map() },
        clock: { nowMs: () => 0 },
        roots: { root: () => ({}) },
      } as unknown as DaemonContext<typeof manifest>['kernel'],
    } as DaemonContext<typeof manifest>);
  const call = (id: string) =>
    ({ params: new Map([['ferretId', id]]), request: { text: async () => '' } as ApiRequest }) as CallContext;

  for (const harness of THIRD_KEYS) {
    test(`a ${harness} ferret is not one of MCP's: 404 not-found, never a 500 and never Claude's list`, async () => {
      // Arrange
      const ferrets = new FakeFerrets();
      ferrets.add({ id: ferretId('f1'), harness, folder: '/work/app' });
      const route = build(ferrets)?.routes?.['GET /v1/ferrets/:ferretId/mcp/servers' as never] as unknown as
        | ((call: CallContext) => Promise<unknown>)
        | undefined;
      expect(route).toBeDefined();

      // Act
      const refused = await (route as (call: CallContext) => Promise<unknown>)(call('f1')).catch(
        (error: unknown) => error,
      );

      // Assert
      expect(refused).toMatchObject({ status: 404, code: 'not-found' });
    });
  }

  test('a Claude ferret is still an MCP ferret: it gets past the guard to the inventory (this bare kernel has no state to list from)', async () => {
    // Arrange
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1'), harness: 'claude-code', folder: '/work/app' });
    const route = build(ferrets)?.routes?.['GET /v1/ferrets/:ferretId/mcp/servers' as never] as unknown as (
      call: CallContext,
    ) => Promise<unknown>;

    // Act
    const answer = await route(call('f1')).catch((error: unknown) => error);

    // Assert
    expect(answer).not.toMatchObject({ status: 404 });
  });
});

describe('the homes MCP reads accounts from', () => {
  const home = (harness: string): RuntimeHome => ({
    id: 'h',
    harness,
    runtimes: ['r1' as never],
    home: '/homes/h',
    wrapper: '/w/h',
  });

  test('a home of a third harness, or of one registered under the word `claude`, lists no account', () => {
    for (const harness of THIRD_KEYS) expect(accountsOf([home(harness)])).toEqual([]);
  });

  test('the two shipped keys keep their accounts', () => {
    expect(accountsOf([home('claude-code'), home('codex')]).map(account => account.harness)).toEqual([
      'claude-code',
      'codex',
    ]);
  });
});

describe('the servers a launch gets', () => {
  const items = new Map([['tool', McpItemSchema.parse({ command: 'tool' })]]);

  test('a third harness is refused by name at the dispatch, never given Claude or Codex servers', () => {
    for (const harness of THIRD_KEYS)
      expect(() => byRecordedHarnessKey(harness, { claude: () => 1, codex: () => 2 })).toThrow(
        UnsupportedHarnessFamilyError,
      );
    expect(isRecordedHarnessKey('claude')).toBe(false);
    expect(isRecordedHarnessKey('fake-third')).toBe(false);
  });

  test('the two shipped keys keep their parts', () => {
    for (const harness of RECORDED_HARNESS_KEYS) expect(mcpParts(items, harness)).toHaveLength(1);
  });
});

describe('the harness an MCP item may be pinned to', () => {
  test('is a key the family table names; any other word is refused at the wire', () => {
    expect(McpItemSchema.safeParse({ command: 'tool', harness: 'codex' }).success).toBe(true);
    expect(McpItemSchema.safeParse({ command: 'tool', harness: 'claude-code' }).success).toBe(true);
    expect(McpItemSchema.safeParse({ command: 'tool', harness: 'fake-third' }).success).toBe(false);
    expect(McpItemSchema.safeParse({ command: 'tool', harness: 'claude' }).success).toBe(false);
  });

  test('an import accepts the family word Runtimes writes and stores the key, and refuses a harness it does not know', async () => {
    // Arrange
    const written: string[] = [];
    const put = hostImportPut({
      taken: () => false,
      etag: async () => '',
      create: async (_name: string, text: string) => {
        written.push(text);
        return { kind: 'written', etag: 'e1' } as never;
      },
      replace: async () => ({ kind: 'conflict' }) as never,
    } as never);
    const doc = (harness: string) => JSON.stringify({ command: 'tool', harness });

    // Act
    const claude = await put('a', doc('claude'));
    const codex = await put('b', doc('codex'));
    const key = await put('c', doc('claude-code'));
    const third = await put('d', doc('fake-third'));
    const proto = await put('e', doc('constructor'));

    // Assert
    expect([claude.ok, codex.ok, key.ok]).toEqual([true, true, true]);
    expect(written.map(text => (JSON.parse(text) as { harness: string }).harness)).toEqual([
      'claude-code',
      'codex',
      'claude-code',
    ]);
    expect(third.ok).toBe(false);
    // The refusal names the file and the rejected harness key, so the person can find it.
    expect(third.ok === false ? third.reason : '').toContain('the harness "fake-third"');
    expect(third.ok === false ? third.reason : '').toContain('mcp/d.yaml');
    expect(proto.ok).toBe(false);
    expect(recordedKeyOfWord('claude')).toBe('claude-code');
  });
});

describe('the inventory wire', () => {
  test('names a harness by the family table only', () => {
    const row = {
      id: 'i1',
      name: 'n',
      scope: 'user',
      transport: 'stdio',
      target: 't',
      runtimes: [],
    };
    expect(McpInventorySchema.safeParse({ servers: [{ ...row, harness: 'codex' }], problems: [] }).success).toBe(true);
    expect(McpInventorySchema.safeParse({ servers: [{ ...row, harness: 'fake-third' }], problems: [] }).success).toBe(
      false,
    );
  });
});
