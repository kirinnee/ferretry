import { describe, expect, it } from 'bun:test';
import type { WardenConfig, WardenConfigView } from '@ferretry/protocol';
import {
  hasWardenFormErrors,
  movedAccount,
  WARDEN_FORM_LIMITS,
  WARDEN_EFFORTS,
  wardenConfigPatchFrom,
  wardenEfforts,
  wardenFormErrors,
  wardenMachineDefaultLogin,
  wardenSummary,
  withLogin,
} from '../../../src/features/warden/warden-settings-model.ts';
import type { PickerAccount } from '../../../src/lib/account-picker-catalog.ts';
import { wardenConfig } from '../../support/warden.ts';

const jev = (overrides: Partial<WardenConfig> = {}): WardenConfig => wardenConfig({ triage: 'jev', ...overrides });

describe('wardenFormErrors', () => {
  it('should check nothing under Rules only, which spends nothing', () => {
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

  it('should name every out-of-range entry under Jev', () => {
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

  it('should ignore the hidden Jev cap under LLM only, and accept the limits themselves', () => {
    // Arrange
    const config = wardenConfig({
      triage: 'llm',
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

  it('should say Rules only spends nothing', () => {
    // Arrange / Act / Assert
    expect(wardenSummary(wardenConfig({ intervalMinutes: 5 }), false)).toBe(
      'Every 5 min the sweep flags anomalies and shows them to you. No AI runs and nothing is spent.',
    );
  });

  it('should describe LLM investigations, the cap and what may act alone', () => {
    // Arrange
    const config = wardenConfig({
      triage: 'llm',
      accounts: [{ agent: 'claude-default', model: 'claude-sonnet-5-5' }, { agent: 'claude-spare' }],
      mayActAlone: { nudge: true, resume: false, failover: false, stop: true },
    });

    // Act
    const summary = wardenSummary(config, false);

    // Assert
    expect(summary).toBe(
      'Every 2 min the sweep flags anomalies, and every flag gets a read-only claude-sonnet-5-5 investigation on claude-default (low effort, 1 at a time; failover claude-default → claude-spare), as kteam does. Cap: $2.00/day. When an investigation’s verdict says so, it may nudge and stop on its own.',
    );
  });

  it('should say every verdict waits when nothing may act alone', () => {
    // Arrange
    const config = wardenConfig({
      triage: 'llm',
      mayActAlone: { nudge: false, resume: false, failover: false, stop: false },
    });

    // Act / Assert
    expect(wardenSummary(config, true)).toContain('Every verdict waits for you; stopping always asks you first.');
  });

  it('should describe the Jev guard, its threshold and both caps', () => {
    // Arrange
    const config = jev();

    // Act
    const summary = wardenSummary(config, true);

    // Assert
    expect(summary).toBe(
      'Every 2 min the sweep flags anomalies. Jev only guards: it skips a flag (healthy, then blesses that anomaly for 15 min) when it is at least 85% sure. Anything else, including when it is unsure, goes to a read-only investigation on claude-default (low effort, 1 at a time; failover claude-default). Caps: $0.50/day for Jev and $2.00/day for investigations. When an investigation’s verdict says so, it may nudge, resume or revive and fail over to the next login on its own; stopping always asks you first.',
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
    expect(summary).toContain('blesses that anomaly for (fix)');
    expect(summary).toContain('investigation on no login (low effort, (fix) at a time; failover no login)');
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
    const summary = wardenSummary(wardenConfig({ triage: 'llm', accounts: [] }), true, 'claude-default');

    // Assert
    expect(summary).toContain('investigation on claude-default (low effort, 1 at a time; failover claude-default)');
  });
});

describe('wardenConfigPatchFrom', () => {
  it('should carry only what changed, a changed section whole', () => {
    // Arrange
    const base = wardenConfig();
    const next: WardenConfig = {
      ...base,
      triage: 'jev',
      caps: { ...base.caps, jevUsdPerDay: 1 },
    };

    // Act
    const patch = wardenConfigPatchFrom(base, next);

    // Assert
    expect(patch).toEqual({ triage: 'jev', caps: { ...base.caps, jevUsdPerDay: 1 } });
    expect(wardenConfigPatchFrom(base, base)).toEqual({});
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
