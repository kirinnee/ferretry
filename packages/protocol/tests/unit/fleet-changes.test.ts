import { describe, it } from 'bun:test';
import should from 'should';
import {
  FleetApplyOutcomeSchema,
  FleetAssetListingSchema,
  FleetAssetSharingSchema,
  FleetLinkableFieldSchema,
  FleetShareableFieldSchema,
  FleetSharingSchema,
  FleetManifestSummarySchema,
  FleetMutationSchema,
  FleetProposalApplyRequestSchema,
  FleetProposalRequestSchema,
  fleetAssetRefProblem,
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

/** Every issue a parse raised, as one string — and the empty string when it raised none. */
const issuesFor = (parsed: {
  readonly success: boolean;
  readonly error?: { readonly issues: readonly { readonly message: string }[] };
}): string => (parsed.success ? '' : (parsed.error?.issues.map(issue => issue.message).join('; ') ?? ''));

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

  it.each([['memory'], ['skills'], ['hooks'], ['hooksDir'], ['mcp'], ['settings']])(
    'should refuse a %s that names a file outside the asset tree',
    field => {
      // Act — every one of these is copied or read by the host when the change is applied.
      const actual = FleetMutationSchema.safeParse({
        kind: 'edit-account',
        accountId: ACCOUNT_ID,
        layer: { [field]: '/etc/passwd' },
      });

      // Assert
      should(issuesFor(actual)).match(/asset path "\/etc\/passwd" must be relative to the asset directory/u);
    },
  );

  it.each([
    ['an absolute path', '/etc/passwd', /must be relative to the asset directory/u],
    ['a traversal', '../../../../etc/passwd', /contains a path traversal segment/u],
    ['a home alias', '~/.ssh', /not to a home/u],
    ['a shell home alias', '$HOME/.ssh', /not to a home/u],
    ['a Windows drive', 'C:/windows/system32', /must be relative to the asset directory/u],
  ])('should refuse %s in an overlay', (_label, candidate, expected) => {
    // Act
    const actual = FleetMutationSchema.safeParse({
      kind: 'edit-account',
      accountId: ACCOUNT_ID,
      layer: { memory: candidate },
    });

    // Assert
    should(issuesFor(actual)).match(expected);
  });

  it('should refuse an escape hidden in a per-harness overlay', () => {
    // Act — the nested overlays are the same fields one level down, and a rule that stopped at the
    // top level would be a rule a caller walks around by spelling `claude:` first.
    const actual = FleetMutationSchema.safeParse({
      kind: 'edit-account',
      accountId: ACCOUNT_ID,
      layer: { claude: { skills: '~/.ssh' }, codex: { memory: 'AGENTS.md' } },
    });

    // Assert
    should(issuesFor(actual)).match(/asset path "~\/\.ssh"/u);
  });

  it('should refuse an escape hidden in a list of settings layers', () => {
    // Act — a settings string is a reference to a file, so it is one of these fields too.
    const actual = FleetMutationSchema.safeParse({
      kind: 'edit-account',
      accountId: ACCOUNT_ID,
      layer: { settings: [{ theme: 'dark' }, '../../../../etc/shadow'] },
    });

    // Assert
    should(issuesFor(actual)).match(/contains a path traversal segment/u);
  });

  it('should accept the references a browser legitimately composes', () => {
    // Act
    const actual = FleetMutationSchema.safeParse({
      kind: 'edit-account',
      accountId: ACCOUNT_ID,
      layer: {
        memory: 'CLAUDE.md',
        skills: 'skills/kirin',
        settings: ['templates/claude/settings.json', { theme: 'dark' }],
        claude: { memory: 'claude-only.md' },
        env: { LANE: 'default' },
        flags: ['--verbose'],
      },
    });

    // Assert — the grammar bounds where a reference may point, not what an editor may say.
    should(actual.success).be.true();
  });

  it('should keep the operator-authored spelling out of its business', () => {
    // Act + Assert — `./x` is refused HERE, on the untrusted path, and stays valid in config.yaml:
    // the restriction belongs to the caller, not to the file format.
    should(
      issuesFor(
        FleetMutationSchema.safeParse({
          kind: 'edit-account',
          accountId: ACCOUNT_ID,
          layer: { memory: './CLAUDE.md' },
        }),
      ),
    ).match(/contains a path traversal segment/u);
  });
});

describe('FleetProposalRequestSchema', () => {
  it('should refuse an asset edit whose path escapes the tree', () => {
    // Act — the same grammar as the overlay fields, stated once and enforced on both.
    const actual = FleetProposalRequestSchema.safeParse({
      mutation: { kind: 'initialize' },
      assetEdits: [{ path: '../../escape.md', content: 'no' }],
    });

    // Assert
    should(issuesFor(actual)).match(/asset path "\.\.\/\.\.\/escape\.md" contains a path traversal segment/u);
  });

  it('should accept an asset edit inside the tree', () => {
    // Act
    const actual = FleetProposalRequestSchema.safeParse({
      mutation: { kind: 'initialize' },
      assetEdits: [{ path: 'skills/review/SKILL.md', content: 'text\n' }],
    });

    // Assert
    should(actual.success).be.true();
  });
});

describe('fleetAssetRefProblem', () => {
  it.each([
    ['', /is empty/u],
    [`${'a'.repeat(400)}.md`, /longer than 200 characters/u],
    ['skills\\review', /must use "\/" separators/u],
    ['/etc/passwd', /must be relative to the asset directory/u],
    ['C:/windows', /must be relative to the asset directory/u],
    ['skills/\u0000SKILL.md', /contains control characters/u],
    ['~', /not to a home/u],
    ['$HOME/notes.md', /not to a home/u],
    ['a/b/c/d/e/f/g/h/i.md', /deeper than 8 directories/u],
    ['skills//SKILL.md', /contains an empty path segment/u],
    ['../secrets', /contains a path traversal segment/u],
    ['skills/ review.md', /segment starting or ending with whitespace/u],
  ])('should refuse %p', (candidate, expected) => {
    // Act + Assert — one grammar, so this table is the whole rule for both boundaries.
    should(fleetAssetRefProblem(candidate) ?? '').match(expected);
  });

  it.each([['CLAUDE.md'], ['skills/review/SKILL.md'], ['~kirin/notes.md'], ['a/b/c/d/e/f/g/h.md']])(
    'should accept %p',
    candidate => {
      // Act + Assert — `~kirin` is expanded by nobody, so it stays inside the tree and is allowed.
      should(fleetAssetRefProblem(candidate)).be.undefined();
    },
  );
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

describe('FleetSharingSchema', () => {
  const origin = { kind: 'base-profile', name: 'base' } as const;

  const sharingOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    documents: [{ field: 'memory', name: 'default', path: './CLAUDE.md', accounts: [ACCOUNT_ID] }],
    accounts: [
      {
        accountId: ACCOUNT_ID,
        kind: 'claude',
        wrapper: 'claude-kirin',
        displayName: 'Kirin',
        fields: {
          memory: { state: 'shared', name: 'default', path: './CLAUDE.md', origin, referrers: 1 },
          skills: { state: 'absent' },
          hooks: { state: 'absent' },
          hooksDir: { state: 'absent' },
          mcp: { state: 'local', path: './own.json', origin: { kind: 'account' }, referrers: 1 },
        },
        settings: [{ position: 0, kind: 'inline', origin }],
        linkable: ['memory', 'skills', 'mcp'],
      },
    ],
    ...overrides,
  });

  it('should accept a report carrying every state a field can be in', () => {
    // Act / Assert
    should(FleetSharingSchema.parse(sharingOf())).match({ accounts: [{ fields: { memory: { referrers: 1 } } }] });
  });

  it('should refuse a field that resolves to a path no account refers to', () => {
    // Arrange — an account resolving a path IS a referrer, so zero would mean the count and the value
    // disagree, and a surface would render "shared with -1 other accounts".
    const zero = sharingOf({
      accounts: [
        {
          ...(sharingOf().accounts as Record<string, unknown>[])[0],
          fields: {
            memory: { state: 'shared', name: 'default', path: './CLAUDE.md', origin, referrers: 0 },
            skills: { state: 'absent' },
            hooks: { state: 'absent' },
            hooksDir: { state: 'absent' },
            mcp: { state: 'absent' },
          },
        },
      ],
    });

    // Act / Assert
    should(FleetSharingSchema.safeParse(zero).success).be.false();
  });

  it('should refuse an absent field that also claims a path', () => {
    // Act / Assert — the states are a discriminated union, so "absent, but here is what it is" cannot be
    // expressed at all rather than being accepted and rendered as a contradiction.
    should(
      FleetAssetSharingSchema.safeParse({ state: 'absent', path: './CLAUDE.md', origin, referrers: 1 }).success,
    ).be.false();
  });

  it('should refuse a field name outside the linkable set', () => {
    // Act / Assert — `settings` is shareable but never linkable, so it must not appear here.
    should(FleetLinkableFieldSchema.safeParse('settings').success).be.false();
    should(FleetShareableFieldSchema.safeParse('settings').success).be.true();
  });
});

describe('the sharing mutations', () => {
  it('should carry the shared document by name rather than by path', () => {
    // Act
    const parsed = FleetMutationSchema.parse({
      kind: 'link-shared-asset',
      accountId: ACCOUNT_ID,
      field: 'memory',
      name: 'default',
    });

    // Assert — a caller able to send a path would be choosing which of the host's files the next
    // approved change copies into a home.
    should(parsed).deepEqual({
      kind: 'link-shared-asset',
      accountId: ACCOUNT_ID,
      field: 'memory',
      name: 'default',
    });
    should(
      FleetMutationSchema.safeParse({
        kind: 'link-shared-asset',
        accountId: ACCOUNT_ID,
        field: 'memory',
        path: './CLAUDE.md',
      }).success,
    ).be.false();
  });

  it('should let an unlink carry nothing but the account and the field', () => {
    // Act / Assert — the destination and the content are derived on the host, so there is no field here
    // for a caller to aim either one with.
    should(
      FleetMutationSchema.parse({ kind: 'unlink-shared-asset', accountId: ACCOUNT_ID, field: 'memory' }),
    ).deepEqual({ kind: 'unlink-shared-asset', accountId: ACCOUNT_ID, field: 'memory' });
    should(
      FleetMutationSchema.safeParse({
        kind: 'unlink-shared-asset',
        accountId: ACCOUNT_ID,
        field: 'memory',
        content: 'anything',
      }).success,
    ).be.false();
  });

  it('should refuse a sharing mutation aimed at the layered settings field', () => {
    // Act / Assert
    should(
      FleetMutationSchema.safeParse({
        kind: 'unlink-shared-asset',
        accountId: ACCOUNT_ID,
        field: 'settings',
      }).success,
    ).be.false();
  });
});
