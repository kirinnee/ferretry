import { describe, it } from 'bun:test';
import should from 'should';
import {
  FleetApplyOutcomeSchema,
  FleetManifestSummarySchema,
  FleetProposalApplyRequestSchema,
} from '../../src/lib/fleet-changes.ts';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';

const account = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ACCOUNT_ID,
  kind: 'claude',
  mode: 'interactive',
  wrapper: 'claude-kirin',
  home: 'claude-kirin',
  displayName: 'Kirin',
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const manifestOf = (accounts: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts,
});

const issuesOf = (input: unknown): string => {
  const parsed = FleetManifestSummarySchema.safeParse(input);
  return parsed.success ? '' : parsed.error.issues.map(issue => issue.message).join('; ');
};

describe('FleetManifestSummarySchema', () => {
  it('should accept a coherent roster', () => {
    // Act + Assert
    should(issuesOf(manifestOf([account()]))).equal('');
  });

  it('should refuse an available account carrying a reason it is unavailable', () => {
    // Act + Assert
    should(issuesOf(manifestOf([account({ unavailableReason: 'down' })]))).match(
      /must not carry an unavailableReason/u,
    );
  });

  it('should refuse an unavailable account that does not say why', () => {
    // Act + Assert
    should(issuesOf(manifestOf([account({ available: false, defaultModel: null })]))).match(
      /must state an unavailableReason/u,
    );
  });

  it('should refuse an available account with no default model', () => {
    // Act + Assert
    should(issuesOf(manifestOf([account({ defaultModel: null })]))).match(/must name a defaultModel/u);
  });

  it('should refuse a default model the account does not serve', () => {
    // Act + Assert
    should(issuesOf(manifestOf([account({ defaultModel: 'sonnet' })]))).match(/is not one of this account/u);
  });

  it('should refuse a default model the account has declared down', () => {
    // Act + Assert — every consumer would offer it and every launch would fail on the same choice.
    should(
      issuesOf(
        manifestOf([
          account({
            defaultModel: 'retired',
            models: [{ id: 'retired', available: false, unavailableReason: 'withdrawn' }],
          }),
        ]),
      ),
    ).match(/is declared unavailable/u);
  });

  it('should refuse a model listed twice', () => {
    // Act + Assert
    should(
      issuesOf(
        manifestOf([
          account({
            models: [
              { id: 'opus', available: true },
              { id: 'opus', available: true },
            ],
          }),
        ]),
      ),
    ).match(/duplicate model/u);
  });

  it.each([['id'], ['wrapper'], ['home']])('should refuse two accounts sharing one %s', field => {
    // Arrange — identity is what every consumer joins on.
    const second = account({ id: SECOND_ID, wrapper: 'claude-other', home: 'claude-other' });
    const collided = { ...second, [field]: account()[field] };

    // Act + Assert
    should(issuesOf(manifestOf([account(), collided]))).match(new RegExp(`duplicate account ${field}`, 'u'));
  });
});

describe('FleetProposalApplyRequestSchema', () => {
  it('should accept an empty body, because the step-up gate is the whole confirmation', () => {
    // Act + Assert — a governed apply is held behind the passkey step-up at the boundary, so nothing
    // rides in the body.
    should(FleetProposalApplyRequestSchema.safeParse({}).success).be.true();
  });

  it.each([
    ['an operator password', { operatorPassword: 'correct horse battery' }],
    ['a per-change confirmation', { confirmation: { operatorPassword: 'correct horse battery' } }],
    ['an approval code', { approvalCode: '7F3K-M9QW' }],
  ])('should refuse %s, because that vocabulary no longer exists', (_name, body) => {
    // Act + Assert — a strict object, so a client still sending one is told rather than ignored.
    should(FleetProposalApplyRequestSchema.safeParse(body).success).be.false();
  });
});

describe('FleetApplyOutcomeSchema', () => {
  it('should refuse a committed apply that published no manifest', () => {
    // Act + Assert — the empty string was how a scaffold masqueraded as an apply of zero accounts.
    const actual = FleetApplyOutcomeSchema.safeParse({
      outcome: 'committed',
      result: {
        accountCount: 0,
        operationCount: 1,
        manifestPath: '',
        prunedWrappers: [],
        sharedHistory: [],
      },
    });

    // Assert
    should(actual.success).be.false();
  });

  it('should carry unrestored and displaced as separate lists', () => {
    // Act — they mean different things to an operator and must never be flattened together.
    const actual = FleetApplyOutcomeSchema.safeParse({
      outcome: 'rollback-incomplete',
      failedOperation: 'file /bin/claude-kirin',
      reason: 'disk is full',
      unrestored: [{ path: '/homes/one/memory.md', reason: 'changed', backup: '/homes/one/.backup' }],
      displaced: [{ path: '/homes/one/skills', movedTo: '/homes/one/.fy-fleet-displaced-abc' }],
      lockResidue: '/state/fleet/.fy-fleet-apply.lock',
    });

    // Assert
    should(actual.success).be.true();
  });

  it('should refuse the retired host-preparation outcome, which nothing produces any more', () => {
    // Act + Assert — the scaffold that reported it is gone, so the wire no longer describes it.
    should(
      FleetApplyOutcomeSchema.safeParse({
        outcome: 'initialized',
        created: [],
        kept: [],
        directories: [],
        pathEntry: 'x',
      }).success,
    ).be.false();
  });

  it('should accept a skipped entry attributed to a runtime and refuse a half attribution', () => {
    // Arrange
    const outcome = (skipped: unknown) => ({
      outcome: 'committed',
      result: {
        accountCount: 1,
        operationCount: 1,
        manifestPath: '/state/fleet/manifest.json',
        prunedWrappers: [],
        sharedHistory: [],
        skipped,
      },
    });

    // Act + Assert — `within` is the path relative to the runtime folder, so a browser never learns the folder.
    should(
      FleetApplyOutcomeSchema.safeParse(
        outcome([{ path: '/h/skills/review', reason: 'a link', runtime: ACCOUNT_ID, within: 'skills/review' }]),
      ).success,
    ).be.true();
    should(FleetApplyOutcomeSchema.safeParse(outcome([{ path: '/h/x', reason: 'a link' }])).success).be.true();
    should(
      FleetApplyOutcomeSchema.safeParse(outcome([{ path: '/h/x', reason: 'a link', runtime: 'not-an-id' }])).success,
    ).be.false();
  });
});
