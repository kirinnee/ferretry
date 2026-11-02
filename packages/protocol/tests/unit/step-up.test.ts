import { describe, it } from 'bun:test';
import should from 'should';
import { SignInRuleStageIdSchema } from '../../src/lib/account-ids.ts';
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
    name: 'stored proof',
    schema: stepUp.StoredStepUpProofSchema,
    value: {
      deviceId: DEVICE_ID,
      credentialId: CREDENTIAL,
      clientDataJSON: 'e30',
      authenticatorData: 'AAAA',
      signature: 'MEUC',
    },
  },
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

  it('should bind an add-2fa-key step-up to the one staged seed, and no other act to anything', () => {
    // Arrange
    const stage = `st_${'a'.repeat(24)}`;

    // Act / Assert — the act every caller is asked, the machine included, and the stage its proof is bound to
    should(stepUp.STEP_UP_ACTS.addTwoFactorKey).equal('add-2fa-key');
    should(stepUp.STEP_UP_ACTS_EVERY_CALLER).deepEqual([
      'add-2fa-key',
      'approve-task-plan',
      'approve-sign-in-rule',
      'approve-paste-rule',
    ]);
    // Every other act is one the machine itself is never asked to prove; these, every caller is.
    should(stepUp.StepUpActSchema.options.filter(act => !stepUp.stepUpSkippableAtMachine(act))).deepEqual([
      'add-2fa-key',
      'approve-task-plan',
      'approve-sign-in-rule',
      'approve-paste-rule',
    ]);
    should(
      stepUp.StepUpOptionsRequestSchema.safeParse({ origin: ORIGIN, act: 'add-2fa-key', subject: stage }).success,
    ).be.true();
    assertRejects([
      {
        name: 'adding a 2FA key with no stage',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'add-2fa-key' },
      },
      {
        name: 'a stage on another act',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'catalog-install', subject: stage },
      },
      {
        name: 'a stage with no act',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, subject: stage },
      },
      {
        name: 'a stage that is not one',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'add-2fa-key', subject: 'tf_000000000001' },
      },
    ]);
  });

  it('should bind an approve-paste-rule step-up to one staged paste rule, never to another kind of stage (!A244)', () => {
    const stage = `prs_${'a'.repeat(24)}`;

    should(stepUp.STEP_UP_ACTS.approvePasteRule).equal('approve-paste-rule');
    should(stepUp.stepUpKeepsProof('approve-paste-rule')).be.false();
    should(
      stepUp.StepUpOptionsRequestSchema.safeParse({ origin: ORIGIN, act: 'approve-paste-rule', subject: stage })
        .success,
    ).be.true();
    assertRejects([
      {
        name: 'a paste rule with no stage',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-paste-rule' },
      },
      {
        name: "a task plan's stage for a paste rule",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-paste-rule', subject: `tps_${'a'.repeat(24)}` },
      },
      {
        name: "a paste rule's stage for a task plan",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-task-plan', subject: stage },
      },
    ]);
  });

  it('should bind an approve-task-plan step-up to one staged selection, never to a 2FA stage', () => {
    // Arrange
    const planStage = `tps_${'b'.repeat(24)}`;
    const seedStage = `st_${'a'.repeat(24)}`;

    // Act / Assert — asked of every caller, the machine included, like saving a 2FA key
    should(stepUp.STEP_UP_ACTS.approveTaskPlan).equal('approve-task-plan');
    should(stepUp.stepUpSkippableAtMachine('approve-task-plan')).be.false();
    should(
      stepUp.StepUpOptionsRequestSchema.safeParse({ origin: ORIGIN, act: 'approve-task-plan', subject: planStage })
        .success,
    ).be.true();
    assertRejects([
      {
        name: 'approving a plan with no stage',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-task-plan' },
      },
      {
        name: "a 2FA seed's stage on a plan approval",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-task-plan', subject: seedStage },
      },
      {
        name: "a plan's stage on a 2FA save",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'add-2fa-key', subject: planStage },
      },
      {
        name: "a plan's stage on an act the machine may skip",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'loosen-config', subject: planStage },
      },
      {
        name: "a plan's stage with no act",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, subject: planStage },
      },
      {
        name: 'a plan stage that is not one',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-task-plan', subject: `tps_${'b'.repeat(23)}` },
      },
    ]);
    // Each bound act names the one kind of stage it is bound to.
    should(Object.keys(stepUp.STEP_UP_SUBJECTS).sort()).deepEqual([...stepUp.STEP_UP_ACTS_EVERY_CALLER].sort());
  });

  it('should bind an approve-sign-in-rule step-up to one staged rule, and to no other kind of stage', () => {
    // Arrange
    const ruleStage = `srs_${'c'.repeat(24)}`;
    const planStage = `tps_${'b'.repeat(24)}`;
    const seedStage = `st_${'a'.repeat(24)}`;

    // Act / Assert — asked of every caller, the machine included, and bound to exactly an srs_ stage
    should(stepUp.STEP_UP_ACTS.approveSignInRule).equal('approve-sign-in-rule');
    should(stepUp.stepUpSkippableAtMachine('approve-sign-in-rule')).be.false();
    should(
      stepUp.StepUpOptionsRequestSchema.safeParse({ origin: ORIGIN, act: 'approve-sign-in-rule', subject: ruleStage })
        .success,
    ).be.true();
    assertRejects([
      {
        name: 'approving a rule with no stage',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-sign-in-rule' },
      },
      {
        name: "a plan's stage on a rule approval",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-sign-in-rule', subject: planStage },
      },
      {
        name: "a 2FA seed's stage on a rule approval",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-sign-in-rule', subject: seedStage },
      },
      {
        name: "a rule's stage on a plan approval",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-task-plan', subject: ruleStage },
      },
      {
        name: "a rule's stage on a 2FA save",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'add-2fa-key', subject: ruleStage },
      },
      {
        name: "a rule's stage on an act the machine may skip",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'loosen-config', subject: ruleStage },
      },
      {
        name: "a rule's stage with no act",
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, subject: ruleStage },
      },
      {
        name: 'a rule stage that is not one',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-sign-in-rule', subject: `srs_${'c'.repeat(23)}` },
      },
      {
        name: 'a rule id where its stage belongs',
        schema: stepUp.StepUpOptionsRequestSchema,
        value: { origin: ORIGIN, act: 'approve-sign-in-rule', subject: `sr_${'c'.repeat(24)}` },
      },
    ]);
  });

  it('should keep the proof of a standing rule only, and only for an act every caller is asked', () => {
    // Act / Assert — the daemon derives these acts' challenges and stores their assertions; no other act is kept
    should(stepUp.STEP_UP_ACTS_STORED_PROOF).deepEqual(['approve-sign-in-rule']);
    should(stepUp.StepUpActSchema.options.filter(stepUp.stepUpKeepsProof)).deepEqual(['approve-sign-in-rule']);
    for (const act of stepUp.STEP_UP_ACTS_STORED_PROOF) should(stepUp.stepUpSkippableAtMachine(act)).be.false();
    assertRejects([
      {
        name: 'a stored proof from something that is not a paired device',
        schema: stepUp.StoredStepUpProofSchema,
        value: {
          deviceId: 'host',
          credentialId: CREDENTIAL,
          clientDataJSON: 'e30',
          authenticatorData: 'AAAA',
          signature: 'MEUC',
        },
      },
      {
        name: 'a stored proof carrying a key rotation',
        schema: stepUp.StoredStepUpProofSchema,
        value: {
          deviceId: DEVICE_ID,
          credentialId: CREDENTIAL,
          clientDataJSON: 'e30',
          authenticatorData: 'AAAA',
          signature: 'MEUC',
          rotation,
        },
      },
    ]);
  });

  it('should let a stored proof be claimed only for a stored-proof act and its own subject (type test)', () => {
    // Arrange — a claim that hands back nothing: only its TYPE is under test
    const claim: stepUp.ClaimStoredProof = () => undefined;
    const ruleStage = SignInRuleStageIdSchema.parse(`srs_${'c'.repeat(24)}`);
    const planStage: string = `tps_${'b'.repeat(24)}`;

    // Act / Assert
    should(claim('approve-sign-in-rule', ruleStage)).be.undefined();
    should(claim('approve-sign-in-rule', 'srs_cccccccccccccccccccccccc')).be.undefined();
    // @ts-expect-error — the subject is typed as a rule's stage: another act's stage does not compile
    should(claim('approve-sign-in-rule', 'tps_bbbbbbbbbbbbbbbbbbbbbbbb')).be.undefined();
    // @ts-expect-error — nor does a string nobody parsed as one
    should(claim('approve-sign-in-rule', planStage)).be.undefined();
    // @ts-expect-error — a task plan's proof is never stored, so it can't be claimed as one
    should(claim('approve-task-plan', `tps_${'b'.repeat(24)}`)).be.undefined();
    // @ts-expect-error — nor a 2FA seed's
    should(claim('add-2fa-key', `st_${'a'.repeat(24)}`)).be.undefined();
    // @ts-expect-error — nor an ordinary act's
    should(claim('catalog-install', ruleStage)).be.undefined();
    // @ts-expect-error — a stored proof is always claimed for its one subject
    should(claim('approve-sign-in-rule')).be.undefined();
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
