import { describe, it } from 'bun:test';
import should from 'should';
import * as stepUp from '../../src/lib/step-up.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const ORIGIN = 'https://app.ferretry.test';
const CHALLENGE = 'Y2hhbGxlbmdlLWJ5dGVz';
const CREDENTIAL = 'Y3JlZGVudGlhbC1pZA';
const allow = [{ type: 'public-key', id: CREDENTIAL }];

const stepUpCases: SchemaCase[] = [
  { name: 'app origin', schema: stepUp.AppOriginSchema, value: ORIGIN },
  { name: 'options request', schema: stepUp.PasskeyOptionsRequestSchema, value: { origin: ORIGIN } },
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
    name: 'registration',
    schema: stepUp.PasskeyRegistrationSchema,
    value: { credentialId: CREDENTIAL, clientDataJSON: 'e30', attestationObject: 'o2Nm' },
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
      registration: 'stepped-up',
      stepUpUntil: LATER_INSTANT,
    },
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
    ]);
    should(stepUp.STEP_UP_REQUIRED_CODE).equal('grant_step_up_required');
  });
});
