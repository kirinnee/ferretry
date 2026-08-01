import type { FsChange, FsChanges, FsEntry, FsFileView, FsListing } from './wire.ts';

function entryFlags(entry: FsEntry): string {
  return [entry.denied ? 'denied' : '', entry.ignored ? 'ignored' : '', entry.escapes ? 'escapes' : '']
    .filter(Boolean)
    .map(flag => `[${flag}]`)
    .join(' ');
}

/** A single directory listing from the daemon-pinned session root. */
export function renderListing(listing: FsListing): string {
  const location = listing.path === '' ? '.' : listing.path;
  const header = `${listing.root}:${location}${listing.truncated === true ? ' (truncated)' : ''}`;
  if (listing.entries.length === 0) return `${header}\n  No entries.`;
  const rows = listing.entries.map(entry => {
    const marker = entry.type === 'dir' ? 'd' : entry.type === 'symlink' ? 'l' : 'f';
    const size = entry.size === undefined ? '-' : String(entry.size);
    const flags = entryFlags(entry);
    return `  ${marker}  ${size.padStart(8)}  ${entry.name}${flags === '' ? '' : `  ${flags}`}`;
  });
  return [header, ...rows].join('\n');
}

/** File content, or an explicit reason the daemon safely withheld it. */
export function renderFile(file: FsFileView): string {
  if (file.content !== undefined) return file.content;
  const reason = file.denied
    ? 'denied by the repository secrets policy'
    : file.ignored
      ? 'gitignored or not proven safe to serve'
      : file.binary
        ? 'binary'
        : file.tooLarge
          ? 'too large'
          : (file.reason ?? 'content unavailable');
  return `${file.path}: ${reason} (${file.size} bytes)${file.rev === 'head' ? ' [HEAD]' : ''}`;
}

function renderChange(change: FsChange): string {
  const source = change.from === undefined ? '' : ` ← ${change.from}`;
  const stats =
    change.additions === undefined && change.deletions === undefined
      ? ''
      : `  +${change.additions ?? 0}/-${change.deletions ?? 0}`;
  return `  ${change.status}  ${change.path}${source}${stats}`;
}

/** Git working-tree changes, without ever accepting a repository path from the caller. */
export function renderChanges(view: FsChanges): string {
  if (!view.repo) return 'The session working directory is not a Git worktree.';
  const header = `branch ${view.branch ?? '(detached)'}${view.truncated === true ? ' (truncated)' : ''}`;
  return view.changes.length === 0
    ? `${header}\n  No working-tree changes.`
    : [header, ...view.changes.map(renderChange)].join('\n');
}

/** An empty diff is a real answer and is stated rather than disappearing at the terminal. */
export function renderDiff(path: string, diff: string): string {
  return diff === '' ? `No diff for ${path}.` : diff;
}
