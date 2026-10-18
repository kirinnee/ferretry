import { describe, it } from 'bun:test';
import should from 'should';
import * as permission from '../../src/lib/session-permission.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const ID = '0123456789abcdef';
const REQUEST: permission.PermissionRequest = {
  id: ID,
  harness: 'claude',
  tool: 'Read',
  action: 'read',
  what: '/etc/hostname',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'Yes, allow reading from /etc during this session', kind: 'allow-always' },
    { number: 3, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

const cases: SchemaCase[] = [
  { name: 'option kind', schema: permission.PermissionOptionKindSchema, value: 'allow-always' },
  { name: 'option', schema: permission.PermissionOptionSchema, value: { number: 2, label: 'No', kind: 'deny' } },
  { name: 'action', schema: permission.PermissionActionSchema, value: 'exit-plan' },
  { name: 'request id', schema: permission.PermissionRequestIdSchema, value: ID },
  { name: 'request', schema: permission.PermissionRequestSchema, value: REQUEST },
  {
    name: 'request with detail',
    schema: permission.PermissionRequestSchema,
    value: { ...REQUEST, harness: 'codex', tool: 'Shell', action: 'run', what: 'rm -rf build', detail: 'Clean' },
  },
  {
    name: 'choice answer',
    schema: permission.PermissionAnswerRequestSchema,
    value: { kind: 'choice', requestId: ID, number: 2 },
  },
  { name: 'deny answer', schema: permission.PermissionAnswerRequestSchema, value: { kind: 'deny', requestId: ID } },
  { name: 'answer result', schema: permission.PermissionAnswerResultSchema, value: { requestId: ID, cleared: true } },
];

const invalid: SchemaCase[] = [
  { name: 'unknown kind', schema: permission.PermissionOptionKindSchema, value: 'maybe' },
  { name: 'option zero', schema: permission.PermissionOptionSchema, value: { number: 0, label: 'No', kind: 'deny' } },
  { name: 'short id', schema: permission.PermissionRequestIdSchema, value: 'abc' },
  { name: 'upper-case id', schema: permission.PermissionRequestIdSchema, value: ID.toUpperCase() },
  {
    name: 'one option',
    schema: permission.PermissionRequestSchema,
    value: { ...REQUEST, options: [REQUEST.options[0]] },
  },
  {
    name: 'options out of order',
    schema: permission.PermissionRequestSchema,
    value: { ...REQUEST, options: [REQUEST.options[1], REQUEST.options[0]] },
  },
  { name: 'selection past the list', schema: permission.PermissionRequestSchema, value: { ...REQUEST, selected: 4 } },
  { name: 'extra field', schema: permission.PermissionRequestSchema, value: { ...REQUEST, extra: true } },
  {
    name: 'choice without a number',
    schema: permission.PermissionAnswerRequestSchema,
    value: { kind: 'choice', requestId: ID },
  },
  {
    name: 'deny with a number',
    schema: permission.PermissionAnswerRequestSchema,
    value: { kind: 'deny', requestId: ID, number: 3 },
  },
];

describe('session permission schemas', () => {
  it('round-trips every valid shape', () => assertRoundTrips(cases));
  it('rejects malformed shapes', () => assertRejects(invalid));
  it('covers every exported schema', () => assertCoversEverySchema(permission, cases));
  it('names the reason a misnumbered list is refused', () => {
    const result = permission.PermissionRequestSchema.safeParse({
      ...REQUEST,
      options: [...REQUEST.options].reverse(),
    });
    should(result.success).be.false();
    should(JSON.stringify(result.error?.issues)).match(/numbered 1\.\.n/);
  });
});
