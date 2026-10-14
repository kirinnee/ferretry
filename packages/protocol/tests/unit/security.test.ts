import { describe, it } from 'bun:test';
import should from 'should';
import * as security from '../../src/lib/security.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const { DEFAULT_SECURITY_SETTINGS: defaults, SECURITY_SETTING_BOUNDS: bounds } = security;

const view = {
  settings: defaults,
  source: 'document',
  mayWiden: false,
  widenCommand: 'fy daemon security set <field> <value>',
  updatedAt: INSTANT,
};

const securityCases: SchemaCase[] = [
  { name: 'settings', schema: security.SecuritySettingsSchema, value: defaults },
  { name: 'a one-field patch', schema: security.SecuritySettingsPatchSchema, value: { unlockOnOpen: true } },
  { name: 'a settings source', schema: security.SecuritySettingsSourceSchema, value: 'damaged' },
  { name: 'view', schema: security.SecuritySettingsViewSchema, value: view },
  {
    name: 'view without a time',
    schema: security.SecuritySettingsViewSchema,
    value: { ...view, updatedAt: undefined },
  },
  { name: 'change', schema: security.SecuritySettingsChangeSchema, value: { view, devicesExpiring: 2 } },
  { name: 'an unlock granted', schema: security.UnlockGrantedSchema, value: { unlockedUntil: LATER_INSTANT } },
  {
    name: 'an unlock granted with a rotation',
    schema: security.UnlockGrantedSchema,
    value: { unlockedUntil: LATER_INSTANT, keyRotated: true },
  },
];

describe('the security settings wire', () => {
  it('should round-trip every record and cover every exported schema', () => {
    assertRoundTrips(securityCases);
    assertCoversEverySchema(security, securityCases);
  });

  it('should accept each numeric bound at both edges and refuse one past either', () => {
    // A value outside the bounds is refused, never clamped: the sender would otherwise believe
    // something false about the machine.
    for (const [field, { min, max }] of Object.entries(bounds)) {
      for (const value of [min, max])
        should(security.SecuritySettingsPatchSchema.safeParse({ [field]: value }).success).be.true();
      for (const value of [min - 1, max + 1])
        should(security.SecuritySettingsPatchSchema.safeParse({ [field]: value }).success).be.false();
    }
  });

  it('should refuse a fractional value, an unknown field and an empty patch', () => {
    assertRejects([
      { name: 'a fraction', schema: security.SecuritySettingsPatchSchema, value: { idleExpiryDays: 1.5 } },
      { name: 'a string', schema: security.SecuritySettingsPatchSchema, value: { idleExpiryDays: '5' } },
      { name: 'an unknown field', schema: security.SecuritySettingsPatchSchema, value: { retention: 1 } },
      { name: 'an empty patch', schema: security.SecuritySettingsPatchSchema, value: {} },
      { name: 'a partial full document', schema: security.SecuritySettingsSchema, value: { idleExpiryDays: 5 } },
      { name: 'an unknown source', schema: security.SecuritySettingsSourceSchema, value: 'guessed' },
      { name: 'a blank command', schema: security.SecuritySettingsViewSchema, value: { ...view, widenCommand: '' } },
      {
        name: 'a negative expiry count',
        schema: security.SecuritySettingsChangeSchema,
        value: { view, devicesExpiring: -1 },
      },
    ]);
  });

  it('should declare the fields once, each with a default inside its own bounds', () => {
    should([...security.SECURITY_SETTING_FIELDS]).deepEqual([
      'unlockOnOpen',
      'unlockValidityHours',
      'stepUpOnActions',
      'stepUpWindowMinutes',
      'deviceKeyRotationDays',
      'idleExpiryDays',
    ]);
    should([...security.SECURITY_SWITCH_FIELDS]).deepEqual(['unlockOnOpen', 'stepUpOnActions']);
    should(security.DEFAULT_SECURITY_SETTINGS).deepEqual({
      unlockOnOpen: true,
      unlockValidityHours: 8,
      stepUpOnActions: false,
      stepUpWindowMinutes: 15,
      deviceKeyRotationDays: 30,
      idleExpiryDays: 30,
    });
    for (const [field, { min, max }] of Object.entries(bounds)) {
      const value = defaults[field as keyof typeof bounds];
      should(value).be.within(min, max);
    }
  });

  it('should call a larger window or period a loosening, and a smaller or equal one not', () => {
    for (const field of [
      'stepUpWindowMinutes',
      'deviceKeyRotationDays',
      'unlockValidityHours',
      'idleExpiryDays',
    ] as const) {
      should(security.widensSecurity(field, 10, 11)).be.true();
      should(security.widensSecurity(field, 10, 9)).be.false();
      should(security.widensSecurity(field, 10, 10)).be.false();
    }
  });

  it('should call turning the passkey on opening off a loosening, and nothing else about it one', () => {
    should(security.widensSecurity('unlockOnOpen', true, false)).be.true();
    should(security.widensSecurity('unlockOnOpen', false, true)).be.false();
    should(security.widensSecurity('unlockOnOpen', true, true)).be.false();
    should(security.widensSecurity('unlockOnOpen', false, false)).be.false();
  });

  it('should call a confirmation per act inside the unlock a loosening only when it is turned off', () => {
    should(security.widensSecurity('stepUpOnActions', true, false)).be.true();
    should(security.widensSecurity('stepUpOnActions', false, true)).be.false();
    should(security.widensSecurity('stepUpOnActions', true, true)).be.false();
    should(security.widensSecurity('stepUpOnActions', false, false)).be.false();
  });

  it('should tell the two switches from the numbers', () => {
    for (const field of security.SECURITY_SETTING_FIELDS)
      should(security.isSecuritySwitch(field)).equal(field === 'unlockOnOpen' || field === 'stepUpOnActions');
  });

  it('should ask a step-up per act only when the owner asked for it or there is no unlock to cover it', () => {
    const settings = (unlockOnOpen: boolean, stepUpOnActions: boolean) => ({
      ...defaults,
      unlockOnOpen,
      stepUpOnActions,
    });
    should(security.asksStepUpPerAction(settings(true, false))).be.false();
    should(security.asksStepUpPerAction(settings(true, true))).be.true();
    should(security.asksStepUpPerAction(settings(false, false))).be.true();
    should(security.asksStepUpPerAction(settings(false, true))).be.true();
    should(security.asksStepUpPerAction(defaults)).be.false();
  });

  it('should refuse a rotation flag that is not literally true on an unlock', () => {
    assertRejects([
      {
        name: 'a false rotation',
        schema: security.UnlockGrantedSchema,
        value: { unlockedUntil: LATER_INSTANT, keyRotated: false },
      },
      {
        name: 'an unknown field',
        schema: security.UnlockGrantedSchema,
        value: { unlockedUntil: LATER_INSTANT, presence: 1 },
      },
    ]);
  });

  it('should spell the two codes a client branches on', () => {
    should(security.SECURITY_WIDEN_REFUSED_CODE).equal('security_widen_at_machine');
    should(security.UNLOCK_REQUIRED_CODE).equal('unlock_required');
  });
});
