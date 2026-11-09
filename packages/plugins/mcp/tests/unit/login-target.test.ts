import { describe, expect, test } from 'bun:test';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { RuntimeIdSchema, type RuntimeSummary } from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import { runtimesLoginTarget } from '../../daemon/lib/session/login-target.ts';
import { SessionMcpRefusal } from '../../daemon/lib/session/service.ts';

const WORK: RuntimeSummary = {
  id: RuntimeIdSchema.parse('claude-work'),
  harness: 'claude-code',
  login: 'work',
  profile: 'work',
  agent: false,
  launch: { available: true },
};
const PROFILE = { name: 'work', layers: ['instructions/base'], etag: 'etag-1' };
/** A caller that may change the fleet: the standing Runtimes judges. */
const OWNER = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) };

interface Write {
  name: string;
  patch: Readonly<Record<string, unknown>>;
  ifMatch: 'absent' | undefined;
}

function setup(options: { runtimes?: 'off'; items?: string[]; outcome?: ConfigWriteOutcome } = {}) {
  const runtimes = fakeRuntimes();
  runtimes.setRuntimes([WORK]);
  runtimes.setProfiles([PROFILE]);
  const writes: Write[] = [];
  const target = runtimesLoginTarget({
    runtimes: () => (options.runtimes === 'off' ? undefined : runtimes),
    hasItem: name => (options.items ?? []).includes(name),
    writeItem: async (name, patch, ifMatch) => {
      writes.push({ name, patch, ifMatch });
      return options.outcome ?? { kind: 'written', etag: 'e', loosened: [] };
    },
  });
  return { runtimes, target, writes };
}

async function refusal(work: Promise<unknown>): Promise<SessionMcpRefusal> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SessionMcpRefusal);
  return error as SessionMcpRefusal;
}

describe('the login target reads Runtimes', () => {
  test('R-0352 a runtime and its profile answer by name, and an unknown one answers undefined', async () => {
    const { target } = setup({ items: ['acme'] });
    expect(await target.runtime('claude-work')).toEqual({ name: 'claude-work', profile: 'work' });
    expect(await target.runtime('nobody')).toBeUndefined();
    expect(await target.profile('work')).toEqual(PROFILE);
    expect(await target.profile('gone')).toBeUndefined();
    expect(await target.hasItem('acme')).toBe(true);
    expect(await target.hasItem('other')).toBe(false);
  });

  test('R-0352 with Runtimes off nothing is found and a layer write refuses in words', async () => {
    const { target } = setup({ runtimes: 'off' });
    expect(await target.runtime('claude-work')).toBeUndefined();
    expect(await target.profile('work')).toBeUndefined();
    const refused = await refusal(target.layerProfile(PROFILE, 'mcp/acme', OWNER));
    expect([refused.status, refused.code]).toEqual([409, 'mcp_runtime_unknown']);
  });
});

describe('the login target writes the item', () => {
  test('R-0351 a new item is a create, and every definition key it does not name is cleared', async () => {
    const { target, writes } = setup();
    await target.putItem('acme', { url: 'https://mcp.example.com', auth: 'oauth' }, true);
    expect(writes).toEqual([
      {
        name: 'acme',
        ifMatch: 'absent',
        patch: {
          command: undefined,
          args: undefined,
          env: undefined,
          url: 'https://mcp.example.com',
          auth: 'oauth',
          oauth: undefined,
        },
      },
    ]);
  });

  test('R-0351 a replaced item is not a create, so it carries no absent match', async () => {
    const { target, writes } = setup();
    await target.putItem('acme', { command: 'npx', args: ['acme'] }, false);
    expect(writes[0]?.ifMatch).toBeUndefined();
    expect(writes[0]?.patch).toMatchObject({ command: 'npx', args: ['acme'], url: undefined });
  });

  test.each([
    [{ kind: 'held', etag: 'e', id: 'h1', sentences: ['it loosens spend.'] }, 'mcp_change_held', 'it loosens spend.'],
    [{ kind: 'conflict' }, 'mcp_item_changed', 'changed since you looked'],
    [
      { kind: 'refused', reason: 'schema', issues: [{ path: 'url', message: 'not a url' }] },
      'mcp_item_refused',
      'url: not a url',
    ],
    [{ kind: 'refused', reason: 'would_hold', sentences: ['x'] }, 'mcp_item_refused', 'The server was not written.'],
  ] as const)('R-0351 an item write that is %j refuses as %s', async (outcome, code, words) => {
    const { target } = setup({ outcome: outcome as unknown as ConfigWriteOutcome });
    const refused = await refusal(target.putItem('acme', { command: 'npx' }, true));
    expect([refused.status, refused.code]).toEqual([409, code]);
    expect(refused.message).toContain(words);
  });
});

describe('the login target adds one layer through Runtimes', () => {
  test('R-0351 one mcp layer is added to the one profile, matched on its etag, for a caller who may', async () => {
    const { target, runtimes } = setup();
    await target.layerProfile(PROFILE, 'mcp/acme', OWNER);
    expect(runtimes.changes).toEqual([{ kind: 'add', profile: 'work', layer: 'mcp/acme', ifMatch: 'etag-1' }]);
    expect((await runtimes.profiles()).find(profile => profile.name === 'work')?.layers).toEqual([
      'instructions/base',
      'mcp/acme',
    ]);
  });

  test('R-0351 a caller with no standing is refused in Runtimes words and nothing is written', async () => {
    const { target, runtimes } = setup();
    const refused = await refusal(target.layerProfile(PROFILE, 'mcp/acme', undefined));
    expect([refused.status, refused.code]).toEqual([409, 'mcp_profile_refused']);
    expect(refused.message).toBe('this daemon cannot say whether this caller may change the fleet');
    expect((await runtimes.profiles()).find(profile => profile.name === 'work')?.layers).toEqual(['instructions/base']);
  });

  test('R-0351 a profile that moved since it was read is a conflict, and a held change says so', async () => {
    const { target, runtimes } = setup();
    const stale = await refusal(target.layerProfile({ ...PROFILE, etag: 'old' }, 'mcp/acme', OWNER));
    expect([stale.status, stale.code]).toEqual([409, 'mcp_profile_changed']);
    expect(stale.message).toBe('The profile work changed since you looked. Preview again.');
    runtimes.setChangeOutcome({ kind: 'held', sentence: 'waits for the owner' });
    const held = await refusal(target.layerProfile(PROFILE, 'mcp/acme', OWNER));
    expect([held.status, held.code]).toEqual([409, 'mcp_change_held']);
    expect(held.message).toContain('waits for the owner');
  });
});
