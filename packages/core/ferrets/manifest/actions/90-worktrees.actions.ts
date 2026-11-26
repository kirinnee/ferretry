/** Managed worktrees: the worktree routes and `fy worktree`. */
import { AUDIT_KINDS, CAPABILITIES } from '@ferretry/core-gate/contract';
import { route, verb } from '@ferretry/kernel/manifest';
import { fragment } from '../kit.ts';

export default fragment({
  routes: [
    route('POST /v1/worktrees/adopt', {
      minimum: 'operator',
      caller: 'any',
      capability: { capability: CAPABILITIES.filesystem, axis: 'configure' },
      noStore: true,
      audit: { skip: 'adopting files ownership in the worktree registry, as creating a checkout does' },
      guard: { none: 'answers the adopted checkout and its removal verdict, no file contents' },
    }),
    // Managed worktrees (today's `mounts/worktrees.ts`); the removal check is a deeper literal than the collection.
    // The whole repository, hand-made worktrees included: the caller names ANY repository's common directory, so this maps
    // the disk the way an outside-home folder read does, and asks the same axis (docs/grants.md).
    route('GET /v1/worktrees/repo', {
      minimum: 'operator',
      caller: 'any',
      capability: { capability: CAPABILITIES.filesystem, axis: 'configure' },
      noStore: true,
      audit: { skip: 'a repository worktree list records nothing, as the managed list does not' },
      guard: { none: 'worktree paths, branches, heads and ferret ids of one repository, no file contents' },
    }),
    // R-0211
    route('GET /v1/worktrees/removal', {
      minimum: 'operator',
      caller: 'any',
      capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
      noStore: true,
      audit: { skip: 'a removal check records nothing, as today' },
      guard: { none: 'a removal verdict: paths, branch names and blocker codes, no file contents' },
    }),
    // R-0411
    route('POST /v1/worktrees/remove', {
      minimum: 'operator',
      caller: 'any',
      capability: { capability: CAPABILITIES.filesystem, axis: 'configure' },
      noStore: true,
      audit: { record: AUDIT_KINDS['worktree.removed'] },
      guard: { none: 'answers the removed checkout: its path and branch' },
    }),
    // R-0210
    route('GET /v1/worktrees', {
      minimum: 'operator',
      caller: 'any',
      capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
      noStore: true,
      audit: { skip: 'a worktree list records nothing, as today' },
      guard: { none: 'managed checkouts: paths, branches, heads and occupancy, no file contents' },
    }),
    // R-0410
    route('POST /v1/worktrees', {
      minimum: 'operator',
      caller: 'any',
      capability: { capability: CAPABILITIES.filesystem, axis: 'configure' },
      noStore: true,
      audit: { skip: 'creating a checkout is not kept in the security log, as today' },
      guard: { none: 'answers the new checkout and the folder to start work in' },
    }),
  ],
  cli: [
    verb('worktree adopt <path>', {
      summary: 'track an existing linked checkout in place so it can be safely removed later',
      args: [{ name: 'path', help: 'the existing linked worktree root' }],
      options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
    }),
    verb('worktree', {
      summary: 'inspect and remove the checkouts the daemon created for ferrets',
      args: [],
      options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
    }),
    verb('worktrees', {
      summary: 'alias of fy worktree',
      args: [],
      options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
    }),
    verb('worktree ls', {
      summary: 'every managed worktree, live ones first',
      args: [],
      options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
    }),
    verb('worktree list', {
      summary: 'alias of fy worktree ls',
      args: [],
      options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
    }),
    verb('worktree check <path>', {
      summary: 'say whether a worktree can be removed, and what stands in the way',
      args: [{ name: 'path', help: 'the worktree path' }],
      options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
    }),
    verb('worktree rm <path>', {
      summary: 'remove a worktree once every blocker is accounted for',
      args: [{ name: 'path', help: 'the worktree path' }],
      options: [
        { flag: '--discard-changes', help: 'accept losing uncommitted work in the worktree' },
        { flag: '--accept-unpushed', help: 'accept losing commits that exist nowhere else' },
        { flag: '--delete-unmerged', help: 'accept deleting a branch that was never merged' },
        { flag: '--delete-branch', help: 'delete the branch too instead of leaving it behind' },
        { flag: '--delete-preexisting', help: 'allow deleting a branch that existed before the worktree' },
        { flag: '-y, --yes', help: 'skip the typed confirmation; required when not on a terminal' },
        { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
      ],
    }),
    verb('worktree remove <path>', {
      summary: 'alias of fy worktree rm',
      args: [{ name: 'path', help: 'the worktree path' }],
      options: [
        { flag: '--discard-changes', help: 'accept losing uncommitted work in the worktree' },
        { flag: '--accept-unpushed', help: 'accept losing commits that exist nowhere else' },
        { flag: '--delete-unmerged', help: 'accept deleting a branch that was never merged' },
        { flag: '--delete-branch', help: 'delete the branch too instead of leaving it behind' },
        { flag: '--delete-preexisting', help: 'allow deleting a branch that existed before the worktree' },
        { flag: '-y, --yes', help: 'skip the typed confirmation; required when not on a terminal' },
        { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
      ],
    }),
    verb('worktree fork <branch>', {
      summary: 'fork a new checkout for a branch, and say where to start work in it',
      args: [{ name: 'branch', help: 'the branch to check out; created when it does not exist yet' }],
      options: [
        { flag: '--base <ref>', help: 'start a new branch at this commit-ish' },
        { flag: '--from-default', help: "start a new branch at the repository's default branch" },
        { flag: '--from-head', help: "start a new branch at the source checkout's current commit" },
        { flag: '--from <path>', help: 'the checkout to fork from; the current directory otherwise' },
        { flag: '--session <id>', help: 'the session that will own the new checkout' },
        { flag: '--project <name>', help: "file the checkout in this registered project's folder of worktrees" },
        { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
      ],
    }),
    verb('worktree add <branch>', {
      summary: 'alias of fy worktree fork',
      args: [{ name: 'branch', help: 'the branch to check out; created when it does not exist yet' }],
      options: [
        { flag: '--base <ref>', help: 'start a new branch at this commit-ish' },
        { flag: '--from-default', help: "start a new branch at the repository's default branch" },
        { flag: '--from-head', help: "start a new branch at the source checkout's current commit" },
        { flag: '--from <path>', help: 'the checkout to fork from; the current directory otherwise' },
        { flag: '--session <id>', help: 'the session that will own the new checkout' },
        { flag: '--project <name>', help: "file the checkout in this registered project's folder of worktrees" },
        { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
      ],
    }),
  ],
});
