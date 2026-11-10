import { describe, expect, test } from 'bun:test';
import type { RuntimeHome, RuntimeId, RuntimeSummary } from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import type { McpItem } from '../../contract/index.ts';
import { accountsOf, componentsOf, layeredMcp } from '../../daemon/lib/inventory/runtime-wiring.ts';

const id = (name: string) => name as RuntimeId;
const summary = (name: string): RuntimeSummary =>
  ({
    id: id(name),
    harness: 'claude-code',
    login: 'l',
    profile: 'p',
    agent: false,
    launch: { available: true },
  }) as RuntimeSummary;
const ITEMS = new Map<string, McpItem>([
  ['docs', { url: 'https://docs.example.com/mcp', auth: 'oauth' }],
  ['tool', { command: 'npx' }],
]);

describe('accounts from the published homes', () => {
  test('one account per runtime a home lists, in manifest order, with the home and wrapper', () => {
    const homes: RuntimeHome[] = [
      { id: 'a', harness: 'claude-code', runtimes: [id('one'), id('two')], home: '/fleet/homes/a', wrapper: '/w/a' },
      { id: 'b', harness: 'codex', runtimes: [id('three')], home: '/fleet/homes/b', wrapper: '/w/b' },
    ];
    expect(accountsOf(homes)).toEqual([
      { runtime: 'one', harness: 'claude-code', home: '/fleet/homes/a', wrapper: '/w/a' },
      { runtime: 'two', harness: 'claude-code', home: '/fleet/homes/a', wrapper: '/w/a' },
      { runtime: 'three', harness: 'codex', home: '/fleet/homes/b', wrapper: '/w/b' },
    ]);
    expect(accountsOf([])).toEqual([]);
  });
});

describe('the items a runtime profile layers', () => {
  test('the names its stack lists; nothing for no Runtimes, no runtime, an unknown runtime or an unresolvable stack', async () => {
    const runtimes = fakeRuntimes();
    runtimes.setProfiles([], [{ runtime: id('one'), profile: 'p', mcp: ['docs'], skills: ['s'] }]);
    expect([...(await layeredMcp(runtimes, 'one'))]).toEqual(['docs']);
    expect((await layeredMcp(runtimes, 'unknown')).size).toBe(0);
    expect((await layeredMcp(undefined, 'one')).size).toBe(0);
    expect((await layeredMcp(runtimes, undefined)).size).toBe(0);
    const broken = { ...runtimes, layers: async () => Promise.reject(new Error('a base does not exist')) };
    expect((await layeredMcp(broken, 'one')).size).toBe(0);
  });

  test('a component lists the runtimes that layer it, keeps its sign-in kind, and is in none when Runtimes is off', async () => {
    const runtimes = fakeRuntimes();
    runtimes.setRuntimes([summary('one'), summary('two')]);
    runtimes.setProfiles(
      [],
      [
        { runtime: id('one'), profile: 'p', mcp: ['docs'], skills: [] },
        { runtime: id('two'), profile: 'q', mcp: ['docs', 'tool'], skills: [] },
      ],
    );
    expect(await componentsOf(ITEMS, runtimes)).toEqual([
      { name: 'docs', runtimes: ['one', 'two'], auth: 'oauth' },
      { name: 'tool', runtimes: ['two'] },
    ]);
    expect(await componentsOf(ITEMS, undefined)).toEqual([
      { name: 'docs', runtimes: [], auth: 'oauth' },
      { name: 'tool', runtimes: [] },
    ]);
  });
});
