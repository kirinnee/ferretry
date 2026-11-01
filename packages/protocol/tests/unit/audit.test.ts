import { describe, it } from 'bun:test';
import should from 'should';
import * as audit from '../../src/lib/audit.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const DEVICE_ID = `fy_device_id_${'d'.repeat(22)}`;
const actor = { kind: 'device', deviceId: DEVICE_ID, deviceName: 'Pixel 8' };
const record = {
  at: INSTANT,
  event: 'device.paired',
  actor,
  subject: DEVICE_ID,
  outcome: 'succeeded',
  detail: { carrier: 'relay', count: 2, folded: false },
};

const auditCases: SchemaCase[] = [
  { name: 'event', schema: audit.AuditEventSchema, value: 'step-up.failed' },
  { name: 'actor kind', schema: audit.AuditActorKindSchema, value: 'anonymous' },
  { name: 'actor', schema: audit.AuditActorSchema, value: actor },
  { name: 'outcome', schema: audit.AuditOutcomeSchema, value: 'refused' },
  { name: 'detail', schema: audit.AuditDetailSchema, value: record.detail },
  { name: 'record', schema: audit.AuditRecordSchema, value: record },
  { name: 'query', schema: audit.AuditQuerySchema, value: { limit: 200 } },
  {
    name: 'view',
    schema: audit.AuditViewSchema,
    value: { records: [record], kept: [record], keptTotal: 3, unreadable: 1 },
  },
];

describe('audit schemas', () => {
  it('should round-trip every public audit schema', () => {
    // Arrange / Act / Assert
    assertRoundTrips(auditCases);
    assertCoversEverySchema(audit, auditCases);
  });

  it('should declare the future zero-trust events so later emitters need no schema change', () => {
    // Arrange
    const future = ['device.expired', 'session.opened', 'step-up.succeeded', 'step-up.failed', 'passkey.registered'];

    // Act / Assert
    for (const event of future) should(audit.AuditEventSchema.parse(event)).equal(event);
    should(audit.AUDIT_EVENTS).have.length(53);
    should(audit.AuditEventSchema.parse('security.changed')).equal('security.changed');
    should(audit.AuditEventSchema.parse('device.key-rotated')).equal('device.key-rotated');
    should(audit.AuditEventSchema.parse('session.credential-refused')).equal('session.credential-refused');
    should(audit.AuditEventSchema.parse('session.credential-revoked')).equal('session.credential-revoked');
    for (const event of ['phone-approval.raised', 'phone-approval.refused', 'phone-approval.settled'])
      should(audit.AuditEventSchema.parse(event)).equal(event);
  });

  it('should declare the six sharing events, and keep each of them past rotation', () => {
    // Arrange
    const sharing = [
      'catalog.share.minted',
      'catalog.share.ended',
      'catalog.share.cross-member',
      'catalog.member.revoked',
      'catalog.member.key-removed',
      'catalog.member.catalog-removed',
    ] as const;

    // Act / Assert
    for (const event of sharing) {
      should(audit.AuditEventSchema.parse(event)).equal(event);
      should(audit.AUDIT_EVENTS).containEql(event);
      should(audit.AUDIT_KEPT_EVENTS).containEql(event);
    }
  });

  it('should declare the four member-session events, and keep only the join and the passkey past rotation', () => {
    // Arrange
    const kept = ['catalog.member.joined', 'catalog.member.passkey-added'] as const;
    const general = ['catalog.member.unlocked', 'catalog.member.join-refused'] as const;

    // Act / Assert
    for (const event of [...kept, ...general]) should(audit.AuditEventSchema.parse(event)).equal(event);
    for (const event of kept) should(audit.AUDIT_KEPT_EVENTS).containEql(event);
    for (const event of general) should(audit.AUDIT_KEPT_EVENTS).not.containEql(event);
  });

  it('should only keep events the log can hold, each once', () => {
    // Arrange / Act / Assert
    for (const event of audit.AUDIT_KEPT_EVENTS) should(audit.AUDIT_EVENTS).containEql(event);
    should(new Set(audit.AUDIT_KEPT_EVENTS).size).equal(audit.AUDIT_KEPT_EVENTS.length);
    should(new Set(audit.AUDIT_EVENTS).size).equal(audit.AUDIT_EVENTS.length);
  });

  it('should reserve every fixed actor phrase, whatever its case or spacing', () => {
    // Arrange / Act / Assert
    for (const phrase of audit.AUDIT_RESERVED_ACTOR_PHRASES) should(audit.isReservedActorPhrase(phrase)).be.true();
    should(audit.isReservedActorPhrase('  This   Computer ')).be.true();
    should(audit.isReservedActorPhrase('This computer (mine)')).be.false();
    should(audit.isReservedActorPhrase('Pixel 8')).be.false();
  });

  it('should shorten a device id to its last six characters', () => {
    // Arrange / Act / Assert
    should(audit.auditShortId(DEVICE_ID)).equal('…dddddd');
    should(audit.auditShortId('abc')).equal('abc');
  });

  it('should default the page and coerce a query string', () => {
    // Arrange / Act / Assert
    should(audit.AuditQuerySchema.parse({})).deepEqual({ limit: audit.AUDIT_DEFAULT_LIMIT, keptOffset: 0 });
    should(audit.AuditQuerySchema.parse({ limit: '7', keptOffset: '40' })).deepEqual({ limit: 7, keptOffset: 40 });
  });

  it('should have no room for a command line, a blob or a nested document', () => {
    // Arrange
    const tooManyDetails = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`k${String(index)}`, 1]));
    const cases: SchemaCase[] = [
      { name: 'long subject', schema: audit.AuditRecordSchema, value: { ...record, subject: 'x'.repeat(161) } },
      { name: 'multi-line detail', schema: audit.AuditDetailSchema, value: { argv: 'a\nb' } },
      { name: 'nested detail', schema: audit.AuditDetailSchema, value: { body: { code: 'X' } } },
      { name: 'array detail', schema: audit.AuditDetailSchema, value: { argv: ['rm', '-rf'] } },
      { name: 'odd detail key', schema: audit.AuditDetailSchema, value: { 'Bad-Key': 1 } },
      { name: 'thirteen details', schema: audit.AuditDetailSchema, value: tooManyDetails },
      { name: 'unknown field', schema: audit.AuditRecordSchema, value: { ...record, token: 'fy_device_x' } },
      { name: 'unknown event', schema: audit.AuditEventSchema, value: 'device.stolen' },
      { name: 'empty name', schema: audit.AuditActorSchema, value: { kind: 'device', deviceName: '' } },
      { name: 'limit zero', schema: audit.AuditQuerySchema, value: { limit: 0 } },
      { name: 'limit past 200', schema: audit.AuditQuerySchema, value: { limit: 201 } },
      {
        name: 'negative unreadable',
        schema: audit.AuditViewSchema,
        value: { records: [], kept: [], keptTotal: 0, unreadable: -1 },
      },
      { name: 'negative offset', schema: audit.AuditQuerySchema, value: { keptOffset: -1 } },
    ];

    // Act / Assert
    assertRejects(cases);
  });
});
