/** GraphQL answers as GitHub shapes them, for the watcher's tests. */
export const REPO = 'kirinnee/ferretry';
export const SHA = 'a'.repeat(40);

export const prUrl = (number: number, repo = REPO): string => `https://github.com/${repo}/pull/${String(number)}`;

export interface NodeOptions {
  readonly repo?: string;
  readonly state?: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly draft?: boolean;
  readonly rollup?: string | null;
  readonly head?: string;
  readonly mergedAt?: string | null;
  readonly sha?: string | null;
}

/** One `PullRequest` node. */
export const prNode = (number: number, options: NodeOptions = {}) => {
  const state = options.state ?? 'OPEN';
  const merged = state === 'MERGED';
  const rollup = options.rollup === undefined ? 'PENDING' : options.rollup;
  return {
    number,
    url: prUrl(number, options.repo),
    state,
    isDraft: options.draft ?? false,
    mergedAt: options.mergedAt === undefined ? (merged ? '2026-10-30T09:00:00Z' : null) : options.mergedAt,
    mergeCommit:
      options.sha === undefined ? (merged ? { oid: SHA } : null) : options.sha === null ? null : { oid: options.sha },
    headRefName: options.head ?? `feat/pr-${String(number)}`,
    commits: { nodes: [{ commit: { statusCheckRollup: rollup === null ? null : { state: rollup } } }] },
  };
};

export interface ReleaseNode {
  readonly tagName: string;
  readonly publishedAt: string | null;
  readonly isDraft?: boolean;
  readonly isPrerelease?: boolean;
}

/** A `gh api graphql` answer for one repository. */
export const answer = (fields: {
  readonly prs?: Readonly<Record<number, unknown>>;
  readonly branches?: readonly (readonly unknown[])[];
  readonly releases?: readonly ReleaseNode[];
  readonly defaultBranch?: string;
}): string =>
  JSON.stringify({
    data: {
      repository: {
        defaultBranchRef: { name: fields.defaultBranch ?? 'main' },
        ...Object.fromEntries(Object.entries(fields.prs ?? {}).map(([number, node]) => [`p${number}`, node])),
        ...Object.fromEntries((fields.branches ?? []).map((nodes, index) => [`b${String(index)}`, { nodes }])),
        ...(fields.releases === undefined
          ? {}
          : {
              releases: {
                nodes: fields.releases.map(release => ({ isDraft: false, isPrerelease: false, ...release })),
              },
            }),
      },
    },
  });
