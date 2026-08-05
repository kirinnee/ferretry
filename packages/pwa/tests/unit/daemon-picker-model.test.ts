import { describe, expect, it } from 'bun:test';
import type { FleetManifestSummary } from '@ferretry/protocol';

import {
  type AccountUsageRow,
  accountHealthLabel,
  accountPickerOptions,
  accountQuotaSummary,
  findAccountOption,
  normalizedModelSelection,
  projectPickerOptions,
  sameHarnessAccountOptions,
} from '../../src/components/daemon-picker-model.ts';
import type { PickerAccountHealth } from '../../src/lib/account-picker-catalog.ts';
import type { FleetProject } from '../../src/lib/fleet-grouping.ts';
import { sessionView } from '../support/sessions.ts';

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '22222222-2222-4222-8222-222222222222';

type Account = FleetManifestSummary['accounts'][number];

const claudeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: CLAUDE_ID,
  kind: 'claude',
  mode: 'auto',
  wrapper: 'claude-auto-atelier',
  home: '/accounts/claude',
  displayName: 'Claude Atelier',
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const codexAccount = (overrides: Partial<Account> = {}): Account => ({
  id: CODEX_ID,
  kind: 'codex',
  mode: 'auto',
  wrapper: 'codex-auto-forge',
  home: '/accounts/codex',
  displayName: 'Codex Forge',
  defaultModel: 'sol',
  models: [{ id: 'sol', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const usageRow = (overrides: Partial<AccountUsageRow> = {}): AccountUsageRow => ({
  agent: 'claude-auto-atelier',
  ...overrides,
});

const healthRow = (overrides: Partial<PickerAccountHealth> = {}): PickerAccountHealth => ({
  accountId: CLAUDE_ID,
  kind: 'claude',
  state: 'healthy',
  cached: false,
  checkedAt: 0,
  ms: 1,
  ...overrides,
});

describe('accountPickerOptions', () => {
  it('joins quota by wrapper and health by account id, and preserves the daemon order', () => {
    const usage = [usageRow({ agent: 'claude-auto-atelier', fiveHourPercent: 21, atLimit: false })];
    const health = new Map([[CLAUDE_ID, healthRow({ state: 'healthy' })]]);

    const options = accountPickerOptions([claudeAccount(), codexAccount()], usage, health);

    expect(options?.map(option => option.wrapper)).toEqual(['claude-auto-atelier', 'codex-auto-forge']);
    expect(options?.[0]?.quota?.fiveHourPercent).toBe(21);
    expect(options?.[0]?.health?.state).toBe('healthy');
    // No live row was ever reported for the codex account: it stays missing, not zero or healthy.
    expect(options?.[1]?.quota).toBeNull();
    expect(options?.[1]?.health).toBeNull();
  });

  it('treats an unreadable roster as null, never as an empty list', () => {
    expect(accountPickerOptions(null, [], null)).toBeNull();
  });

  it('carries the reset timestamps through onto the joined quota row', () => {
    const usage = [usageRow({ fiveHourResetAt: 1_760_000_000, weeklyResetAt: 1_760_600_000 })];

    const options = accountPickerOptions([claudeAccount()], usage, null);

    expect(options?.[0]?.quota?.fiveHourResetAt).toBe(1_760_000_000);
    expect(options?.[0]?.quota?.weeklyResetAt).toBe(1_760_600_000);
  });

  it('treats a positively empty roster as an empty list', () => {
    expect(accountPickerOptions([], [], null)).toEqual([]);
  });

  it('keeps an unavailable account as a disabled option carrying its exact reason', () => {
    const options = accountPickerOptions(
      [claudeAccount({ available: false, unavailableReason: 'wrapper missing', defaultModel: null })],
      [],
      null,
    );

    expect(options).toHaveLength(1);
    expect(options?.[0]?.available).toBeFalse();
    expect(options?.[0]?.unavailableReason).toBe('wrapper missing');
  });

  it('covers display name, harness, wrapper, default model and declared model ids in search text', () => {
    const options = accountPickerOptions(
      [
        claudeAccount({
          displayName: 'Nitroso Studio',
          kind: 'claude',
          wrapper: 'claude-auto-nitroso',
          defaultModel: 'opus-5',
          models: [
            { id: 'opus-5', available: true },
            { id: 'sonnet-5', available: true },
          ],
        }),
      ],
      [],
      null,
    );
    const searchText = options?.[0]?.searchText ?? '';

    for (const needle of ['nitroso studio', 'claude', 'claude-auto-nitroso', 'opus-5', 'sonnet-5']) {
      expect(searchText).toContain(needle);
    }
  });

  it('narrows to one harness for migration without disturbing an unread roster', () => {
    const options = accountPickerOptions([claudeAccount(), codexAccount()], [], null);

    expect(sameHarnessAccountOptions(options, 'codex')?.map(option => option.wrapper)).toEqual(['codex-auto-forge']);
    expect(sameHarnessAccountOptions(null, 'codex')).toBeNull();
  });

  it('finds the option for a chosen wrapper and answers null when unread or absent', () => {
    const options = accountPickerOptions([claudeAccount(), codexAccount()], [], null);

    expect(findAccountOption(options, 'codex-auto-forge')?.id).toBe(CODEX_ID);
    expect(findAccountOption(options, 'codex-auto-missing')).toBeNull();
    expect(findAccountOption(null, 'codex-auto-forge')).toBeNull();
  });
});

describe('accountHealthLabel', () => {
  it('distinguishes healthy, down, and unknown-or-missing', () => {
    expect(accountHealthLabel(healthRow({ state: 'healthy' }))).toBe('healthy');
    expect(accountHealthLabel(healthRow({ state: 'down' }))).toBe('down');
    expect(accountHealthLabel(null)).toBe('unknown');
  });
});

describe('accountQuotaSummary', () => {
  it('keeps a numeric zero reading distinct from missing evidence', () => {
    const summary = accountQuotaSummary(usageRow({ fiveHourPercent: 0, atLimit: false, authOk: true }));

    expect(summary.fiveHourPercent).toBe(0);
    expect(summary.weeklyPercent).toBeNull();
    expect(summary.atLimit).toBeFalse();
    expect(summary.authOk).toBeTrue();
  });

  it('reports every field as missing when there is no row at all', () => {
    expect(accountQuotaSummary(null)).toEqual({
      fiveHourPercent: null,
      weeklyPercent: null,
      atLimit: null,
      authOk: null,
    });
  });
});

describe('normalizedModelSelection', () => {
  it('leaves a blank model blank, without ever consulting an account default', () => {
    expect(normalizedModelSelection('')).toBeNull();
    expect(normalizedModelSelection('   ')).toBeNull();
    expect(normalizedModelSelection('  claude-opus-5[1m]  ')).toBe('claude-opus-5[1m]');
  });
});

describe('projectPickerOptions', () => {
  const project = (overrides: Partial<FleetProject> = {}): FleetProject => ({
    name: 'repo',
    path: '/work/repo',
    ...overrides,
  });

  it('normalizes a trailing slash on a registered project path', () => {
    const catalog = projectPickerOptions([project({ path: '/work/repo/' })], []);

    expect(catalog.registered?.[0]?.path).toBe('/work/repo');
    expect(catalog.registered?.[0]?.key).toBe('/work/repo');
  });

  it('offers a canonical registered path once when the registry repeats it', () => {
    const catalog = projectPickerOptions(
      [
        project({ id: 'first', name: 'first', path: '/work/repo/' }),
        project({ id: 'second', name: 'second', path: '/work/repo' }),
      ],
      [],
    );

    expect(catalog.registered).toHaveLength(1);
    expect(catalog.registered?.[0]).toMatchObject({ id: 'first', name: 'first', path: '/work/repo' });
  });

  it('preserves optional registry metadata when the registry carried it, and omits it when it did not', () => {
    const catalog = projectPickerOptions(
      [
        project({
          id: 'project-1',
          source: 'existing-folder',
          createdAt: '2026-08-01T00:00:00.000Z',
          git: { commonDirectory: '/work/repo/.git' },
        }),
        project({ name: 'bare', path: '/work/bare' }),
      ],
      [],
    );

    expect(catalog.registered?.[0]).toMatchObject({
      id: 'project-1',
      source: 'existing-folder',
      createdAt: '2026-08-01T00:00:00.000Z',
      git: { commonDirectory: '/work/repo/.git' },
    });
    expect(Object.hasOwn(catalog.registered?.[1] ?? {}, 'id')).toBeFalse();
    expect(Object.hasOwn(catalog.registered?.[1] ?? {}, 'source')).toBeFalse();
  });

  it('orders recent paths newest first', () => {
    const sessions = [
      sessionView('older', {
        config: { cwd: '/work/older', updatedAt: '2026-08-01T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-01T00:00:00.000Z' },
      }),
      sessionView('newer', {
        config: { cwd: '/work/newer', updatedAt: '2026-08-02T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-02T00:00:00.000Z' },
      }),
    ];

    const catalog = projectPickerOptions([], sessions);

    expect(catalog.recent?.map(option => option.path)).toEqual(['/work/newer', '/work/older']);
  });

  it('folds a recent path that equals or is nested under the longest matching registered root', () => {
    const projects = [
      project({ name: 'repo', path: '/work/repo' }),
      project({ name: 'nested', path: '/work/repo/nested' }),
    ];
    const sessions = [
      sessionView('exact', { config: { cwd: '/work/repo' } }),
      sessionView('deep', { config: { cwd: '/work/repo/nested/deep' } }),
      sessionView('unrelated', { config: { cwd: '/work/other' } }),
    ];

    const catalog = projectPickerOptions(projects, sessions);

    expect(catalog.recent?.map(option => option.path)).toEqual(['/work/other']);
  });

  it('gives a recent option no id field at all', () => {
    const catalog = projectPickerOptions([], [sessionView('a', { config: { cwd: '/work/a' } })]);

    expect(catalog.recent?.[0]?.kind).toBe('recent');
    expect(Object.hasOwn(catalog.recent?.[0] ?? {}, 'id')).toBeFalse();
  });

  it('keeps recent paths from a positively empty registry', () => {
    const catalog = projectPickerOptions([], [sessionView('a', { config: { cwd: '/work/a' } })]);

    expect(catalog.registered).toEqual([]);
    expect(catalog.recent).toHaveLength(1);
  });

  it('keeps recent paths from an unreadable registry, without describing them as registered', () => {
    const catalog = projectPickerOptions(null, [sessionView('a', { config: { cwd: '/work/a' } })]);

    expect(catalog.registered).toBeNull();
    expect(catalog.recent).toHaveLength(1);
    expect(catalog.recent?.[0]?.kind).toBe('recent');
  });

  it('treats an unread session list as null recent options, regardless of the registry', () => {
    expect(projectPickerOptions([], null).recent).toBeNull();
    expect(projectPickerOptions(null, null).recent).toBeNull();
  });

  it('covers name, path and provenance in search text for both kinds of option', () => {
    const catalog = projectPickerOptions(
      [project({ name: 'Repo', path: '/work/repo', source: 'existing-folder' })],
      [sessionView('a', { config: { cwd: '/work/elsewhere' } })],
    );

    expect(catalog.registered?.[0]?.searchText).toContain('existing-folder');
    expect(catalog.registered?.[0]?.searchText).toContain('/work/repo');
    expect(catalog.recent?.[0]?.searchText).toContain('recent');
    expect(catalog.recent?.[0]?.searchText).toContain('/work/elsewhere');
  });
});
