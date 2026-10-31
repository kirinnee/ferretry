import { describe, it } from 'bun:test';
import should from 'should';
import * as restart from '../../src/lib/session-restart.ts';
import { SessionOutdatedSchema } from '../../src/lib/session.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const AT = '2026-10-30T01:00:00.000Z';

const result = {
  restarted: [{ id: 'ses-1', name: 'Wren' }],
  queued: [{ id: 'ses-2', reason: 'in-flight' as const, detail: 'a test run is open' }],
  skipped: [{ id: 'ses-3', reason: 'not-running' as const }],
  failed: [{ id: 'ses-4', reason: 'the conversation cannot be resumed' }],
};

describe('the restart contract', () => {
  it('should round-trip every shape and cover every schema', () => {
    const cases: SchemaCase[] = [
      { name: 'scope', schema: restart.RestartScopeSchema, value: 'outdated' },
      { name: 'queue reason', schema: restart.RestartQueueReasonSchema, value: 'own-session' },
      { name: 'skip reason', schema: restart.RestartSkipReasonSchema, value: 'not-found' },
      { name: 'outdated request', schema: restart.RestartRequestSchema, value: { scope: 'outdated' } },
      {
        name: 'request naming ids, called by a ferret',
        schema: restart.RestartRequestSchema,
        value: { scope: 'ids', ids: ['ses-1'], caller: 'ses-9' },
      },
      { name: 'queued', schema: restart.RestartQueuedSchema, value: result.queued[0] },
      { name: 'result', schema: restart.RestartResultSchema, value: result },
      {
        name: 'queue entry',
        schema: restart.RestartQueueEntrySchema,
        value: { id: 'ses-2', since: AT, reason: 'mid-turn', onlyIfOutdated: true },
      },
      {
        name: 'status',
        schema: restart.RestartStatusSchema,
        value: {
          outdated: [{ id: 'ses-2', name: 'Fern', sections: ['notify', 'pack'] }],
          queued: [{ id: 'ses-2', since: AT, reason: 'mid-turn', onlyIfOutdated: false }],
        },
      },
      { name: 'cancel', schema: restart.RestartCancelResultSchema, value: { cancelled: 2 } },
      { name: 'outdated on a view', schema: SessionOutdatedSchema, value: { sections: ['settings'] } },
    ];
    assertRoundTrips(cases);
    assertCoversEverySchema(
      restart,
      cases.filter(entry => entry.schema !== SessionOutdatedSchema),
    );
  });

  it('should refuse ids that do not match the scope, and unknown fields', () => {
    assertRejects([
      { name: 'ids scope without ids', schema: restart.RestartRequestSchema, value: { scope: 'ids' } },
      {
        name: 'outdated scope with ids',
        schema: restart.RestartRequestSchema,
        value: { scope: 'outdated', ids: ['a'] },
      },
      { name: 'all scope with ids', schema: restart.RestartRequestSchema, value: { scope: 'all', ids: ['a'] } },
      { name: 'empty ids', schema: restart.RestartRequestSchema, value: { scope: 'ids', ids: [] } },
      { name: 'unknown field', schema: restart.RestartRequestSchema, value: { scope: 'all', force: true } },
      { name: 'unknown scope', schema: restart.RestartRequestSchema, value: { scope: 'everything' } },
      { name: 'empty outdated sections', schema: SessionOutdatedSchema, value: { sections: [] } },
      { name: 'an unknown section', schema: SessionOutdatedSchema, value: { sections: ['voice'] } },
    ]);
  });

  it('should keep the view free of the field unless the ferret is outdated', () => {
    should(SessionOutdatedSchema.safeParse({ sections: ['tools'] }).success).be.true();
  });
});
