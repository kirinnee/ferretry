import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  AccountIndexDocumentSchema,
  type AccountIndexDocument,
  type LoginIndexV1,
  type LoginRecordV1,
  MAX_SIGN_INS_PER_ACCOUNT,
  migratedSignInId,
  migrateLoginIndex,
  placeKeys,
} from '../../src/lib/index.ts';
import { FrozenLoginIndexV1Schema } from '../fixtures/login-index-v1.ts';

const AT = '2026-10-31T09:00:00.000Z';
const NOW = '2026-11-01T00:00:00.000Z';
const KEY = (n: number): string => `L${n.toString(16).toUpperCase().padStart(24, '0')}`;
const SEAL = (n: number, field: 'PASSWORD' | 'TOTP'): string => `${KEY(n)}_${field}_0000000${String(n % 10)}`;
const FLAG = { value: true, observedAt: AT, count: 2 };
const fact = (at: string, surface: 'page' | 'terminal' = 'page') => ({
  at,
  surface,
  identity: '0123456789abcdef',
  since: AT,
  masked: FLAG,
});
const PROPOSAL = {
  id: 'rp_0123456789abcdef',
  recipe: 'Open github.com, then Sign in.',
  why: 'the button moved',
  sessionId: 'mvwxxxhv-11b529cb',
  proposedAt: AT,
};

const record = (n: number, extra: Partial<LoginRecordV1>): LoginRecordV1 => ({
  key: KEY(n),
  label: `Login ${String(n)}`,
  match: [],
  seals: { password: SEAL(n, 'PASSWORD') },
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

/** Every shape a version 1 index holds today, written the way the daemon writes it. */
const V1: LoginIndexV1 = {
  v: 1,
  entries: {
    GITHUB_KIRINNEE: record(1, {
      label: 'GitHub (kirinnee)',
      username: 'kirinnee',
      match: ['github.com', 'gh@kirin-box', 'ssh@build.example.com'],
      domains: ['github.com'],
      seals: { password: SEAL(1, 'PASSWORD'), totp: SEAL(1, 'TOTP') },
      totp: { algorithm: 'SHA1', digits: 6, period: 30 },
      recipe: 'Open github.com/login, type the username, then the password.',
      autoApplyRecipe: true,
      proposals: [PROPOSAL],
      // github.com and gh@kirin-box are places of this entry; elsewhere.example was a hand pick on another page.
      observed: [fact('github.com'), fact('gh@kirin-box', 'terminal'), fact('elsewhere.example')],
    }),
    GOOGLE_KIRIN: record(2, { label: 'Google (kirin)', match: [], domains: ['accounts.google.com'] }),
    VERCEL: record(3, {
      label: 'Vercel',
      match: ['vercel.com'],
      domains: ['accounts.google.com'],
      method: { kind: 'google', via: 'GOOGLE_KIRIN' },
      recipe: 'Continue with Google, then [[GOOGLE_KIRIN]].',
      recipeBy: 'ferret',
    }),
    SUDO_KIRIN_BOX: record(4, { label: 'sudo on kirin-box', match: ['sudo@kirin-box'] }),
    NOTHING_YET: record(5, { label: 'Not for anything yet' }),
    // Saved before login domains existed: it signs in on its web `match` hosts.
    OLD_SITE: record(6, { label: 'Old site', match: ['old.example'] }),
  },
};

const migrated = (v1: LoginIndexV1 = V1, now = NOW) => {
  const result = migrateLoginIndex(v1, { hostName: 'Kirin-Box.local', now });
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const signInsOf = (document: AccountIndexDocument, n: number) =>
  Object.entries(document.signIns).filter(([, signIn]) => signIn.account === KEY(n));

describe('migrating saved logins into accounts and sign-ins', () => {
  it('should start from an index today’s daemon accepts', () => {
    expect(FrozenLoginIndexV1Schema.safeParse(V1).success).toBe(true);
  });

  it('should be a pure function: the same index migrates to the same document every time (invariant 4)', () => {
    // Arrange / Act
    const first = migrated();
    const again = migrated(structuredClone(V1));

    // Assert
    expect(again).toEqual(first);
    expect(JSON.stringify(again.document)).toBe(JSON.stringify(first.document));
  });

  it('should depend on the clock only for when it ran, so a read of an index not yet rewritten names the same ids', () => {
    // Arrange / Act
    const atBoot = migrated(V1, NOW).document;
    const later = migrated(V1, '2026-12-01T00:00:00.000Z').document;

    // Assert
    expect(later.accounts).toEqual(atBoot.accounts);
    expect(later.signIns).toEqual(atBoot.signIns);
    expect(atBoot.migrated).toEqual({ from: 1, at: NOW, entries: 6 });
  });

  it('should derive each sign-in id from the account key and its place, under its own domain separator', () => {
    // Arrange
    const expected = `si_${createHash('sha256')
      .update(`ferretry.signin.v1\0${KEY(4)}\0sudo@kirin-box`)
      .digest('hex')
      .slice(0, 16)}`;

    // Act
    const [[id] = []] = signInsOf(migrated().document, 4);

    // Assert
    expect(migratedSignInId(KEY(4), 'sudo@kirin-box')).toBe(expected);
    expect(id).toBe(expected);
  });

  it('should write a document the version 2 schema accepts, and an older daemon refuses (invariant 7)', () => {
    // Arrange
    const { document } = migrated();
    const bytes = JSON.parse(JSON.stringify(document)) as unknown;

    // Act / Assert — the new reader takes it; the frozen copy of today's reader fails closed on it
    expect(AccountIndexDocumentSchema.safeParse(bytes).success).toBe(true);
    expect(FrozenLoginIndexV1Schema.safeParse(bytes).success).toBe(false);
    expect(FrozenLoginIndexV1Schema.safeParse({ ...(bytes as object), v: 1 }).success).toBe(false);
  });

  it('should keep every account verbatim, sealed names included', () => {
    // Arrange / Act
    const { document } = migrated();

    // Assert
    expect(Object.keys(document.accounts).sort()).toEqual(Object.keys(V1.entries).sort());
    expect(document.accounts.GITHUB_KIRINNEE).toEqual({
      key: KEY(1),
      label: 'GitHub (kirinnee)',
      username: 'kirinnee',
      seals: { password: SEAL(1, 'PASSWORD'), totp: SEAL(1, 'TOTP') },
      totp: { algorithm: 'SHA1', digits: 6, period: 30 },
      createdAt: AT,
      updatedAt: AT,
    });
    const before = Object.values(V1.entries).flatMap(entry => Object.values(entry.seals));
    const after = Object.values(document.accounts).flatMap(account => Object.values(account.seals));
    expect(after.sort()).toEqual(before.sort());
  });

  it('should make one sign-in per place: the site first, then each terminal key', () => {
    // Arrange / Act
    const places = signInsOf(migrated().document, 1).map(([, signIn]) => signIn.place);

    // Assert — ssh keeps its destination, the machine's short name is where the prompt runs
    expect(places).toEqual([
      { kind: 'site', domains: ['github.com'], match: ['github.com'] },
      { kind: 'terminal', tool: 'gh', host: 'kirin-box' },
      { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'build.example.com' },
    ]);
    expect(places.flatMap(place => placeKeys(place))).toEqual(['github.com', 'gh@kirin-box', 'ssh@build.example.com']);
  });

  it('should read an entry from before login domains as signing in on its web match hosts', () => {
    const [[, signIn] = []] = signInsOf(migrated().document, 6);
    expect(signIn?.place).toEqual({ kind: 'site', domains: ['old.example'], match: ['old.example'] });
  });

  it('should give the recipe to every sign-in, but auto-apply and proposals only to the primary', () => {
    // Arrange / Act
    const [primary, ...others] = signInsOf(migrated().document, 1).map(([, signIn]) => signIn);

    // Assert
    expect(primary?.recipe).toBe(V1.entries.GITHUB_KIRINNEE?.recipe);
    expect(primary?.recipeVersion).toBe(1);
    expect(primary?.autoApplyRecipe).toBe(true);
    expect(primary?.proposals).toEqual([PROPOSAL]);
    for (const other of others) {
      expect(other.recipe).toBe(V1.entries.GITHUB_KIRINNEE?.recipe);
      expect(other.recipeVersion).toBe(1);
      expect(other.autoApplyRecipe).toBeUndefined();
      expect(other.proposals).toBeUndefined();
    }
  });

  it('should file each fact under the sign-in for its place, and drop and count one from nowhere of the entry', () => {
    // Arrange / Act
    const { document, report } = migrated();
    const observed = signInsOf(document, 1).map(([, signIn]) => signIn.observed?.map(seen => seen.at));

    // Assert
    expect(observed).toEqual([['github.com'], ['gh@kirin-box'], undefined]);
    expect(report.droppedFacts).toBe(1);
  });

  it('should point via at the provider account by key, and keep who wrote the recipe', () => {
    // Arrange / Act
    const [[, vercel] = []] = signInsOf(migrated().document, 3);

    // Assert
    expect(vercel?.method).toEqual({ kind: 'google', viaKey: KEY(2) });
    expect(vercel?.recipeBy).toBe('ferret');
    expect(vercel?.place).toEqual({ kind: 'site', domains: ['accounts.google.com'], match: ['vercel.com'] });
  });

  it('should keep an entry that is for nothing yet as an account with no sign-ins', () => {
    const { document } = migrated();
    expect(document.accounts.NOTHING_YET).toBeDefined();
    expect(signInsOf(document, 5)).toEqual([]);
  });

  it('should report what it did in counts only', () => {
    expect(migrated().report).toEqual({
      entries: 6,
      accounts: 6,
      signIns: 7,
      droppedFacts: 1,
      droppedPlaces: 0,
      droppedVia: 0,
    });
  });

  it('should drop a via link the new rules refuse, and count it, rather than write a damaged index', () => {
    // Arrange — a provider with no site sign-in, a missing provider, and two logins via each other
    const v1: LoginIndexV1 = {
      v: 1,
      entries: {
        TERMINAL_ONLY: record(1, { match: ['sudo@kirin-box'] }),
        VIA_TERMINAL: record(2, { match: ['a.example'], method: { kind: 'google', via: 'TERMINAL_ONLY' } }),
        VIA_GONE: record(3, { match: ['b.example'], method: { kind: 'github', via: 'GONE' } }),
        ROUND_A: record(4, { match: ['c.example'], method: { kind: 'google', via: 'ROUND_B' } }),
        ROUND_B: record(5, { match: ['d.example'], method: { kind: 'google', via: 'ROUND_A' } }),
      },
    };

    // Act
    const { document, report } = migrated(v1);

    // Assert — the method stays; only the link that cannot hold goes
    expect(report.droppedVia).toBe(3);
    expect(signInsOf(document, 2)[0]?.[1].method).toEqual({ kind: 'google' });
    expect(signInsOf(document, 3)[0]?.[1].method).toEqual({ kind: 'github' });
    expect(signInsOf(document, 4)[0]?.[1].method).toEqual({ kind: 'google', viaKey: KEY(5) });
    expect(signInsOf(document, 5)[0]?.[1].method).toEqual({ kind: 'google' });
  });

  it('should drop and count a match key no target could have, and places past an account’s limit', () => {
    // Arrange
    const terminals = Array.from({ length: 16 }, (_, index) => `tool${String(index)}@kirin-box`);
    const v1: LoginIndexV1 = {
      v: 1,
      entries: {
        HAND_EDITED: record(1, { match: ['Not A Key', 'ok.example'] }),
        MANY: record(2, { match: terminals, domains: ['many.example'] }),
      },
    };

    // Act
    const { document, report } = migrated(v1);

    // Assert
    expect(signInsOf(document, 1).map(([, signIn]) => signIn.place)).toEqual([
      { kind: 'site', domains: ['ok.example'], match: ['ok.example'] },
    ]);
    expect(signInsOf(document, 2)).toHaveLength(MAX_SIGN_INS_PER_ACCOUNT);
    expect(report.droppedPlaces).toBe(2);
  });

  it('should refuse an index whose two handles share one key, so the caller reports the store damaged', () => {
    // Arrange
    const v1: LoginIndexV1 = { v: 1, entries: { ONE: record(1, {}), TWO: record(1, {}) } };

    // Act
    const result = migrateLoginIndex(v1, { hostName: 'kirin-box', now: NOW });

    // Assert
    expect(result.ok).toBe(false);
  });

  it('should name the machine by its short host, and fall back when there is none', () => {
    const v1: LoginIndexV1 = { v: 1, entries: { SSH: record(1, { match: ['ssh@build.example.com'] }) } };
    const named = migrateLoginIndex(v1, { hostName: '', now: NOW });
    expect(named.ok && Object.values(named.value.document.signIns)[0]?.place).toEqual({
      kind: 'terminal',
      tool: 'ssh',
      host: 'localhost',
      dest: 'build.example.com',
    });
  });

  it('should migrate an empty index to an empty one', () => {
    const { document, report } = migrated({ v: 1, entries: {} });
    expect(document).toEqual({ v: 2, accounts: {}, signIns: {}, migrated: { from: 1, at: NOW, entries: 0 } });
    expect(report.signIns).toBe(0);
  });
});
