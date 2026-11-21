import { describe, expect, test } from 'bun:test';
import { LinkListingSchema } from '../../../contract/index.ts';
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
const B = '3b1a4a52-0000-4000-8000-00000000000b';
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
    /** Whether the ferret snapshot is the whole registry (Ferrets' `rosterComplete`). Absent: no such need (complete). */
    readonly complete?: () => Promise<boolean>;
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
    ...(options.complete === undefined ? {} : { rosterComplete: options.complete }),
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
  test('a first message with a token and a vault value: neither is in any stored cell, and the title is the plain fallback', async () => {
    const { index, owner, stored } = setup();
    owner.set(
      pathOf(A),
      talk(`Fix the deploy script. The key is ${VALUES.DEPLOY_KEY} and the token is ${GHP}, and ${VALUES.NOTE}`),
    );
    await index.refresh();
    const row = index.query().conversations[0]?.row;
    // It names a token, so no heuristic title is made from it (fail closed).
    expect(row?.name).toBe('Conversation');
    expect(row?.title).toBe('Conversation');
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

describe('what is stored and offered is masked from the WHOLE message, then collapsed, then cut (review SEC 2, review 1)', () => {
  const PEM = 'first pem line\nsecond pem line\nthird pem line';
  const FRUIT = 'zebraMangoPapayaKiwi';
  const vaultOf = vault({ ...VALUES, PEM, FRUIT });
  const SECRET_PARTS = ['first pem', 'second pem', 'third pem', 'zebra', 'Mango', 'Papaya', 'Kiwi', 'hunter2'];
  const leaks = (text: string): string[] => SECRET_PARTS.filter(part => text.includes(part));

  test('a value across several lines never reaches the stored row, the wire row or the title a ferret is offered', async () => {
    const { index, owner, stored, offered } = setup({ scrubbing: vaultOf, names: () => ferretOf() });
    owner.set(pathOf(A), talk(`Fix the signing step. Use this cert:\n${PEM}\nthen push`, AT, `ok, used\n${PEM}\nfine`));
    await index.refresh();
    const wire = JSON.stringify(index.query().conversations);
    expect(leaks(stored())).toEqual([]);
    expect(leaks(wire)).toEqual([]);
    expect(leaks(JSON.stringify(offered))).toEqual([]);
    expect(index.query().conversations[0]?.row.preview).toContain('Fix the signing step');
  });

  test('a value that crosses the 120-character cut leaves no prefix, in the preview or in the latest', async () => {
    const { index, owner, stored } = setup({ scrubbing: vaultOf });
    owner.set(
      pathOf(A),
      `${talk(`${'a'.repeat(111)} ${FRUIT} the end`)}${talk(`${'b'.repeat(112)} ${FRUIT}`, '2026-02-01T09:20:00.000Z')}`,
    );
    await index.refresh();
    const row = index.query().conversations[0]?.row;
    expect(row?.preview.length).toBeLessThanOrEqual(120);
    expect(row?.latest?.length ?? 0).toBeLessThanOrEqual(120);
    expect(leaks(stored())).toEqual([]);
    expect(leaks(JSON.stringify(index.query().conversations))).toEqual([]);
  });

  test('the append path masks a value that is on several lines or across the cut, in the latest and in the stored row', async () => {
    const { index, owner, stored } = setup({ scrubbing: vaultOf });
    owner.set(pathOf(A), talk('please fix the login page'));
    await index.refresh();
    owner.append(pathOf(A), talk(`also note:\n${PEM}\nplease`, '2026-02-01T09:30:00.000Z'));
    await index.refresh();
    expect(index.query().conversations[0]?.row.latest).toBe('also note: please');
    owner.append(pathOf(A), talk(`${'c'.repeat(113)} ${FRUIT}`, '2026-02-01T09:40:00.000Z'));
    await index.refresh();
    expect(leaks(stored())).toEqual([]);
    expect(leaks(JSON.stringify(index.query().conversations))).toEqual([]);
  });

  test('a CLI title on several lines, or across the cut, is masked whole before it is stored or offered', async () => {
    const { index, owner, stored, offered } = setup({ scrubbing: vaultOf, names: () => ferretOf() });
    owner.set(
      pathOf(A),
      talk('hello') + rec({ type: 'ai-title', aiTitle: `Sign with\n${PEM}\nand ${'t'.repeat(90)} ${FRUIT}` }),
    );
    await index.refresh();
    expect(leaks(stored())).toEqual([]);
    expect(leaks(JSON.stringify(index.query().conversations))).toEqual([]);
    expect(leaks(JSON.stringify(offered))).toEqual([]);
  });

  test('a title made from the first message of 2000+ characters, with a value across the brief cut, leaks no prefix', async () => {
    const { index, owner, stored, offered } = setup({ scrubbing: vaultOf, names: () => ferretOf() });
    owner.set(pathOf(A), talk(`Fix the login redirect.\n\n${'x '.repeat(983)}${FRUIT} end`));
    await index.refresh();
    expect(leaks(stored())).toEqual([]);
    expect(leaks(JSON.stringify(offered))).toEqual([]);
  });
});

describe('a credential named in a sentence or a URL is not stored, shown or offered (review SEC 1)', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['set API_KEY = q8w7e6r5t4 then deploy', 'q8w7e6r5t4'],
    ['password: hunter22x then log in', 'hunter22x'],
    ['the password is zxcvb12 so fix the login', 'zxcvb12'],
    ['fetch https://example.test/api?token=s3cretpw now', 's3cretpw'],
    ['fetch https://example.test/api?access_token=abcd1234 now', 'abcd1234'],
  ];

  for (const [message, secret] of cases) {
    test(`“${message}”`, async () => {
      const { index, owner, stored, offered } = setup({ scrubbing: 'none', names: () => ferretOf() });
      owner.set(pathOf(A), talk(message));
      await index.refresh();
      expect(stored()).not.toContain(secret);
      expect(JSON.stringify(index.query().conversations)).not.toContain(secret);
      expect(JSON.stringify(offered)).not.toContain(secret);
    });
  }

  test('a title that comes out empty falls back to the SCRUBBED opening, never the raw message', async () => {
    const { index, owner, stored } = setup({ scrubbing: 'none' });
    owner.set(pathOf(A), talk('password: hunter22x'));
    await index.refresh();
    const row = index.query().conversations[0]?.row;
    expect(stored()).not.toContain('hunter22x');
    expect((row?.name ?? '').length).toBeGreaterThan(0);
    expect(row?.name ?? '').not.toContain('hunter22x');
  });
});

describe('ordinary text is shown as written, and the wire never gets a row it refuses (review 2)', () => {
  test('a preview with compatibility characters keeps its glyphs and stays within 120', async () => {
    const { index, owner } = setup();
    const written = `ﬁx the ｌｏｇｉｎ ﬂow ${'ﬁ'.repeat(100)} and more words after that`;
    owner.set(pathOf(A), talk(written));
    await index.refresh();
    const row = index.query().conversations[0]?.row;
    expect(row?.preview.startsWith('ﬁx the ｌｏｇｉｎ ﬂow ﬁﬁ')).toBe(true);
    expect(row?.preview.length).toBeLessThanOrEqual(120);
  });

  test('a message that is only a secret leaves no empty latest, no empty name and no unlisted row: the WHOLE listing parses', async () => {
    const { index, owner } = setup({ scrubbing: 'none', names: () => ferretOf({ name: '' }) });
    owner.set(pathOf(A), talk(`${GHP}`, AT, 'fine') + talk(GHP, '2026-02-01T09:10:00.000Z'));
    owner.set(pathOf(B), talk('Fix the flaky login test'));
    await index.refresh();
    const answer = index.query();
    expect(answer.conversations.length).toBe(2);
    const listing = LinkListingSchema.parse({
      conversations: answer.conversations.map(entry => entry.row),
      matched: answer.matched,
      skipped: 0,
    });
    for (const row of listing.conversations) {
      expect(row.name?.length).toBeGreaterThan(0);
      expect(row.latest === undefined || row.latest.length > 0).toBe(true);
    }
    expect(JSON.stringify(listing)).not.toContain(GHP);
  });
});

describe('a scoped update (the title sweep) reads only the conversations it is asked about (r11 S11 round 3)', () => {
  test('only the named conversation is read, nothing else is added or dropped, and the index is not marked fresh', async () => {
    const { index, owner, offered } = setup({ names: () => ferretOf({ titleSource: 'auto' }) });
    owner.set(pathOf(A), talk('please fix the login page'));
    owner.set(pathOf(B), talk('rewrite the release notes'));
    await index.refresh();
    expect(index.query().conversations).toHaveLength(2);
    offered.length = 0;

    // The ferret's CLI titles its conversation; an unrelated transcript changes, and a third one appears.
    owner.append(pathOf(A), rec({ type: 'ai-title', aiTitle: 'Fix flaky login test' }));
    owner.append(pathOf(B), talk('and mention the beta'));
    const C = '3b1a4a52-0000-4000-8000-00000000000c';
    owner.set(pathOf(C), talk('something new'));
    owner.resetReads();

    await index.refreshConversations(new Set([`claude-code:${A}`]));

    expect([...owner.readByPath.keys()]).toEqual([pathOf(A)]);
    expect(offered).toEqual([{ ferret: 'ms-12', title: 'Fix flaky login test' }]);
    // The unrelated ones are exactly as they were: B not re-read, C not added.
    expect(index.query().conversations).toHaveLength(2);

    // A listing still does its own full update afterwards and finds both.
    owner.resetReads();
    await index.refresh();
    expect(index.query().conversations).toHaveLength(3);
    expect([...owner.readByPath.keys()].sort()).toEqual([pathOf(B), pathOf(C)].sort());
  });

  test('a harness no watched conversation belongs to is not even listed', async () => {
    const { index, owner, codex } = setup({ names: () => ferretOf({ titleSource: 'auto' }) });
    owner.set(pathOf(A), talk('please fix the login page'));
    codex.set(
      `sessions/2026/02/01/rollout-2026-02-01T09-00-00-${CODEX}.jsonl`,
      codexRollout(CODEX, '/work/app', 'fix'),
    );
    await index.refresh();
    const listed: string[] = [];
    const entries = codex.entries.bind(codex);
    codex.entries = async directory => {
      listed.push(directory);
      return await entries(directory);
    };
    await index.refreshConversations(new Set([`claude-code:${A}`]));
    expect(listed).toEqual([]);
  });
});

describe('a scoped update touches only the conversations it was scoped to (r11 S11 round 4 a, b)', () => {
  const rolloutOf = (id: string) => `sessions/2026/02/01/rollout-2026-02-01T09-00-00-${id}.jsonl`;
  const CODEX2 = '5c1e0e3a-0000-4000-8000-0000000000bb';
  const nameOf = (index: ConversationIndex, id: string) =>
    index.query().conversations.find(entry => entry.row.id === id)?.row.name;

  test('(a) scoped to one Codex thread, another thread whose name left the index keeps its stored name; the scoped one is updated', async () => {
    const { index, codex } = setup({
      names: () => new Map([[`codex:${CODEX}`, { ferret: 'ms-9', name: 'Ms-9', titleSource: 'auto' }]]),
    });
    codex.set(rolloutOf(CODEX), codexRollout(CODEX, '/work/app', 'fix the build'));
    codex.set(rolloutOf(CODEX2), codexRollout(CODEX2, '/work/app', 'write the notes'));
    codex.set(
      'session_index.jsonl',
      rec({ id: CODEX, thread_name: 'Build one' }) + rec({ id: CODEX2, thread_name: 'Notes two' }),
    );
    await index.refresh();
    expect(nameOf(index, CODEX)).toBe('Build one');
    expect(nameOf(index, CODEX2)).toBe('Notes two');

    // The index file now renames the scoped thread, drops the other thread's name and names a third thread nobody scoped.
    codex.set('session_index.jsonl', rec({ id: CODEX, thread_name: 'Build one, renamed' }));
    await index.refreshConversations(new Set([`codex:${CODEX}`]));
    expect(nameOf(index, CODEX)).toBe('Build one, renamed');
    expect(nameOf(index, CODEX2)).toBe('Notes two');

    // The file was not marked as read: the next full update still applies it everywhere.
    await index.refresh();
    expect(nameOf(index, CODEX2)).not.toBe('Notes two');
  });

  test('(a) a scoped update stores no name for a thread it was not scoped to', async () => {
    const { index, codex, stored } = setup({
      names: () => new Map([[`codex:${CODEX}`, { ferret: 'ms-9', name: 'Ms-9', titleSource: 'auto' }]]),
    });
    codex.set(rolloutOf(CODEX), codexRollout(CODEX, '/work/app', 'fix the build'));
    codex.set(rolloutOf(CODEX2), codexRollout(CODEX2, '/work/app', 'write the notes'));
    await index.refresh();
    codex.set(
      'session_index.jsonl',
      rec({ id: CODEX, thread_name: 'Build one' }) + rec({ id: CODEX2, thread_name: 'Notes two' }),
    );
    await index.refreshConversations(new Set([`codex:${CODEX}`]));
    expect(nameOf(index, CODEX)).toBe('Build one');
    expect(stored()).not.toContain('Notes two');
  });

  describe('ferret names and owner titles under a scoped update (r11 S11 round 5 a)', () => {
    const OWNER = 'Owner chose this';
    /** Two Codex threads, each with its own ferret; B's has an owner title over B's CLI title "Other CLI title". */
    const world = (snapshot: { value: FerretConversationNames }) => {
      const made = setup({ names: () => snapshot.value });
      made.codex.set(rolloutOf(CODEX), codexRollout(CODEX, '/work/app', 'fix the build'));
      made.codex.set(rolloutOf(CODEX2), codexRollout(CODEX2, '/work/app', 'write the notes'));
      made.codex.set(
        'session_index.jsonl',
        rec({ id: CODEX, thread_name: 'Build one' }) + rec({ id: CODEX2, thread_name: 'Other CLI title' }),
      );
      return made;
    };
    const both = (): FerretConversationNames =>
      new Map([
        [`codex:${CODEX}`, { ferret: 'ms-9', name: 'Ms-9', titleSource: 'auto' as const, title: 'Build one' }],
        [`codex:${CODEX2}`, { ferret: 'ms-8', name: 'Ms-8', titleSource: 'owner' as const, title: OWNER }],
      ]);
    const bRow = (sqlite: ReturnType<typeof memorySqlite>) =>
      sqlite.database
        .query('SELECT ferret_id, ferret_name, ferret_title, ferret_title_owner, title FROM conv WHERE id = ?')
        .get(CODEX2) as Record<string, unknown>;

    test('the reviewer repro: B is absent from the snapshot and a scoped refresh of A renames A; B keeps its ferret, owner title and shown title', async () => {
      const snapshot = { value: both() };
      const { index, codex, sqlite, offered } = world(snapshot);
      await index.refresh();
      const before = bRow(sqlite);
      expect(before).toMatchObject({ ferret_id: 'ms-8', ferret_title: OWNER, ferret_title_owner: 1 });
      expect(nameOf(index, CODEX2)).toBe(OWNER);

      snapshot.value = new Map([...both()].filter(([key]) => key === `codex:${CODEX}`));
      codex.set(
        'session_index.jsonl',
        rec({ id: CODEX, thread_name: 'Build one, renamed' }) + rec({ id: CODEX2, thread_name: 'Other CLI title' }),
      );
      offered.length = 0;
      await index.refreshConversations(new Set([`codex:${CODEX}`]));
      expect(nameOf(index, CODEX)).toBe('Build one, renamed');
      expect(bRow(sqlite)).toEqual(before);
      expect(nameOf(index, CODEX2)).toBe(OWNER);
      // Nothing is offered for B (not in scope); A's ferret is offered its CLI's new title.
      expect(offered).toEqual([{ ferret: 'ms-9', title: 'Build one, renamed' }]);
    });

    test("a scoped refresh does not read the snapshot rows of another conversation: B's ferret renamed meanwhile is not applied until a full refresh", async () => {
      const snapshot = { value: both() };
      const { index, sqlite } = world(snapshot);
      await index.refresh();
      snapshot.value = new Map([...both()].map(([key, ferret]) => [key, { ...ferret, name: `${ferret.name}-x` }]));
      await index.refreshConversations(new Set([`codex:${CODEX}`]));
      expect(bRow(sqlite)).toMatchObject({ ferret_name: 'Ms-8', ferret_title: OWNER });
      await index.refresh();
      expect(bRow(sqlite)).toMatchObject({ ferret_name: 'Ms-8-x', ferret_title: OWNER });
    });

    test("a scoped refresh never reads another conversation's linked row at all (the cleanup is scoped in SQL)", async () => {
      const snapshot = { value: both() };
      const { index, codex, sqlite } = world(snapshot);
      await index.refresh();
      snapshot.value = new Map([...both()].filter(([key]) => key === `codex:${CODEX}`));
      codex.set(
        'session_index.jsonl',
        rec({ id: CODEX, thread_name: 'Build one, renamed' }) + rec({ id: CODEX2, thread_name: 'Other CLI title' }),
      );
      // Every row any query returns during the scoped refresh is recorded: B's must never be among them.
      const returned: string[] = [];
      const query = sqlite.query;
      sqlite.query = <Row>(sql: string, params: readonly unknown[] = []) => {
        const rows = query<Row>(sql, params);
        for (const row of rows as readonly Record<string, unknown>[])
          if (row.id === CODEX2 && 'ferret_title' in row) returned.push(sql);
        return rows;
      };
      await index.refreshConversations(new Set([`codex:${CODEX}`]));
      sqlite.query = query;
      expect(returned).toEqual([]);
      expect(bRow(sqlite)).toMatchObject({ ferret_id: 'ms-8', ferret_title: OWNER, ferret_title_owner: 1 });
    });

    test('a FULL refresh keeps an owner title while its ferret is in the snapshot or the snapshot cannot be read; it drops it only once the ferret is gone', async () => {
      const snapshot = { value: both() };
      let failing = false;
      const sqlite = memorySqlite();
      const codex = new MemoryHistory();
      codex.set(rolloutOf(CODEX2), codexRollout(CODEX2, '/work/app', 'write the notes'));
      codex.set('session_index.jsonl', rec({ id: CODEX2, thread_name: 'Other CLI title' }));
      const index = new ConversationIndex({
        sqlite: () => sqlite,
        sources: async () => [
          { harness: 'codex', parser: 'codex', kind: 'computer', label: 'codex-owner', files: codex },
        ],
        ferretNames: async () => {
          if (failing) throw new Error('registry unavailable');
          return snapshot.value;
        },
        parsers: PARSERS,
        nowMs: () => 0,
        adoptTitle: async () => 'kept',
      });
      await index.refresh();
      expect(bRow(sqlite)).toMatchObject({ ferret_id: 'ms-8', ferret_title: OWNER });
      // The registry cannot be read: nothing changes.
      failing = true;
      await index.refresh();
      expect(bRow(sqlite)).toMatchObject({ ferret_id: 'ms-8', ferret_title: OWNER });
      // Readable again, the ferret still there: still its title.
      failing = false;
      await index.refresh();
      expect(bRow(sqlite)).toMatchObject({ ferret_id: 'ms-8', ferret_title: OWNER });
      // The ferret is really gone (the registry no longer has it): the row falls back to the conversation's own title.
      snapshot.value = new Map();
      await index.refresh();
      expect(bRow(sqlite)).toMatchObject({ ferret_id: null, ferret_title: null, title: 'Other CLI title' });
    });
  });

  /** An update listing the Claude tree waits at the gate until it is opened. */
  const gated = (owner: MemoryHistory) => {
    let open!: () => void;
    const gate = new Promise<void>(resolve => (open = resolve));
    const entries = owner.entries.bind(owner);
    let hit!: () => void;
    const reached = new Promise<void>(resolve => (hit = resolve));
    owner.entries = async directory => {
      hit();
      await gate;
      return await entries(directory);
    };
    return { open, reached, restore: () => (owner.entries = entries) };
  };
  const C = '3b1a4a52-0000-4000-8000-00000000000c';

  test('(b) a scoped update asked while a FULL update is running does not join it: it waits, then looks at only its own conversation', async () => {
    const { index, owner } = setup({ names: () => ferretOf({ titleSource: 'auto' }) });
    owner.set(pathOf(A), talk('please fix the login page'));
    owner.set(pathOf(B), talk('rewrite the release notes'));
    await index.refresh();
    owner.set(pathOf(C), talk('something new'));
    owner.append(pathOf(B), talk('and mention the beta'));
    const gate = gated(owner);
    const full = index.refresh();
    await gate.reached;
    gate.restore();
    owner.resetReads();
    const scoped = index.refreshConversations(new Set([`claude-code:${A}`]));
    // The scoped one is its own run: it is not the full update's promise.
    expect(scoped).not.toBe(full);
    gate.open();
    await scoped;
    expect(index.query().conversations).toHaveLength(3);
    // The full update read B and C once; the scoped one added nothing of its own beyond A (unchanged, so not read).
    expect([...owner.readByPath.keys()].sort()).toEqual([pathOf(B), pathOf(C)].sort());
  });

  test('(b) a listing asked while a scoped update is running is not answered by it: it runs its own full update, finds the new rows, and says so', async () => {
    const { index, owner, clock } = setup({ names: () => ferretOf({ titleSource: 'auto' }) });
    owner.set(pathOf(A), talk('please fix the login page'));
    await index.refresh();
    owner.set(pathOf(C), talk('something new'));
    // The index is old enough that a listing refreshes it first.
    clock.ms += 10 * 60_000;
    const gate = gated(owner);
    const scoped = index.refreshConversations(new Set([`claude-code:${A}`]));
    await gate.reached;
    gate.restore();
    const ready = index.ready();
    gate.open();
    await scoped;
    expect(await ready).toEqual({ indexing: false });
    // `ready` resolved only after a full update: the unrelated, new row is listed.
    expect(
      index
        .query()
        .conversations.map(entry => entry.row.id)
        .sort(),
    ).toEqual([A, C].sort());
  });

  test('(b) a listing that stops waiting for a slow full update says it is still indexing, and a scoped update asked meanwhile does not clear that', async () => {
    const owner = new MemoryHistory();
    const sqlite = memorySqlite();
    const clock = { ms: 0 };
    let slept!: () => void;
    const index = new ConversationIndex({
      sqlite: () => sqlite,
      sources: async () => [
        { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: owner },
      ],
      ferretNames: async () => ferretOf({ titleSource: 'auto' }),
      parsers: PARSERS,
      nowMs: () => clock.ms,
      sleep: async () => await new Promise<void>(resolve => (slept = resolve)),
    });
    owner.set(pathOf(A), talk('please fix the login page'));
    await index.refresh();
    owner.set(pathOf(C), talk('something new'));
    clock.ms += 10 * 60_000;
    const gate = gated(owner);
    const ready = index.ready();
    await gate.reached;
    gate.restore();
    const scoped = index.refreshConversations(new Set([`claude-code:${A}`]));
    slept();
    expect(await ready).toEqual({ indexing: true });
    gate.open();
    await scoped;
  });
});

describe('a bare JSON-quoted credential name is masked everywhere it could be stored or offered (r11 S11 round 4 c)', () => {
  test('"token":"x" in a first message, a CLI title and an owner title: not in any cell, the listing or the title offered to the ferret', async () => {
    const { index, owner, stored, offered } = setup({ names: () => ferretOf({ titleSource: 'auto' }) });
    owner.set(pathOf(A), talk('Please call the api with "token":"s3cretpw" and then fix the login page'));
    await index.refresh();
    owner.append(pathOf(A), rec({ type: 'ai-title', aiTitle: 'Send "token":"s3cretpw" to the api' }));
    await index.refresh();
    const answer = index.query();
    const listing = LinkListingSchema.parse({
      conversations: answer.conversations.map(entry => entry.row),
      matched: answer.matched,
      skipped: 0,
    });
    // The first message and the CLI title both name a token: neither makes a title (fail closed).
    expect(listing.conversations[0]?.name).toBe('Conversation');
    for (const text of [stored(), JSON.stringify(listing), JSON.stringify(offered)]) {
      expect(text).not.toContain('s3cretpw');
      expect(text).not.toContain('"token\\":');
    }
    expect(offered.at(-1)).toEqual({ ferret: 'ms-12', title: 'Conversation' });
  });

  test('the exact "token":"x" is masked in the stored title, preview, latest and the wire row', async () => {
    const { index, owner, stored } = setup();
    owner.set(pathOf(A), talk('use "token":"x" now', AT, 'ok "token":"x" noted'));
    owner.append(pathOf(A), rec({ type: 'ai-title', aiTitle: 'Rotate "token":"x" soon' }));
    await index.refresh();
    const row = index.query().conversations[0]?.row;
    expect(row?.name).toBe('Conversation');
    for (const text of [stored(), JSON.stringify(row)]) expect(text).not.toContain('\\"x\\"');
  });
});

describe('a full refresh clears a ferret or an owner title only from a snapshot known to be complete (r11 S11 round 7)', () => {
  const OWNER = 'Owner chose this';
  const owned = (): FerretConversationNames =>
    new Map([[`claude-code:${A}`, { ferret: 'ms-12', name: 'Ms-12', titleSource: 'owner' as const, title: OWNER }]]);
  const rowOf = (sqlite: ReturnType<typeof memorySqlite>) =>
    sqlite.database
      .query('SELECT ferret_id, ferret_name, ferret_title, ferret_title_owner FROM conv WHERE id = ?')
      .get(A) as Record<string, unknown>;
  const nameOf = (index: ConversationIndex, id: string) =>
    index.query().conversations.find(entry => entry.row.id === id)?.row.name;
  const KEPT = { ferret_id: 'ms-12', ferret_name: 'Ms-12', ferret_title: OWNER, ferret_title_owner: 1 };
  const world = (answer: () => Promise<boolean>, snapshot: { value: FerretConversationNames }) => {
    const made = setup({ names: () => snapshot.value, complete: answer });
    made.owner.set(pathOf(A), talk('fix the build'));
    return made;
  };

  const variants: readonly [string, () => Promise<boolean>][] = [
    ['the registry is still loading (resolves false)', async () => false],
    ['the registry failed to load (rejects)', async () => Promise.reject(new Error('the records could not be listed'))],
    ['one listed record could not be read (resolves false)', async () => false],
  ];
  for (const [what, answer] of variants)
    test(`${what}: an empty snapshot clears nothing, the owner title and the ferret stay`, async () => {
      const snapshot = { value: owned() };
      let complete = true;
      const made = world(async () => (complete ? true : await answer()), snapshot);
      await made.index.refresh();
      expect(rowOf(made.sqlite)).toMatchObject(KEPT);

      complete = false;
      snapshot.value = new Map();
      await made.index.refresh();
      expect(rowOf(made.sqlite)).toMatchObject(KEPT);
      expect(nameOf(made.index, A)).toBe(OWNER);
    });

  test('an incomplete snapshot that lists the ferret without its title keeps the title the row holds; offers still run', async () => {
    const snapshot = { value: owned() };
    let complete = true;
    const made = world(async () => complete, snapshot);
    await made.index.refresh();
    complete = false;
    snapshot.value = new Map([[`claude-code:${A}`, { ferret: 'ms-12', name: 'Ms-12-renamed' }]]);
    await made.index.refresh();
    expect(rowOf(made.sqlite)).toMatchObject({ ...KEPT, ferret_name: 'Ms-12-renamed' });
  });

  test('once the snapshot is complete again, a ferret that is really gone is cleared (the cleanup still runs)', async () => {
    const snapshot = { value: owned() };
    const made = world(async () => true, snapshot);
    await made.index.refresh();
    snapshot.value = new Map();
    await made.index.refresh();
    expect(rowOf(made.sqlite)).toMatchObject({ ferret_id: null, ferret_title: null, ferret_title_owner: 0 });
  });
});

describe('what the index says when a look or an offer fails (r11 S11 CI coverage)', () => {
  const build = (extra: Partial<ConstructorParameters<typeof ConversationIndex>[0]>) => {
    const owner = new MemoryHistory();
    const warnings: string[] = [];
    const source: IndexSource = {
      harness: 'claude-code',
      parser: 'claude',
      kind: 'computer',
      label: 'owner',
      files: owner,
    };
    const index = new ConversationIndex({
      sqlite: () => memorySqlite(),
      sources: async () => [source],
      ferretNames: async () => ferretOf({ titleSource: 'auto' }),
      parsers: PARSERS,
      nowMs: () => 0,
      warn: message => void warnings.push(message),
      ...extra,
    });
    return { index, owner, warnings };
  };

  test('a scoped look that cannot list its sources is said once and never rejects', async () => {
    const { index, warnings } = build({ sources: async () => Promise.reject(new Error('no tree')) });
    await expect(index.refreshConversations(new Set([`claude-code:${A}`]))).resolves.toBeUndefined();
    expect(warnings).toEqual(['The conversation index could not be updated: no tree']);
  });

  test('a scoped look that fails with something that is not an Error says what it was', async () => {
    const { index, warnings } = build({ sources: async () => Promise.reject('plain text') });
    await index.refreshConversations(new Set([`claude-code:${A}`]));
    expect(warnings).toEqual(['The conversation index could not be updated: plain text']);
  });

  test('a ferret that refuses the offered title is warned about, and the offer is made again at the next update', async () => {
    const attempts: string[] = [];
    const { index, owner, warnings } = build({
      adoptTitle: async (ferret, title) => {
        attempts.push(`${ferret}:${title}`);
        return Promise.reject(new Error('ferret is busy'));
      },
    });
    owner.set(pathOf(A), talk('hello') + rec({ type: 'ai-title', aiTitle: 'Fix flaky login test' }));
    await index.refresh();
    expect(attempts).toEqual(['ms-12:Fix flaky login test']);
    expect(warnings).toEqual(["A conversation's title could not be offered to its ferret: ferret is busy"]);
    // A refused offer is forgotten, so the same title is offered again rather than silently dropped.
    owner.append(pathOf(A), talk('and one more thing', '2026-02-01T09:30:00.000Z'));
    await index.refresh();
    expect(attempts).toEqual(['ms-12:Fix flaky login test', 'ms-12:Fix flaky login test']);
  });
});

describe('an upgrade recomputes the fallback titles of the conversations already indexed, and only those', () => {
  const OLD_FALLBACK = 'Look at Why the Deploy';
  const NEW_FALLBACK = 'Deploy Script Keeps Failing';
  const FIRST = 'Look at why the deploy script keeps failing on every push to main';

  /** A cache an earlier build wrote: the rows as they stood, the title rule it knew not yet stamped, a fallback title it made. */
  const upgraded = async (
    options: { readonly names?: () => FerretConversationNames; readonly transcript?: string } = {},
  ) => {
    const sqlite = memorySqlite();
    const owner = new MemoryHistory();
    const make = () =>
      new ConversationIndex({
        sqlite: () => sqlite,
        sources: async () => [
          { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: owner },
        ],
        ferretNames: async () => options.names?.() ?? new Map(),
        parsers: PARSERS,
        nowMs: () => 0,
        scrubbing: vault(VALUES),
      });
    owner.set(pathOf(A), talk(FIRST) + (options.transcript ?? ''));
    await make().refresh();
    sqlite.database.run("DELETE FROM meta WHERE k = 'title_rule'");
    sqlite.database.run('UPDATE conv SET file_title = ?, title = CASE WHEN index_title IS NULL THEN ? ELSE title END', [
      OLD_FALLBACK,
      OLD_FALLBACK,
    ]);
    return { sqlite, owner, fresh: make };
  };

  test('a row holding the old fallback title shows the new one after one refresh, and the next refresh reads nothing', async () => {
    const { owner, fresh, sqlite } = await upgraded();
    const index = fresh();
    await index.refresh();
    expect(index.query().conversations[0]?.row.title).toBe(NEW_FALLBACK);
    expect(sqlite.database.query('SELECT file_title FROM conv').all()).toEqual([{ file_title: NEW_FALLBACK }]);
    const read = owner.bytesRead;
    await index.refresh();
    expect(owner.bytesRead).toBe(read);
  });

  test('an append after the upgrade does not carry the old fallback title forward', async () => {
    const { owner, fresh } = await upgraded();
    owner.append(pathOf(A), talk('and then tidy the logs', '2026-02-01T09:30:00.000Z'));
    const index = fresh();
    await index.refresh();
    expect(index.query().conversations[0]?.row.title).toBe(NEW_FALLBACK);
  });

  test('a title the harness wrote (/rename) survives the recompute byte for byte', async () => {
    const written = 'Rotate the staging keys — Q3 (ünï)';
    const { fresh } = await upgraded({ transcript: rec({ type: 'custom-title', customTitle: written }) });
    const index = fresh();
    await index.refresh();
    expect(index.query().conversations[0]?.row.title).toBe(written);
  });

  test("an owner's Rename on the ferret survives the recompute byte for byte", async () => {
    const renamed = 'My own words, here — v2';
    const { fresh, sqlite } = await upgraded({ names: () => ferretOf({ title: renamed, titleSource: 'owner' }) });
    const index = fresh();
    await index.refresh();
    expect(index.query().conversations[0]?.row.title).toBe(renamed);
    expect(sqlite.database.query('SELECT ferret_title, ferret_title_owner FROM conv').all()).toEqual([
      { ferret_title: renamed, ferret_title_owner: 1 },
    ]);
  });
});
