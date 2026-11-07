/** Today's audit table (`packages/daemon/src/lib/audit/routes.ts:733-738,818-819`) records the routing routes. */
import { describe, expect, test } from 'bun:test';
import { AUDIT_KINDS } from '@ferretry/core-gate/contract';
import manifest from '../../../manifest.ts';

const auditOf = (key: string): unknown => manifest.actions?.routes?.find(route => route.key === key)?.audit;

describe('what the security log records for routing', () => {
  test('a Clean up a person starts is recorded as a session opened, as today', () => {
    expect(auditOf('POST /v1/pack/routing/clean-up')).toEqual({ record: AUDIT_KINDS['session.opened'] });
  });

  test('accepting or undoing a routing prompt is recorded as a fleet change, as today', () => {
    expect(auditOf('POST /v1/pack/routing/accept')).toEqual({ record: AUDIT_KINDS['fleet.configured'] });
    expect(auditOf('POST /v1/pack/routing/undo')).toEqual({ record: AUDIT_KINDS['fleet.configured'] });
  });

  test('changing a ferret’s pack stays unrecorded, as today', () => {
    expect(auditOf('PATCH /v1/ferrets/:ferretId/pack')).toEqual({
      skip: 'not recorded today (docs/audit.md has no pack row)',
    });
  });
});
