/**
 * Invented data for the Update review (docs/design/account-model.md §4.7): a source machine's export and the
 * review a target would answer for it. Shared by the unit suites and the screenshot harness
 * (`harness/clone-review-screenshot.tsx`), so what is photographed is what is tested.
 *
 * Every name, address and command here is made up. There is no credential, token or secret value.
 */

import { type CloneReviewItem } from '@ferretry/plugin-runtimes/contract';
import { type FleetCloneReview, FleetCloneReviewSchema } from '@ferretry/protocol';
import { bundle } from './setup-support.ts';

const GUARD_SCRIPT = `#!/bin/sh
# Stop a risky command before an agent runs it.
case "$1" in
  rm|dd|mkfs) echo "blocked: $1" >&2; exit 2 ;;
  curl|wget) echo "network call: $1" >&2 ;;
esac
exit 0
`;

/** What the other machine (work-linux) exports now: twelve things. */
export const UPDATE_BUNDLE = bundle({
  credentials: [
    { id: 'claude-work', harness: 'claude', email: 'me@work.example' },
    { id: 'codex-work', harness: 'codex', label: 'Work' },
  ],
  components: {
    instructions: {
      default: { file: 'components/instructions/default.md' },
      main: { file: 'components/instructions/main.md' },
    },
    mcp: { notes: { command: 'npx', args: ['-y', 'notes'] } },
    hooks: { guard: { directory: 'components/hooks/guard' }, lint: { directory: 'components/hooks/lint' } },
    settings: { shared: { flags: ['--verbose', '--dangerously-skip-permissions'] } },
    modelSets: {},
  },
  profiles: {
    default: { layers: ['instructions/default'] },
    review: { layers: ['instructions/default', 'mcp/notes'] },
    plain: { layers: ['instructions/main'] },
  },
  runtimes: {
    'claude-default': { credential: 'claude-work', profile: 'default' },
    'claude-review': { credential: 'claude-work', profile: 'review' },
    'codex-default': { credential: 'codex-work', profile: 'default' },
  },
  files: [
    { path: 'components/instructions/default.md', content: 'Be kind and concise.\n' },
    { path: 'components/instructions/main.md', content: 'Plan first, then act.\n' },
    { path: 'components/hooks/guard/send.sh', content: GUARD_SCRIPT },
    { path: 'components/hooks/lint/run.sh', content: '#!/bin/sh\nexec lint --fix "$@"\n' },
  ],
});

/** This machine's own copy of the guard script, one line different from the other machine's. */
export const HERE_GUARD_SCRIPT = GUARD_SCRIPT.replace('  curl|wget) echo "network call: $1" >&2 ;;\n', '')
  .replace('rm|dd|mkfs', 'rm|dd')
  .replace('exit 0\n', '# nothing else to check\nexit 0\n');

/** One item of each kind of outcome. The refs are as they land here. */
export const ITEMS = {
  newMcp: {
    ref: 'mcp/notes',
    sourceRef: 'mcp/notes',
    kind: 'mcp',
    outcome: 'new',
    match: 'none',
    choice: 'add',
    files: [],
    runnable: {
      reference: 'mcp/notes',
      kind: 'mcp',
      name: 'notes',
      entries: [{ label: 'Starts', text: 'npx -y notes', document: false }],
    },
  },
  newProfile: {
    ref: 'profile/review',
    sourceRef: 'profile/review',
    kind: 'profile',
    outcome: 'new',
    match: 'none',
    choice: 'add',
    files: [],
    fields: ['layers'],
    needs: ['mcp/notes'],
  },
  theirsHooks: {
    ref: 'hooks/guard',
    sourceRef: 'hooks/guard',
    kind: 'hooks',
    outcome: 'theirs',
    match: 'key',
    choice: 'take',
    files: [{ path: 'components/hooks/guard/send.sh', change: 'changed', lines: { added: 3, removed: 1 } }],
    runnable: {
      reference: 'hooks/guard',
      kind: 'hooks',
      name: 'guard',
      entries: [{ label: 'Script components/hooks/guard/send.sh', text: GUARD_SCRIPT, document: true }],
    },
  },
  bothSettings: {
    ref: 'settings/shared',
    sourceRef: 'settings/shared',
    kind: 'settings',
    outcome: 'both',
    match: 'probable',
    files: [],
    fields: ['flags'],
    runnable: {
      reference: 'settings/shared',
      kind: 'settings',
      name: 'shared',
      entries: [
        { label: 'Launch flag', text: '--verbose', document: false },
        { label: 'Launch flag', text: '--dangerously-skip-permissions', document: false },
      ],
    },
    note: 'Probably the same item; we can’t tell which side changed it.',
  },
  bothHooks: {
    ref: 'hooks/lint',
    sourceRef: 'hooks/lint',
    kind: 'hooks',
    outcome: 'both',
    match: 'key',
    files: [{ path: 'components/hooks/lint/run.sh', change: 'changed', lines: { added: 1, removed: 1 } }],
  },
  bothProfile: {
    ref: 'profile/default',
    sourceRef: 'profile/default',
    kind: 'profile',
    outcome: 'both',
    match: 'key',
    files: [],
    fields: ['layers'],
  },
  mineInstructions: {
    ref: 'instructions/main',
    sourceRef: 'instructions/main',
    kind: 'instructions',
    outcome: 'mine',
    match: 'key',
    choice: 'keep',
    files: [],
  },
  goneRuntime: {
    ref: 'runtime/old-codex',
    kind: 'runtime',
    outcome: 'gone',
    match: 'key',
    choice: 'keep',
    files: [],
  },
  removedHere: {
    ref: 'profile/plain',
    sourceRef: 'profile/plain',
    kind: 'profile',
    outcome: 'removed-here',
    match: 'key',
    choice: 'keep',
    files: [],
  },
  relocated: {
    ref: 'hooks/lint-2',
    sourceRef: 'hooks/lint',
    kind: 'hooks',
    outcome: 'new',
    match: 'none',
    choice: 'add',
    files: [{ path: 'components/hooks/lint-2/run.sh', change: 'added', lines: { added: 2, removed: 0 } }],
    note: 'components/hooks/lint is also used by hooks/format here, so taking this writes it to components/hooks/lint-2 and leaves that one as it is.',
    runnable: {
      reference: 'hooks/lint-2',
      kind: 'hooks',
      name: 'lint-2',
      entries: [
        { label: 'Script components/hooks/lint/run.sh', text: '#!/bin/sh\nexec lint --fix "$@"\n', document: true },
      ],
    },
  },
} satisfies Record<string, CloneReviewItem>;

const SOURCE = { name: 'work-linux', lastCopiedAt: '2026-10-28T09:30:00.000Z', verified: 'browser' } as const;

/** A review the target would answer: mode `update`, everything else as given. */
export const review = (overrides: Partial<FleetCloneReview> = {}): FleetCloneReview =>
  FleetCloneReviewSchema.parse({
    mode: 'update',
    source: SOURCE,
    items: [],
    settings: [],
    logins: [{ sourceId: 'claude-work', outcome: 'matched', target: 'claude-work' }],
    keys: [],
    same: { count: 0, probable: 0 },
    fingerprint: 'fingerprint-1',
    ...overrides,
  });

/** The first-copy answer: nothing was copied before, so every item is new. */
export const FIRST_REVIEW = review({
  mode: 'first',
  source: { name: 'work-linux', verified: 'browser' },
  items: [ITEMS.newMcp, ITEMS.newProfile],
  logins: [{ sourceId: 'claude-work', outcome: 'slot' }],
});

/** Every group populated (design §6a), a login to ask about, and 6 items already the same. */
export const FULL_REVIEW = review({
  items: [
    ITEMS.newMcp,
    ITEMS.newProfile,
    ITEMS.theirsHooks,
    ITEMS.bothSettings,
    ITEMS.mineInstructions,
    ITEMS.goneRuntime,
    ITEMS.removedHere,
  ],
  logins: [
    { sourceId: 'claude-work', outcome: 'matched', target: 'claude-work' },
    { sourceId: 'codex-work', outcome: 'ask', candidates: ['codex-main', 'codex-spare'] },
  ],
  same: { count: 6, probable: 2 },
});

/** Nothing differs: all twelve things are the same, and the one login is already here. */
export const NOTHING_REVIEW = review({ same: { count: 12, probable: 3 } });
