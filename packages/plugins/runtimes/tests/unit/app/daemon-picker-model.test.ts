import { describe, expect, it } from 'bun:test';
import type { UsageAccountView } from '@ferretry/plugin-usage/contract';
import {
  accountLabel,
  accountPickerOptions,
  findAccountOption,
  firstUsableAccountOption,
  fleetHarnessLabel,
  hintedAccountOption,
  normalizedModelSelection,
  sameHarnessAccountOptions,
  sessionAccountLabel,
} from '../../../app/lib/daemon-picker-model.ts';
import type { PickerAccount } from '../../../app/lib/account-picker-catalog.ts';
import { pickerHealth } from './support/picker.ts';

const CLAUDE_ID = 'rt-claude-auto-atelier';
const CODEX_ID = 'rt-codex-auto-forge';

type Account = PickerAccount;

const claudeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: CLAUDE_ID,
  name: 'claude-atelier',
  kind: 'claude-code',
  credentialId: 'claude-login',
  wrapper: 'claude-auto-atelier',
  displayName: 'Claude Atelier',
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const codexAccount = (overrides: Partial<Account> = {}): Account => ({
  id: CODEX_ID,
  name: 'codex-forge',
  kind: 'codex',
  credentialId: 'codex-login',
  wrapper: 'codex-auto-forge',
  displayName: 'Codex Forge',
  defaultModel: 'sol',
  models: [{ id: 'sol', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const usageRow = (overrides: Partial<UsageAccountView> = {}): UsageAccountView => ({
  agent: 'claude-auto-atelier',
  ...overrides,
});

describe('accountPickerOptions', () => {
  it('joins quota by wrapper and health by the login it uses, and preserves the daemon order', () => {
    const usage = [usageRow({ agent: 'claude-auto-atelier', fiveHourPercent: 21, atLimit: false })];
    const health = new Map([['claude-login', pickerHealth('claude-login')]]);

    const options = accountPickerOptions([claudeAccount(), codexAccount()], usage, health);

    expect(options?.map(option => option.wrapper)).toEqual(['claude-auto-atelier', 'codex-auto-forge']);
    expect(options?.[0]?.quota?.fiveHourPercent).toBe(21);
    expect(options?.[0]?.health?.word).toBe('ready');
    // No live row was ever reported for the codex account: it stays missing, not zero or healthy.
    expect(options?.[1]?.quota).toBeNull();
    expect(options?.[1]?.health).toBeNull();
  });

  it('treats an unreadable roster as null, never as an empty list', () => {
    expect(accountPickerOptions(null, [], null)).toBeNull();
  });

  it('carries the login model catalog onto the option, and none for a login without one', () => {
    const catalog = { id: 'zai', label: 'GLM / Z.ai', customIds: false };
    const [withCatalog, without] =
      accountPickerOptions([{ ...claudeAccount(), modelCatalog: catalog }, codexAccount()], [], null) ?? [];
    expect(withCatalog?.modelCatalog).toEqual(catalog);
    expect(without).not.toHaveProperty('modelCatalog');
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
          kind: 'claude-code',
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

  it('pre-fills the first usable account in the daemon order and nothing when none is usable', () => {
    const down = claudeAccount({ available: false, unavailableReason: 'wrapper missing' });
    const options = accountPickerOptions([down, codexAccount()], [], null);

    expect(firstUsableAccountOption(options)?.wrapper).toBe('codex-auto-forge');
    expect(firstUsableAccountOption(accountPickerOptions([down], [], null))).toBeNull();
    expect(firstUsableAccountOption(null)).toBeNull();
  });

  it('finds the option for a chosen wrapper and answers null when unread or absent', () => {
    const options = accountPickerOptions([claudeAccount(), codexAccount()], [], null);

    expect(findAccountOption(options, 'codex-auto-forge')?.id).toBe(CODEX_ID);
    expect(findAccountOption(options, 'codex-auto-missing')).toBeNull();
    expect(findAccountOption(null, 'codex-auto-forge')).toBeNull();
  });
});

describe('normalizedModelSelection', () => {
  it('leaves a blank model blank, without ever consulting an account default', () => {
    expect(normalizedModelSelection('')).toBeNull();
    expect(normalizedModelSelection('   ')).toBeNull();
    expect(normalizedModelSelection('  claude-opus-5[1m]  ')).toBe('claude-opus-5[1m]');
  });
});

describe('accountLabel', () => {
  it('leads with the fleet’s name and keeps the wrapper id as the second fact', () => {
    expect(accountLabel({ displayName: 'Claude (default, auto)', wrapper: 'claude-auto-default' })).toEqual({
      name: 'Claude (default, auto)',
      id: 'claude-auto-default',
    });
  });

  it('drops the id when the manifest published it as the name', () => {
    expect(accountLabel({ displayName: 'claude-auto-bare', wrapper: 'claude-auto-bare' })).toEqual({
      name: 'claude-auto-bare',
      id: null,
    });
  });
});

describe('sessionAccountLabel', () => {
  it('names a session’s account from the roster by its wrapper', () => {
    expect(sessionAccountLabel([claudeAccount()], 'claude-auto-atelier')).toEqual({
      name: 'Claude Atelier',
      id: 'claude-auto-atelier',
    });
  });

  it('falls back to the id for a wrapper the roster no longer holds', () => {
    expect(sessionAccountLabel([claudeAccount()], 'claude-removed')).toEqual({ name: 'claude-removed', id: null });
  });
});

describe('hintedAccountOption', () => {
  const options = accountPickerOptions(
    [claudeAccount(), codexAccount({ available: false, unavailableReason: 'Sign in to launch' })],
    [],
    null,
  );

  it('honours a launch hint by wrapper or by stored runtime name', () => {
    expect(hintedAccountOption(options, 'claude-auto-atelier')?.id).toBe(CLAUDE_ID);
    expect(hintedAccountOption(options, 'claude-atelier')?.id).toBe(CLAUDE_ID);
  });

  it('never matches the words a person reads, so a label edit or a new twin cannot break or re-aim a link', () => {
    // The words the row shows are display only: a hint spelled like them finds nothing.
    expect(hintedAccountOption(options, 'Claude Atelier')).toBeNull();
    // The stored identities still find the row after its label changes.
    const relabelled = accountPickerOptions(
      [claudeAccount({ displayName: 'Claude · your terminal sign-in — kirin@example.com' })],
      [],
      null,
    );
    expect(hintedAccountOption(relabelled, 'claude-atelier')?.id).toBe(CLAUDE_ID);
    expect(hintedAccountOption(relabelled, 'Claude · your terminal sign-in — kirin@example.com')).toBeNull();
  });

  it('ignores a hint naming a runtime that cannot launch, or none at all', () => {
    expect(hintedAccountOption(options, 'codex-auto-forge')).toBeNull();
    expect(hintedAccountOption(options, 'nobody')).toBeNull();
    expect(hintedAccountOption(options, undefined)).toBeNull();
    expect(hintedAccountOption(null, 'claude-auto-atelier')).toBeNull();
  });
});

describe('fleetHarnessLabel', () => {
  it('names each harness', () => {
    expect(fleetHarnessLabel('claude-code')).toBe('Claude');
    expect(fleetHarnessLabel('codex')).toBe('Codex');
  });
});

describe('the New ferret runtime list: one runtime per ready login (O8-9)', () => {
  const four = ['atomi', 'llm1', 'llm2', 'personal'].map(login =>
    claudeAccount({ id: `rt-${login}`, wrapper: login, displayName: login, credentialId: login }),
  );

  it('offers every runtime a login yields, because no runtime is filtered on an autonomous/interactive property', () => {
    // A runtime the app reads carries no such property any more: the one onboarding made for the owner's single login
    // is offered exactly like any other, and is the one pre-filled.
    const options = accountPickerOptions([claudeAccount({ wrapper: 'claude-default' })], [], new Map());

    expect(options?.map(option => option.wrapper)).toEqual(['claude-default']);
    expect(firstUsableAccountOption(options)?.wrapper).toBe('claude-default');
  });

  it('lists four ready Claude logins as four runtimes, pre-filling the first, then Codex after them', () => {
    const options = accountPickerOptions([...four, codexAccount({ wrapper: 'codex-personal' })], [], new Map());

    expect(options?.map(option => option.wrapper)).toEqual(['atomi', 'llm1', 'llm2', 'personal', 'codex-personal']);
    expect(options?.map(option => option.kind)).toEqual([
      'claude-code',
      'claude-code',
      'claude-code',
      'claude-code',
      'codex',
    ]);
    expect(firstUsableAccountOption(options)?.wrapper).toBe('atomi');
  });

  it('says nothing is startable only when there is truly no ready login', () => {
    expect(firstUsableAccountOption(accountPickerOptions([], [], new Map()))).toBeNull();
  });
});
