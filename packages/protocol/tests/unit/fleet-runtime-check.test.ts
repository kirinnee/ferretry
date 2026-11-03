/**
 * The wire shape of a runtime check: an empty strict request, and an answer that is a pass or a coded
 * failure with a sentence — never a field for what the CLI printed.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import * as check from '../../src/lib/fleet-runtime-check.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const passed = {
  ok: true,
  ms: 2_412,
  sentence: 'claude-bedrock answered through Amazon Bedrock (us-east-1) in 2.4 s.',
};
const failed = {
  ok: false,
  ms: 1_200,
  code: 'model_unavailable',
  sentence: 'Amazon Bedrock refused the model in us-east-1.',
};

const cases: SchemaCase[] = [
  { name: 'FleetRuntimeCheckRequestSchema', schema: check.FleetRuntimeCheckRequestSchema, value: {} },
  { name: 'FleetRuntimeCheckResultSchema pass', schema: check.FleetRuntimeCheckResultSchema, value: passed },
  { name: 'FleetRuntimeCheckResultSchema fail', schema: check.FleetRuntimeCheckResultSchema, value: failed },
  { name: 'FleetRuntimeCheckCodeSchema', schema: check.FleetRuntimeCheckCodeSchema, value: 'timed_out' },
  {
    name: 'FleetRuntimeCheckRefusalCodeSchema',
    schema: check.FleetRuntimeCheckRefusalCodeSchema,
    value: 'fleet_runtime_unknown',
  },
];

describe('the runtime check wire contract', () => {
  it('should round-trip the request, a pass, a failure and the codes', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(check, cases);
  });

  it('should refuse a request field, a failure with no code, a pass with one, and any output field', () => {
    assertRejects([
      { name: 'a model in the body', schema: check.FleetRuntimeCheckRequestSchema, value: { model: 'x' } },
      {
        name: 'a failure without its code',
        schema: check.FleetRuntimeCheckResultSchema,
        value: { ...failed, code: undefined },
      },
      {
        name: 'a pass with a code',
        schema: check.FleetRuntimeCheckResultSchema,
        value: { ...passed, code: 'timed_out' },
      },
      {
        name: 'the CLI output',
        schema: check.FleetRuntimeCheckResultSchema,
        value: { ...failed, output: 'Error: 401' },
      },
      {
        name: 'an unknown code',
        schema: check.FleetRuntimeCheckResultSchema,
        value: { ...failed, code: 'probe_failed' },
      },
    ]);
    should(check.FLEET_RUNTIME_CHECK_CODES).containEql('not_launchable');
  });
});
