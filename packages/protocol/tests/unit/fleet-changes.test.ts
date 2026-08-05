import { describe, it } from 'bun:test';
import should from 'should';
import {
  FleetApplyOutcomeSchema,
  FleetAssetListingSchema,
  FleetManifestSummarySchema,
  FleetMutationSchema,
  FleetProposalApplyRequestSchema,
  JsonValueSchema,
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

describe('JsonValueSchema', () => {
  it.each([['text'], [42], [true], [null]])('should accept the scalar %j a settings file may hold', value => {
    // Act + Assert
    should(JsonValueSchema.safeParse(value).success).be.true();
  });

  it('should accept a nested document', () => {
    // Act
    const actual = JsonValueSchema.safeParse({ hooks: { PreToolUse: [{ matcher: 'Bash', enabled: true }] } });

    // Assert
    should(actual.success).be.true();
  });

  it('should refuse a value no settings document could round-trip', () => {
    // Act + Assert — `unknown` would have accepted this and lost it on the way to disk.
    should(JsonValueSchema.safeParse({ when: new Date() }).success).be.false();
  });
});

describe('FleetAssetListingSchema', () => {
  it('should accept a readable entry with no reason', () => {
    // Act + Assert
    should(FleetAssetListingSchema.safeParse({ path: 'CLAUDE.md', bytes: 9, readable: true }).success).be.true();
  });

  it('should refuse damaged evidence that does not explain itself', () => {
    // Act + Assert — unreadable with no reason is indistinguishable from absent, which is the bug.
    should(FleetAssetListingSchema.safeParse({ path: 'x.md', bytes: 0, readable: false }).success).be.false();
  });
});

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
  it('should read an approval code the way a person types it', () => {
    // Act
    const actual = FleetProposalApplyRequestSchema.safeParse({ approvalCode: ' 7f3k m9qw ' });

    // Assert — one grammar everywhere, rather than a laxer length rule on this field.
    should(actual.success && actual.data.approvalCode).equal('7F3K-M9QW');
  });

  it('should refuse a code that is not in the grammar at all', () => {
    // Act + Assert
    should(FleetProposalApplyRequestSchema.safeParse({ approvalCode: 'not-a-code' }).success).be.false();
  });

  it('should accept an apply that carries no code', () => {
    // Act + Assert — the host's own credential needs none.
    should(FleetProposalApplyRequestSchema.safeParse({}).success).be.true();
  });
});

describe('FleetMutationSchema', () => {
  it('should refuse an arbitrary key inside an account layer', () => {
    // Act + Assert — the overlay is spelled out, so a typo is an error rather than carried along.
    const actual = FleetMutationSchema.safeParse({
      kind: 'edit-account',
      accountId: ACCOUNT_ID,
      layer: { memroy: './typo.md' },
    });

    // Assert
    should(actual.success).be.false();
  });

  it('should distinguish removing a layer field from leaving it alone', () => {
    // Act
    const actual = FleetMutationSchema.safeParse({
      kind: 'edit-account',
      accountId: ACCOUNT_ID,
      layer: { skills: null },
    });

    // Assert
    should(actual.success && actual.data.kind === 'edit-account' && actual.data.layer).deepEqual({ skills: null });
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

  it('should describe a partly prepared host as its own outcome', () => {
    // Act
    const actual = FleetApplyOutcomeSchema.safeParse({
      outcome: 'initialization-partial',
      reason: 'exists but is not a file',
      failedPath: '/state/fleet/assets/CLAUDE.md',
      created: ['/state/fleet/config.yaml'],
      kept: [],
      directories: ['/state/fleet', '/state/fleet/bin'],
    });

    // Assert
    should(actual.success).be.true();
  });
});
