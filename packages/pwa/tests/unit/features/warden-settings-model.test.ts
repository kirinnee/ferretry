import { describe, expect, it } from 'bun:test';
import type { WardenConfig, WardenConfigView } from '@ferretry/protocol';
import {
  hasWardenFormErrors,
  movedAccount,
  WARDEN_EFFORTS,
  WARDEN_FORM_LIMITS,
  wardenConfigPatchFrom,
  wardenEfforts,
  wardenFormErrors,
  wardenMachineDefaultLogin,
  wardenSummary,
  withLogin,
} from '../../../src/features/warden/warden-settings-model.ts';
import type { PickerAccount } from '../../../src/lib/account-picker-catalog.ts';
import { wardenConfig } from '../../support/warden.ts';

/** Both layers: Jev in front of an investigation. */
const jev = (overrides: Partial<WardenConfig> = {}): WardenConfig =>
  wardenConfig({ layers: { jev: true, llm: true }, ...overrides });
const jevOnly = (overrides: Partial<WardenConfig> = {}): WardenConfig =>
  wardenConfig({ layers: { jev: true, llm: false }, ...overrides });
const llm = (overrides: Partial<WardenConfig> = {}): WardenConfig =>
  wardenConfig({ layers: { jev: false, llm: true }, ...overrides });

describe('wardenFormErrors', () => {
  it('should check nothing with both layers off, which spends nothing', () => {
    // Arrange
    const config = wardenConfig({
      caps: { jevUsdPerDay: Number.NaN, investigationUsdPerDay: 0, maxInvestigationsPerHour: 0 },
    });

    // Act
    const errors = wardenFormErrors(config);

    // Assert
    expect(errors).toEqual({});
    expect(hasWardenFormErrors(errors)).toBe(false);
  });

  it('should name every out-of-range entry with both layers on', () => {
    // Arrange
    const config = jev({
      caps: { jevUsdPerDay: 0, investigationUsdPerDay: 101, maxInvestigationsPerHour: 1.5 },
      maxAssignedWardens: 5,
      blessMinutes: Number.NaN,
    });

    // Act
    const errors = wardenFormErrors(config);

    // Assert
    expect(errors).toEqual({
      jevUsdPerDay: 'Enter a cap between $0.01 and $100.',
      investigationUsdPerDay: 'Enter a cap between $0.01 and $100.',
      maxInvestigationsPerHour: '1 to 60.',
      maxAssignedWardens: '1 to 4.',
      blessMinutes: '1 to 240 minutes.',
    });
    expect(hasWardenFormErrors(errors)).toBe(true);
  });

  it('should check only Jev’s own cap and the cooldown with Jev alone', () => {
    // Arrange
    const config = jevOnly({
      caps: { jevUsdPerDay: 0, investigationUsdPerDay: 101, maxInvestigationsPerHour: 0 },
      maxAssignedWardens: 9,
      blessMinutes: 0,
    });

    // Act / Assert
    expect(wardenFormErrors(config)).toEqual({
      jevUsdPerDay: 'Enter a cap between $0.01 and $100.',
      blessMinutes: '1 to 240 minutes.',
    });
  });

  it('should ignore the hidden Jev cap with the LLM alone, and accept the limits themselves', () => {
    // Arrange
    const config = llm({
      caps: {
        jevUsdPerDay: Number.NaN,
        investigationUsdPerDay: WARDEN_FORM_LIMITS.capUsd.max,
        maxInvestigationsPerHour: WARDEN_FORM_LIMITS.perHour.min,
      },
      maxAssignedWardens: WARDEN_FORM_LIMITS.atATime.max,
      blessMinutes: WARDEN_FORM_LIMITS.blessMinutes.max,
    });

    // Act / Assert
    expect(wardenFormErrors(config)).toEqual({});
  });
});

describe('wardenSummary', () => {
  it('should say the Warden is off', () => {
    // Arrange / Act / Assert
    expect(wardenSummary(wardenConfig({ enabled: false }), true)).toBe(
      'The Warden is off. Nothing watches your ferrets, and nothing spends money.',
    );
  });

  it('should say rules alone spend nothing', () => {
    // Arrange / Act / Assert
    expect(wardenSummary(wardenConfig({ intervalMinutes: 5 }), false)).toBe(
      'Every 5 min the rules flag anomalies and show them to you. No AI runs and nothing is spent.',
    );
  });

  it('should describe LLM investigations, the cooldown, the cap and what may act alone', () => {
    // Arrange
    const config = llm({
      accounts: [{ agent: 'claude-default', model: 'claude-sonnet-5-5' }, { agent: 'claude-spare' }],
      mayActAlone: { nudge: true, resume: false, restart: false, failover: false, stop: true, closeLeftovers: true },
    });

    // Act
    const summary = wardenSummary(config, false);

    // Assert
    expect(summary).toBe(
      'Every 2 min the rules flag anomalies, and every flag gets a read-only claude-sonnet-5-5 investigation on claude-default (low effort, 1 at a time; failover claude-default → claude-spare), as kteam does. A cleared flag is left alone for 15 min, twice as long each time it is cleared again, up to 4 h. Cap: $2.00/day. When an investigation’s verdict says so, it may nudge and stop on its own.',
    );
  });

  it('should say the logins take turns when they rotate', () => {
    // Arrange
    const config = llm({
      accounts: [{ agent: 'claude-a' }, { agent: 'codex-b' }],
      failover: { policy: 'round_robin', failureThreshold: 2, cooldownMinutes: 30 },
    });

    // Act / Assert
    expect(wardenSummary(config, true)).toContain('(low effort, 1 at a time; taking turns claude-a → codex-b)');
  });

  it('should say every verdict waits when nothing may act alone', () => {
    // Arrange
    const config = llm({
      mayActAlone: { nudge: false, resume: false, restart: false, failover: false, stop: false, closeLeftovers: true },
    });

    // Act / Assert
    expect(wardenSummary(config, true)).toContain('Every verdict waits for you; stopping always asks you first.');
  });

  it('should describe Jev in front of the investigation, its threshold and both caps', () => {
    // Arrange
    const config = jev();

    // Act
    const summary = wardenSummary(config, true);

    // Assert
    expect(summary).toBe(
      'Every 2 min the rules flag anomalies. Jev clears a flag it is at least 85% sure is healthy; anything else, including when it is unsure, goes to a read-only investigation on claude-default (low effort, 1 at a time). A cleared flag is left alone for 15 min, twice as long each time it is cleared again, up to 4 h. Caps: $0.50/day for Jev and $2.00/day for investigations. When an investigation’s verdict says so, it may nudge, resume or revive, restart a dead or frozen process and fail over to the next login on its own; stopping always asks you first.',
    );
  });

  it('should describe Jev alone: what it does not clear is shown to you', () => {
    // Act
    const summary = wardenSummary(jevOnly(), true);

    // Assert
    expect(summary).toBe(
      'Every 2 min the rules flag anomalies. Jev clears a flag it is at least 85% sure is healthy; every other flag is shown to you, and no investigation runs. A cleared flag is left alone for 15 min, twice as long each time it is cleared again, up to 4 h. Cap: $0.50/day for Jev.',
    );
    expect(wardenSummary(jevOnly(), false)).toContain(
      'Needs a Jev key: until one is added, every flag is shown to you.',
    );
  });

  it('should say a missing key sends every flag to investigation, and (fix) for bad entries', () => {
    // Arrange
    const config = jev({
      caps: { jevUsdPerDay: Number.NaN, investigationUsdPerDay: 0, maxInvestigationsPerHour: 6 },
      maxAssignedWardens: 9,
      blessMinutes: 0,
      accounts: [],
    });

    // Act
    const summary = wardenSummary(config, false);

    // Assert
    expect(summary).toContain('left alone for (fix)');
    expect(summary).toContain('investigation on no login (low effort, (fix) at a time)');
    expect(summary).toContain('Caps: (fix)/day for Jev and (fix)/day for investigations.');
    expect(summary.endsWith(' Needs a Jev key: until one is added, every flag is investigated.')).toBe(true);
  });
});

describe('the machine default login', () => {
  it('should name the default runtime only when the daemon stood it in', () => {
    // Arrange
    const standIn: Pick<WardenConfigView, 'accounts' | 'login'> = {
      accounts: [{ agent: 'claude-default' }],
      login: { source: 'machine_default', unknown: [], available: [] },
    };
    const chosen: Pick<WardenConfigView, 'accounts' | 'login'> = {
      accounts: [{ agent: 'claude-spare' }],
      login: { source: 'configured', unknown: [], available: [] },
    };

    // Act / Assert
    expect(wardenMachineDefaultLogin(standIn)).toBe('claude-default');
    expect(wardenMachineDefaultLogin(chosen)).toBeUndefined();
    expect(wardenMachineDefaultLogin({ accounts: [] })).toBeUndefined();
  });

  it('should summarise an empty order as running on the machine default', () => {
    // Act
    const summary = wardenSummary(llm({ accounts: [] }), true, 'claude-default');

    // Assert
    expect(summary).toContain('investigation on claude-default (low effort, 1 at a time)');
  });
});

describe('wardenConfigPatchFrom', () => {
  it('should carry only what changed, and only the changed keys of a section', () => {
    // Arrange
    const base = wardenConfig({ layers: { jev: false, llm: true } });
    const next: WardenConfig = {
      ...base,
      layers: { jev: true, llm: true },
      caps: { ...base.caps, jevUsdPerDay: 1 },
      accounts: [{ agent: 'glm-a' }],
      intervalMinutes: 10,
    };

    // Act
    const patch = wardenConfigPatchFrom(base, next);

    // Assert
    expect(patch).toEqual({
      layers: { jev: true },
      caps: { jevUsdPerDay: 1 },
      accounts: [{ agent: 'glm-a' }],
      intervalMinutes: 10,
    });
    expect(wardenConfigPatchFrom(base, base)).toEqual({});
  });

  it('should never restate the Jev price when the owner moves only the leave bar', () => {
    // Arrange: the price in effect is a stale $2 while the owner's correction waits to be confirmed.
    const base = wardenConfig({ guard: { threshold: 0.85, model: 'jev-latest', usdPerMillionInputTokens: 2 } });
    const next: WardenConfig = { ...base, guard: { ...base.guard, threshold: 0.9 } };

    // Act
    const patch = wardenConfigPatchFrom(base, next);

    // Assert
    expect(patch).toEqual({ guard: { threshold: 0.9 } });
  });
});

describe('failover order helpers', () => {
  it('should move the picked login to the head of the order', () => {
    // Arrange
    const config = wardenConfig({ accounts: [{ agent: 'a' }, { agent: 'b' }, { agent: 'c' }] });

    // Act
    const next = withLogin(config, { agent: 'c', model: 'm' });

    // Assert
    expect(next.accounts).toEqual([{ agent: 'c', model: 'm' }, { agent: 'a' }, { agent: 'b' }]);
  });

  it('should swap neighbours and ignore a move off either end', () => {
    // Arrange
    const config = wardenConfig({ accounts: [{ agent: 'a' }, { agent: 'b' }] });

    // Act / Assert
    expect(movedAccount(config, 0, 1).accounts).toEqual([{ agent: 'b' }, { agent: 'a' }]);
    expect(movedAccount(config, 1, -1).accounts).toEqual([{ agent: 'b' }, { agent: 'a' }]);
    expect(movedAccount(config, 0, -1)).toBe(config);
    expect(movedAccount(config, 1, 1)).toBe(config);
  });
});

describe('wardenEfforts', () => {
  const runtime = (modelCatalog?: PickerAccount['modelCatalog']): PickerAccount => ({
    id: 'rt',
    wrapper: 'claude-glm',
    displayName: 'claude-glm',
    kind: 'claude',
    agent: true,
    credentialId: 'glm',
    defaultModel: 'glm-5.3',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3', available: true, efforts: ['low', 'high', 'max'] },
      { id: 'glm-5.3-flash', available: true, efforts: [] },
    ],
    ...(modelCatalog === undefined ? {} : { modelCatalog }),
    available: true,
    unavailableReason: null,
  });
  const catalog = { id: 'zai', label: 'GLM / Z.ai', customIds: false };

  it("should offer the Warden's levels the model takes, by its catalog", () => {
    expect(wardenEfforts(runtime(catalog), undefined)).toEqual({ efforts: ['low', 'high'], modelName: 'GLM-5.3' });
    expect(wardenEfforts(runtime(catalog), 'glm-5.3-flash')).toEqual({ efforts: [], modelName: 'glm-5.3-flash' });
  });

  it('should offer every level when no catalog says, or the model is one it does not list', () => {
    expect(wardenEfforts(runtime(), 'glm-5.3').efforts).toEqual(WARDEN_EFFORTS);
    expect(wardenEfforts(runtime(catalog), 'custom-model').efforts).toEqual(WARDEN_EFFORTS);
    expect(wardenEfforts(undefined, undefined)).toEqual({ efforts: WARDEN_EFFORTS, modelName: 'This model' });
  });
});
