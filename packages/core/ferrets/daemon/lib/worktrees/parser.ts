import type { WorktreeListEntry, WorktreeStatusSummary } from './types.ts';

/** Parse `git worktree list --porcelain -z` without whitespace ambiguity. */
export function parseWorktreeList(raw: string): readonly WorktreeListEntry[] {
  return raw
    .split('\0\0')
    .filter(record => record.length > 0)
    .flatMap(record => {
      const fields = new Map<string, string>();
      const flags = new Set<string>();
      for (const field of record.split('\0').filter(value => value.length > 0)) {
        const separator = field.indexOf(' ');
        if (separator < 0) flags.add(field);
        else fields.set(field.slice(0, separator), field.slice(separator + 1));
      }
      const worktreePath = fields.get('worktree');
      if (worktreePath === undefined) return [];
      const branchRef = fields.get('branch');
      return [
        {
          path: worktreePath,
          head: fields.get('HEAD'),
          branch: branchRef?.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : branchRef,
          detached: flags.has('detached'),
          bare: flags.has('bare'),
          locked: fields.get('locked') ?? (flags.has('locked') ? '' : undefined),
          prunable: fields.get('prunable') ?? (flags.has('prunable') ? '' : undefined),
        },
      ];
    });
}

/** Summarise `git status --porcelain=v2 -z` into independent safety facts. */
export function parseWorktreeStatus(raw: string, truncated = false): WorktreeStatusSummary {
  let staged = false;
  let unstaged = false;
  let untracked = false;
  let ignored = false;
  let conflicted = false;
  let dirtySubmodule = false;
  const records = raw.split('\0');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('? ')) {
      untracked = true;
      continue;
    }
    if (record.startsWith('! ')) {
      ignored = true;
      continue;
    }
    if (record.startsWith('u ')) {
      conflicted = true;
      continue;
    }
    if (!record.startsWith('1 ') && !record.startsWith('2 ')) continue;
    const fields = record.split(' ');
    const xy = fields[1] ?? '..';
    const submodule = fields[2] ?? 'N...';
    staged ||= xy[0] !== undefined && xy[0] !== '.';
    unstaged ||= xy[1] !== undefined && xy[1] !== '.';
    dirtySubmodule ||= submodule !== 'N...';
    if (record.startsWith('2 ')) index += 1;
  }

  return { staged, unstaged, untracked, ignored, conflicted, dirtySubmodule, truncated };
}
