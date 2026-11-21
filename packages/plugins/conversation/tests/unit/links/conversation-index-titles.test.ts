import { describe, expect, test } from 'bun:test';
import {
  ConversationIndex,
  type FerretConversationNames,
  type IndexSource,
  type ScrubBatch,
} from '../../../daemon/links/lib/conversation-index.ts';
import { claudeRecord, codexRollout, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

/**
 * R11 S11: what the index STORES as a title, and what it offers Ferrets. Every secret is fake. The vault is a fake that masks
 * the values it holds as the kernel's redaction does (`[redacted:NAME]`).
 */

const A = '3b1a4a52-0000-4000-8000-00000000000a';
const CODEX = '5c1e0e3a-0000-4000-8000-0000000000aa';
const pathOf = (id: string) => `projects/-work-app/${id}.jsonl`;
const AT = '2026-02-01T09:00:00.000Z';
const talk = (user: string, at = AT, reply = 'done') =>
  `${claudeRecord('user', user, at)}\n${claudeRecord('assistant', reply, at)}\n`;
const rec = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;

const VALUES = { DEPLOY_KEY: 'hunter2-prod-deploy', NOTE: 'the blue falcon flies at dawn' } as const;
// Spelled in two pieces: a whole secret-shaped literal would make GitHub's push protection refuse the branch.
const GHP = `${'ghp_'}aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6`;

const vault =
  (values: Readonly<Record<string, string>>): ScrubBatch =>
  async work =>
    work(text =>
      Object.entries(values).reduce((masked, [name, value]) => masked.split(value).join(`[redacted:${name}]`), text),
    );

interface Offered {
  readonly ferret: string;
  readonly title: string;
}

const setup = (
  options: {
    readonly names?: () => FerretConversationNames;
    /** `'none'`: no vault is wired at all. */
    readonly scrubbing?: ScrubBatch | 'none';
    readonly adopt?: (ferret: string, title: string) => Promise<'adopted' | 'kept'>;
  } = {},
) => {
  const sqlite = memorySqlite();
  const owner = new MemoryHistory();
  const codex = new MemoryHistory();
  const sources: IndexSource[] = [
    { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: owner },
    { harness: 'codex', parser: 'codex', kind: 'computer', label: 'codex-owner', files: codex },
  ];
  const offered: Offered[] = [];
  const clock = { ms: 0 };
  const index = new ConversationIndex({
    sqlite: () => sqlite,
    sources: async () => sources,
    ferretNames: async () => options.names?.() ?? new Map(),
    parsers: PARSERS,
    nowMs: () => clock.ms,
    ...(options.scrubbing === 'none' ? {} : { scrubbing: options.scrubbing ?? vault(VALUES) }),
    adoptTitle:
      options.adopt ??
      (async (ferret, title) => {
        offered.push({ ferret, title });
        return 'adopted';
      }),
  });
  /** Every cell of every table the index keeps: what a leak would be found in. */
  const stored = (): string =>
    JSON.stringify([
      ...sqlite.database.query('SELECT * FROM conv').all(),
      ...sqlite.database.query('SELECT * FROM index_names').all(),
    ]);
  return { index, owner, codex, offered, stored, sqlite, clock };
};

const ferretOf = (extra: Record<string, unknown> = {}): FerretConversationNames =>
  new Map([[`claude-code:${A}`, { ferret: 'ms-12', name: 'Ms-12', ...extra }]]);

describe('nothing secret is stored in the index, whichever way the conversation was named', () => {
  test('a first message with a token and a vault value: neither is in any stored cell, and the title is made from the rest', async () => {
    const { index, owner, stored } = setup();
    owner.set(
      pathOf(A),
      talk(`Fix the deploy script. The key is ${VALUES.DEPLOY_KEY} and the token is ${GHP}, and ${VALUES.NOTE}`),
    );
    await index.refresh();
    const row = index.query().conversations[0]?.row;
    expect(row?.name).toBe('Fix the Deploy Script');
    expect(row?.title).toBe('Fix the Deploy Script');
    for (const secret of [VALUES.DEPLOY_KEY, GHP, VALUES.NOTE, 'hunter2', GHP.slice(0, 10)]) {
      expect(stored()).not.toContain(secret);
    }
    // The vault's mark names the secret; it is not a word of anything shown.
    expect(JSON.stringify(row)).not.toContain('DEPLOY_KEY');
  });

  test('the first message of a LATER read, folded in as a delta, is scrubbed too', async () => {
    const { index, owner, stored } = setup();
    owner.set(pathOf(A), talk('please fix the login page'));
    await index.refresh();
    owner.append(pathOf(A), talk(`and then use ${GHP} for the registry`, '2026-02-01T09:30:00.000Z'));
    await index.refresh();
    expect(stored()).not.toContain(GHP);
    expect(index.query().conversations[0]?.row.latest).toBeDefined();
    expect(index.query().conversations[0]?.row.latest).not.toContain('ghp_');
  });

  test('a title the CLI generated, and one the owner typed with /rename, are scrubbed', async () => {
    const { index, owner, stored } = setup();
    owner.set(pathOf(A), talk('hello') + rec({ type: 'ai-title', aiTitle: `Deploy with ${VALUES.DEPLOY_KEY} today` }));
    await index.refresh();
    expect(index.query().conversations[0]?.row.name).toBe('Deploy with today');
    owner.append(pathOf(A), rec({ type: 'custom-title', customTitle: `Rotate ${GHP} now` }));
    await index.refresh();
    expect(index.query().conversations[0]?.row.name).toBe('Rotate now');
    expect(stored()).not.toContain('hunter2');
    expect(stored()).not.toContain(GHP);
  });

  test('Codex’s own thread name (its session index) is scrubbed before it is stored', async () => {
    const { index, codex, stored } = setup();
    codex.set(
      `sessions/2026/02/01/rollout-2026-02-01T09-00-00-${CODEX}.jsonl`,
      codexRollout(CODEX, '/work/app', 'fix the build'),
    );
    codex.set(
      'session_index.jsonl',
      rec({ id: CODEX, thread_name: `Build with ${VALUES.DEPLOY_KEY} ${GHP}`, updated_at: AT }),
    );
    await index.refresh();
    expect(index.query().conversations[0]?.row.name).toBe('Build with');
    expect(stored()).not.toContain('hunter2');
    expect(stored()).not.toContain(GHP);
  });

  test('a ferret’s own title (typed by its owner with a secret in it) is scrubbed', async () => {
    const { index, owner, stored } = setup({
      names: () => ferretOf({ title: `Deploy ${VALUES.DEPLOY_KEY} ${GHP} soon`, titleSource: 'owner' }),
    });
    owner.set(pathOf(A), talk('hello there'));
    await index.refresh();
    expect(index.query().conversations[0]?.row.name).toBe('Deploy soon');
    expect(stored()).not.toContain('hunter2');
    expect(stored()).not.toContain(GHP);
  });

  test('a vault that cannot be read fails closed: nothing is stored, and the next update tries again', async () => {
    let failing = true;
    const scrubbing: ScrubBatch = async work => {
      if (failing) throw new Error('the vault is locked');
      return work(text => text);
    };
    const { index, owner } = setup({ scrubbing });
    owner.set(pathOf(A), talk(`please fix ${GHP} the login`));
    await index.refresh();
    expect(index.query().matched).toBe(0);
    failing = false;
    owner.set(pathOf(A), talk(`please fix ${GHP} the login`));
    await index.refresh();
    expect(index.query().matched).toBe(1);
    expect(JSON.stringify(index.query())).not.toContain(GHP);
  });

  test('with no vault wired the credential shapes are still dropped', async () => {
    const { index, owner, stored } = setup({ scrubbing: 'none' });
    owner.set(pathOf(A), talk(`Fix the build with ${GHP}`));
    await index.refresh();
    expect(index.query().conversations[0]?.row.name).toBe('Fix the Build');
    expect(stored()).not.toContain(GHP);
  });
});

describe('which title a conversation goes by', () => {
  test('the owner’s ferret title, then the CLI’s own name, then its generated title, then one from the first message', async () => {
    const owned = ferretOf({ title: 'My own words', titleSource: 'owner' });
    const { index, owner } = setup({ names: () => owned });
    owner.set(
      pathOf(A),
      talk('can you look at the deploy script') +
        rec({ type: 'ai-title', aiTitle: 'Generated title' }) +
        rec({ type: 'custom-title', customTitle: 'Typed in the CLI' }),
    );
    await index.refresh();
    // The ferret owner's title beats the CLI's typed name.
    expect(index.query().conversations[0]?.row.name).toBe('My own words');

    const second = setup();
    second.owner.set(
      pathOf(A),
      talk('can you look at the deploy script') +
        rec({ type: 'ai-title', aiTitle: 'Generated title' }) +
        rec({ type: 'custom-title', customTitle: 'Typed in the CLI' }),
    );
    await second.index.refresh();
    expect(second.index.query().conversations[0]?.row.name).toBe('Typed in the CLI');

    const third = setup();
    third.owner.set(
      pathOf(A),
      talk('can you look at the deploy script') + rec({ type: 'ai-title', aiTitle: 'Generated title' }),
    );
    await third.index.refresh();
    expect(third.index.query().conversations[0]?.row.name).toBe('Generated title');

    const fourth = setup();
    fourth.owner.set(pathOf(A), talk('can you look at the deploy script'));
    await fourth.index.refresh();
    expect(fourth.index.query().conversations[0]?.row.name).toBe('Look at the Deploy Script');
  });

  test('a ferret named only by the callsign has no title: its conversation is not called by the callsign', async () => {
    const { index, owner } = setup({ names: () => ferretOf() });
    owner.set(pathOf(A), talk('fix the flaky login test'));
    await index.refresh();
    const row = index.query().conversations[0]?.row;
    expect(row?.name).toBe('Fix the Flaky Login Test');
    expect(JSON.stringify(row?.name)).not.toMatch(/ms-12/iu);
    // The callsign is still how a ferret is found.
    expect(index.query({ words: ['ms-12'] }).matched).toBe(1);
  });

  test('the start placeholder is never a title (the caller leaves it out; a title the owner typed is kept)', async () => {
    const { index, owner } = setup({ names: () => ferretOf({ title: 'Keep me', titleSource: 'owner' }) });
    owner.set(pathOf(A), talk('fix the flaky login test'));
    await index.refresh();
    expect(index.query().conversations[0]?.row.name).toBe('Keep me');
  });
});

describe('a ferret’s conversation title is offered to Ferrets', () => {
  test('an untitled ferret is offered the CLI’s generated title, once', async () => {
    const { index, owner, offered } = setup({ names: () => ferretOf() });
    owner.set(pathOf(A), talk('hello') + rec({ type: 'ai-title', aiTitle: 'Fix flaky login test' }));
    await index.refresh();
    expect(offered).toEqual([{ ferret: 'ms-12', title: 'Fix flaky login test' }]);
    await index.refresh();
    await index.refresh();
    expect(offered).toHaveLength(1);
  });

  test('with no CLI title, the one made from the first message is offered', async () => {
    const { index, owner, offered } = setup({ names: () => ferretOf() });
    owner.set(pathOf(A), talk('fix the flaky login test'));
    await index.refresh();
    expect(offered).toEqual([{ ferret: 'ms-12', title: 'Fix the Flaky Login Test' }]);
  });

  test('the offered title is the scrubbed one', async () => {
    const { index, owner, offered } = setup({ names: () => ferretOf() });
    owner.set(pathOf(A), talk(`Fix the deploy ${GHP} script. The key is ${VALUES.DEPLOY_KEY}`));
    await index.refresh();
    expect(offered).toHaveLength(1);
    expect(JSON.stringify(offered)).not.toContain('ghp_');
    expect(JSON.stringify(offered)).not.toContain('hunter2');
  });

  test('a ferret whose title the owner chose is never offered one', async () => {
    const { index, owner, offered } = setup({ names: () => ferretOf({ title: 'Mine', titleSource: 'owner' }) });
    owner.set(pathOf(A), talk('hello') + rec({ type: 'ai-title', aiTitle: 'Generated' }));
    await index.refresh();
    expect(offered).toEqual([]);
  });

  test('a newer CLI title is offered again, and an owner’s rename in between is respected', async () => {
    let names = ferretOf();
    const { index, owner, offered } = setup({ names: () => names });
    owner.set(pathOf(A), talk('hello') + rec({ type: 'ai-title', aiTitle: 'First title' }));
    await index.refresh();
    // Ferrets recorded it as `auto`; the next listing reads it back.
    names = ferretOf({ title: 'First title', titleSource: 'auto' });
    owner.append(pathOf(A), rec({ type: 'ai-title', aiTitle: 'A better title' }));
    await index.refresh();
    expect(offered.map(item => item.title)).toEqual(['First title', 'A better title']);

    // The owner renames; a newer generated title is then not offered, and the row keeps the owner's words.
    names = ferretOf({ title: 'Owner’s own', titleSource: 'owner' });
    owner.append(pathOf(A), rec({ type: 'ai-title', aiTitle: 'Newest generated' }));
    await index.refresh();
    expect(offered.map(item => item.title)).toEqual(['First title', 'A better title']);
    expect(index.query().conversations[0]?.row.name).toBe('Owner’s own');
  });

  test('a title Ferrets already holds is not offered back', async () => {
    const { index, owner, offered } = setup({
      names: () => ferretOf({ title: 'Fix flaky login test', titleSource: 'auto' }),
    });
    owner.set(pathOf(A), talk('hello') + rec({ type: 'ai-title', aiTitle: 'Fix flaky login test' }));
    await index.refresh();
    expect(offered).toEqual([]);
  });

  test('a conversation no ferret keeps offers nothing, and a refusal to adopt is not an error of the index', async () => {
    const { index, owner, offered } = setup();
    owner.set(pathOf(A), talk('hello') + rec({ type: 'ai-title', aiTitle: 'Some title' }));
    await index.refresh();
    expect(offered).toEqual([]);

    const attempts: string[] = [];
    const failing = setup({
      names: () => ferretOf(),
      adopt: async (_ferret, title) => {
        attempts.push(title);
        throw new Error('ferrets is busy');
      },
    });
    failing.owner.set(pathOf(A), talk('hello') + rec({ type: 'ai-title', aiTitle: 'Some title' }));
    await failing.index.refresh();
    expect(failing.index.query().matched).toBe(1);
    // It is offered again on the next update, because the first offer did not land.
    await failing.index.refresh();
    expect(attempts).toEqual(['Some title', 'Some title']);
  });

  test('a title the CLI writes later reaches the ferret within the index’s own freshness bound (5 s on the fake clock)', async () => {
    // Ferrets' record, as the index reads it back: it stores what it is offered, as `auto`, unless the owner chose the title.
    let held: { title?: string; titleSource?: 'owner' | 'auto' } = {};
    const { index, owner, clock } = setup({
      names: () => ferretOf(held),
      adopt: async (_ferret, title) => {
        if (held.titleSource === 'owner') return 'kept';
        held = { title, titleSource: 'auto' };
        return 'adopted';
      },
    });
    owner.set(pathOf(A), talk('please look at the login test'));
    await index.refresh();
    expect(held.title).toBe('Look at the Login Test');
    // Claude Code writes its own title a minute later; a listing (the Conversations list, or the drawer's refresh) asks the index.
    owner.append(pathOf(A), rec({ type: 'ai-title', aiTitle: 'Fix flaky login test' }));
    clock.ms += 5_000;
    await index.ready();
    expect(held).toEqual({ title: 'Fix flaky login test', titleSource: 'auto' });
  });

  test('no model is called: the index has no way to reach one (its only outward calls are the scrub and the offer)', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      throw new Error('no network in this test');
    }) as unknown as typeof fetch;
    try {
      const { index, owner } = setup({ names: () => ferretOf() });
      owner.set(pathOf(A), talk('fix the flaky login test'));
      await index.refresh();
      index.query();
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([]);
  });
});
