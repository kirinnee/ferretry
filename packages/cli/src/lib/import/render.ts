import {
  type ConversationAdoptResult,
  type ConversationImportListing,
  conversationFolder,
  type ImportableConversation,
} from '@ferretry/protocol';

/**
 * What a row says it is: its NAME, when the CLI gave it one, then the first thing they typed; an unnamed
 * conversation is the first thing they typed and the most recent, when the two differ.
 */
function previewLine(entry: ImportableConversation): string {
  if (entry.name !== undefined) return entry.preview === '' ? entry.name : `${entry.name} — ${entry.preview}`;
  return entry.latest === undefined ? entry.preview : `${entry.preview} … ${entry.latest}`;
}

/** The marks the browser draws as coloured badges, as text tags: the CLI, then the ferret that keeps it. */
function tags(entry: ImportableConversation): string {
  const ferret = entry.adoptedBy === undefined ? '' : ` [ferret ${entry.adoptedBy}]`;
  return `[${entry.harness}]${ferret}`;
}

/** A folder by its own name, a throwaway one tagged `[scratch]`. */
function folderTag(project: string): string {
  const folder = conversationFolder(project);
  if (!folder.scratch) return folder.name ?? project;
  return folder.name === undefined ? '[scratch]' : `[scratch] ${folder.name}`;
}

function formatRow(entry: ImportableConversation): string {
  const model = entry.model ?? 'unknown model';
  return `${tags(entry)}  ${entry.id}  ${entry.lastActivityAt}  ${entry.turns} turn(s)  ${model}  ${previewLine(entry)}`;
}

/**
 * The listing from `fy import conversations`, grouped by project folder: each group headed by the
 * folder's own name (or `[scratch]`) and its full path, each row tagged with its CLI and its ferret. Row order within a group
 * follows the daemon's own answer (newest first), which this CLI never re-sorts.
 */
export function renderImportListing(listing: ConversationImportListing, binaryName: string): string {
  if (listing.conversations.length === 0) {
    return `No conversations matched. Adopt one with \`${binaryName} import conversations --select <id...> --runtime <name>\`.`;
  }

  const byProject = new Map<string, ImportableConversation[]>();
  for (const entry of listing.conversations) {
    const bucket = byProject.get(entry.project) ?? [];
    bucket.push(entry);
    byProject.set(entry.project, bucket);
  }

  const lines: string[] = [];
  for (const [project, entries] of byProject) {
    lines.push(`${folderTag(project)}  ${project}:`);
    for (const entry of entries) lines.push(`  ${formatRow(entry)}`);
    lines.push('');
  }
  if (listing.matched > listing.conversations.length) {
    lines.push(
      `showing ${listing.conversations.length} of ${listing.matched} matched — narrow the search or raise --limit.`,
      '',
    );
  }
  if (listing.skipped > 0) {
    lines.push(`${listing.skipped} file(s) on this machine looked like a conversation but could not be read.`, '');
  }
  lines.push(`Adopt: ${binaryName} import conversations --select <id...> --runtime <name> [--start]`);
  return lines.join('\n').trimEnd();
}

/** What an adoption did: one line per kept conversation, one line per refusal. */
export function renderAdoptResult(result: ConversationAdoptResult): string {
  const lines: string[] = [];
  for (const item of result.adopted)
    lines.push(`adopted  ${item.id}  ${item.name}  (${item.session})  — ${item.status}`);
  for (const item of result.refused) lines.push(`refused  ${item.id}  — ${item.reason}`);
  if (lines.length === 0) lines.push('nothing to adopt');
  return lines.join('\n');
}

/** The numbered picker `fy new --continue` shows when more than one conversation matches. */
export function renderSearchMatches(rows: readonly ImportableConversation[]): string {
  return rows
    .map(
      (entry, index) =>
        `${index + 1}) ${tags(entry)}  ${folderTag(entry.project)}  ${entry.lastActivityAt}  ${previewLine(entry)}`,
    )
    .join('\n');
}

/** What `--all` / `--since` did: one summary line, then only the refusals that need a look. */
export function renderKeepResult(result: ConversationAdoptResult): string {
  const kept = result.adopted.length;
  const lines = [
    kept === 0 && result.refused.length === 0
      ? 'nothing to import'
      : `imported ${kept} conversation${kept === 1 ? '' : 's'} as stopped ferrets (hard-linked, never copied)`,
  ];
  for (const item of result.refused) lines.push(`refused  ${item.id}  — ${item.reason}`);
  return lines.join('\n');
}
