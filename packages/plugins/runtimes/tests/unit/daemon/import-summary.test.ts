import { describe, expect, it } from 'bun:test';
import type { ImportPlan } from '../../../daemon/lib/account/import.ts';
import type { AccountModel } from '../../../daemon/lib/account/schema.ts';
import { importSummary } from '../../../daemon/lib/service/import-summary.ts';

const plan = (runtimes: Record<string, { credential: string; profile: string }>, credentials = {}): ImportPlan =>
  ({ runtimes, credentials }) as unknown as ImportPlan;
const nothing = { credentials: {} } as unknown as AccountModel;

describe('importSummary: what an import says it made', () => {
  it('names each runtime in words, never by its stored name', () => {
    const credentials = {
      'claude-you': { harness: 'claude', store: 'host' },
      'codex-you': { harness: 'codex', store: 'host' },
    };
    const said = importSummary(
      'QA Box',
      plan(
        {
          'claude-default': { credential: 'claude-you', profile: 'claude-default' },
          'codex-default': { credential: 'codex-you', profile: 'codex-default' },
        },
        credentials,
      ),
      nothing,
    );
    expect(said).toBe('2 runtimes created on QA Box: Claude · your terminal sign-in, Codex · your terminal sign-in.');
    expect(said).not.toContain('default');
  });

  it('reads a login the plan does not hold from the machine’s own, and says "Imported" when it made no runtime', () => {
    const existing = { credentials: { work: { harness: 'claude', store: 'ferretry' } } } as unknown as AccountModel;
    expect(importSummary('QA Box', plan({ 'claude-default': { credential: 'work', profile: 'p' } }), existing)).toBe(
      '1 runtime created on QA Box: Claude · Claude.ai sign-in.',
    );
    // A runtime whose login is nowhere is not named from a guess.
    expect(importSummary('QA Box', plan({ 'claude-default': { credential: 'gone', profile: 'p' } }), nothing)).toBe(
      'Imported into QA Box.',
    );
    expect(importSummary('QA Box', plan({}), nothing)).toBe('Imported into QA Box.');
  });
});
