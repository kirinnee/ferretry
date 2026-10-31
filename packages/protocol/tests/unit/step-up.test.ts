import { describe, it } from 'bun:test';
import should from 'should';
import * as stepUp from '../../src/lib/step-up.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const ORIGIN = 'https://app.ferretry.test';
const CHALLENGE = 'Y2hhbGxlbmdlLWJ5dGVz';
const CREDENTIAL = 'Y3JlZGVudGlhbC1pZA';
const allow = [{ type: 'public-key', id: CREDENTIAL }];
const rotation = { deviceKey: 'MCowBQYDK2VwAyEAAAAA', proof: 'c2lnbmF0dXJl' };
const DEVICE_ID = `fy_device_id_${'d'.repeat(22)}`;

const stepUpCases: SchemaCase[] = [
  { name: 'app origin', schema: stepUp.AppOriginSchema, value: ORIGIN },
  { name: 'options request', schema: stepUp.PasskeyOptionsRequestSchema, value: { origin: ORIGIN } },
  { name: 'step-up options request', schema: stepUp.StepUpOptionsRequestSchema, value: { origin: ORIGIN } },
  {
    name: 'step-up options request naming its act',
    schema: stepUp.StepUpOptionsRequestSchema,
    value: { origin: ORIGIN, act: 'catalog-install' },
  },
  { name: 'step-up act', schema: stepUp.StepUpActSchema, value: 'catalog-install' },
  {
    name: 'registration options',
    schema: stepUp.PasskeyRegistrationOptionsSchema,
    value: {
      challenge: CHALLENGE,
      rp: { id: 'app.ferretry.test', name: 'Ferretry' },
      user: { id: 'dXNlcg', name: 'phone', displayName: 'Phone' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 120_000,
      excludeCredentials: [],
    },
  },
  {
    name: 'registration options that ask an existing passkey to confirm first',
    schema: stepUp.PasskeyRegistrationOptionsSchema,
    value: {
      challenge: CHALLENGE,
      rp: { id: 'app.ferretry.test', name: 'Ferretry' },
      user: { id: 'dXNlcg', name: 'phone', displayName: 'Phone' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 120_000,
      excludeCredentials: allow,
      confirm: { challenge: CHALLENGE, rpId: 'app.ferretry.test', allowCredentials: allow, timeout: 120_000 },
    },
  },
  {
    name: 'registration',
    schema: stepUp.PasskeyRegistrationSchema,
    value: { credentialId: CREDENTIAL, clientDataJSON: 'e30', attestationObject: 'o2Nm' },
  },
  {
    name: 'registration confirmed by an existing passkey',
    schema: stepUp.PasskeyRegistrationSchema,
    value: {
      credentialId: CREDENTIAL,
      clientDataJSON: 'e30',
      attestationObject: 'o2Nm',
      confirmation: { credentialId: CREDENTIAL, clientDataJSON: 'e30', authenticatorData: 'YQ', signature: 'c2ln' },
    },
  },
  {
    name: 'step-up options',
    schema: stepUp.StepUpOptionsSchema,
    value: { challenge: CHALLENGE, rpId: 'app.ferretry.test', allowCredentials: allow, timeout: 120_000 },
  },
  {
    name: 'assertion',
    schema: stepUp.StepUpAssertionSchema,
    value: { credentialId: CREDENTIAL, clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'MEUC' },
  },
  { name: 'granted', schema: stepUp.StepUpGrantedSchema, value: { expiresAt: LATER_INSTANT } },
  { name: 'step-up demand', schema: stepUp.StepUpDemandSchema, value: { capability: 'terminal', axis: 'use' } },
  {
    name: 'step-up required body',
    schema: stepUp.StepUpRequiredBodySchema,
    value: {
      error: 'Confirm with your passkey.',
      code: stepUp.STEP_UP_REQUIRED_CODE,
      demand: { capability: 'secrets', axis: 'configure' },
    },
  },
  {
    name: 'granted with a rotated key',
    schema: stepUp.StepUpGrantedSchema,
    value: { expiresAt: LATER_INSTANT, keyRotated: true },
  },
  { name: 'device key rotation', schema: stepUp.DeviceKeyRotationSchema, value: rotation },
  {
    name: 'assertion carrying a rotation',
    schema: stepUp.StepUpAssertionSchema,
    value: { credentialId: CREDENTIAL, clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'MEUC', rotation },
  },
  {
    name: 'passkey view',
    schema: stepUp.PasskeyViewSchema,
    value: { id: CREDENTIAL, origin: ORIGIN, createdAt: INSTANT },
  },
  {
    name: 'passkeys view',
    schema: stepUp.PasskeysViewSchema,
    value: {
      passkeys: [{ id: CREDENTIAL, origin: ORIGIN, createdAt: INSTANT }],
      registration: 'confirm-existing',
      stepUpUntil: LATER_INSTANT,
    },
  },
  { name: 'window request', schema: stepUp.PasskeyWindowRequestSchema, value: { deviceId: DEVICE_ID } },
  {
    name: 'window opened',
    schema: stepUp.PasskeyWindowOpenedSchema,
    value: { deviceId: DEVICE_ID, deviceName: 'Pixel 8', closesAt: LATER_INSTANT },
  },
];

describe('the passkey step-up wire', () => {
  it('should round-trip every record and cover every exported schema', () => {
    assertRoundTrips(stepUpCases);
    assertCoversEverySchema(stepUp, stepUpCases);
  });

  it('should refuse an origin that is not one, or that carries anything after the port', () => {
    // A relying-party id is derived from this value, so a path, a trailing slash or a string the URL
    // parser cannot read must never pass for an origin.
    assertRejects([
      { name: 'not a URL', schema: stepUp.AppOriginSchema, value: 'not a url' },
      { name: 'a path after the origin', schema: stepUp.AppOriginSchema, value: `${ORIGIN}/app` },
      { name: 'a trailing slash', schema: stepUp.AppOriginSchema, value: `${ORIGIN}/` },
      {
        name: 'padded base64url',
        schema: stepUp.PasskeyRegistrationSchema,
        value: { credentialId: 'YQ==', clientDataJSON: 'e30', attestationObject: 'o2Nm' },
      },
      {
        name: 'a step-up with no allowed credential',
        schema: stepUp.StepUpOptionsSchema,
        value: { challenge: CHALLENGE, rpId: 'x', allowCredentials: [], timeout: 1 },
      },
      {
        name: 'an unknown registration posture',
        schema: stepUp.PasskeysViewSchema,
        value: { passkeys: [], registration: 'open' },
      },
      {
        name: 'a rotation with no proof',
        schema: stepUp.DeviceKeyRotationSchema,
        value: { deviceKey: rotation.deviceKey },
      },
      { name: 'a rotation with no key', schema: stepUp.DeviceKeyRotationSchema, value: { proof: rotation.proof } },
      {
        name: 'a rotation with padded base64',
        schema: stepUp.DeviceKeyRotationSchema,
        value: { deviceKey: 'YQ==', proof: rotation.proof },
      },
      {
        name: 'a rotation with an oversized key',
        schema: stepUp.DeviceKeyRotationSchema,
        value: { deviceKey: 'A'.repeat(65), proof: rotation.proof },
      },
      {
        name: 'a rotation with an oversized proof',
        schema: stepUp.DeviceKeyRotationSchema,
        value: { deviceKey: rotation.deviceKey, proof: 'A'.repeat(129) },
      },
      {
        name: 'keyRotated set to false',
        schema: stepUp.StepUpGrantedSchema,
        value: { expiresAt: LATER_INSTANT, keyRotated: false },
      },
      // A held step-up no longer opens registration (review M3), so its posture is gone for good.
      {
        name: 'the retired stepped-up posture',
        schema: stepUp.PasskeysViewSchema,
        value: { passkeys: [], registration: 'stepped-up' },
      },
      // A browser is never the owner (B4), so the posture that said "you are the host" is gone for good.
      {
        name: 'the retired host posture',
        schema: stepUp.PasskeysViewSchema,
        value: { passkeys: [], registration: 'host' },
      },
      {
        name: 'a window for something that is not a device id',
        schema: stepUp.PasskeyWindowRequestSchema,
        value: { deviceId: 'phone' },
      },
      {
        name: 'a demand naming a capability this protocol does not have',
        schema: stepUp.StepUpDemandSchema,
        value: { capability: 'root', axis: 'use' },
      },
      {
        name: 'a demand carrying anything beyond the closed pair',
        schema: stepUp.StepUpDemandSchema,
        value: { capability: 'terminal', axis: 'use', path: '/etc/passwd' },
      },
      {
        name: 'a step-up body with no demand',
        schema: stepUp.StepUpRequiredBodySchema,
        value: { error: 'Confirm.', code: stepUp.STEP_UP_REQUIRED_CODE },
      },
      {
        name: 'a demand body under another code',
        schema: stepUp.StepUpRequiredBodySchema,
        value: { error: 'No.', code: 'grant_not_granted', demand: { capability: 'fleet', axis: 'use' } },
      },
      {
        name: 'a window answer with no name',
        schema: stepUp.PasskeyWindowOpenedSchema,
        value: { deviceId: DEVICE_ID, deviceName: '', closesAt: LATER_INSTANT },
      },
    ]);
  });

  it('should accept every act a step-up can be proved for, loosening a configuration file included', () => {
    // Arrange
    const acts = Object.values(stepUp.STEP_UP_ACTS);

    // Act
    const actual = acts.map(
      act => stepUp.StepUpDemandSchema.safeParse({ capability: 'fleet', axis: 'configure', act }).success,
    );

    // Assert
    should(acts).containEql('loosen-config');
    should(stepUp.STEP_UP_ACTS.loosenConfig).equal('loosen-config');
    should(stepUp.STEP_UP_ACTS.cloneSecrets).equal('clone-secrets');
    should(stepUp.STEP_UP_ACTS.loosenSecurity).equal('loosen-security');
    should(actual).deepEqual(acts.map(() => true));
    should(
      stepUp.StepUpDemandSchema.safeParse({ capability: 'fleet', axis: 'configure', act: 'loosen-everything' }).success,
    ).be.false();
  });

  it('should refuse a step-up options request naming an act that does not exist', () => {
    assertRejects([
      {
        name: 'an unknown act',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'loosen-everything' },
      },
    ]);
  });

  it('should spell a refusal code per reason, and the grant refusal the way the grant layer does', () => {
    should(stepUp.STEP_UP_REFUSALS.map(stepUp.stepUpRefusalCode)).deepEqual([
      'step_up_not_a_device',
      'step_up_origin_not_allowed',
      'step_up_registration_closed',
      'step_up_too_many_passkeys',
      'step_up_no_passkey',
      'step_up_not_verified',
      'step_up_rotation_required',
      'step_up_not_at_machine',
      'step_up_unknown_device',
    ]);
    should(stepUp.STEP_UP_REQUIRED_CODE).equal('grant_step_up_required');
  });
});
