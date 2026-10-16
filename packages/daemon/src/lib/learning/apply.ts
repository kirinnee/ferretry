import { createHash } from 'node:crypto';
import { LEARNING_ABSENT_FILE_ETAG } from '../../../../protocol/src/lib/learning.ts';

/**
 * APPLYING A LESSON — the exact text change, its diff, and the etag that pins it. Pure.
 *
 * A lesson is one bullet under a `## Lessons` heading. The heading is found and the bullet appended to
 * the end of that section; a file without one gets the heading at its end; an absent file is created
 * with the heading alone. Nothing else in the file moves, so the diff the owner approved is the whole
 * change.
 */

/** The heading every applied lesson lives under. */
export const LESSONS_HEADING = '## Lessons';

/** The digest an apply is pinned to: the file's content, or {@link LEARNING_ABSENT_FILE_ETAG}. */
export function lessonFileEtag(text: string | undefined): string {
  return text === undefined ? LEARNING_ABSENT_FILE_ETAG : createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** The rule as one Markdown bullet: whitespace (newlines included) collapsed. */
export function lessonBullet(rule: string): string {
  return `- ${rule.replace(/\s+/gu, ' ').trim()}`;
}

/** Whether a line starts a section at heading level one or two. */
const isSectionHeading = (line: string): boolean => /^#{1,2}\s/u.test(line);

/** `existing` with the lesson added to its `## Lessons` section. */
export function insertLesson(existing: string | undefined, rule: string): string {
  const bullet = lessonBullet(rule);
  if (existing === undefined || existing.trim() === '') return `${LESSONS_HEADING}\n\n${bullet}\n`;
  const lines = existing.replace(/\n$/u, '').split('\n');
  const heading = lines.findIndex(line => line.trim() === LESSONS_HEADING);
  if (heading < 0) return `${lines.join('\n')}\n\n${LESSONS_HEADING}\n\n${bullet}\n`;
  const next = lines.findIndex((line, index) => index > heading && isSectionHeading(line));
  const end = next < 0 ? lines.length : next;
  // After the last non-blank line of the section, so the blank line before the next heading stays.
  let last = end - 1;
  while (last > heading && (lines[last] ?? '').trim() === '') last -= 1;
  const insertAt = last === heading ? heading + 1 : last + 1;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const spacer = last === heading ? [''] : [];
  return `${[...before, ...spacer, bullet, ...after].join('\n')}\n`;
}

const CONTEXT = 3;

/** One `@@ -a,b +c,d @@` range, in unified-diff spelling. */
const range = (start: number, length: number): string =>
  length === 0 ? `${start},0` : length === 1 ? `${start + 1}` : `${start + 1},${length}`;

/**
 * A unified diff of `before` → `after` for `path`. One hunk: the changed span between the common
 * prefix and the common suffix, with three lines of context — exact for the insertions this module
 * makes, and still a truthful diff for any other change.
 */
export function unifiedDiff(path: string, before: string | undefined, after: string): string {
  const old = before === undefined || before === '' ? [] : before.replace(/\n$/u, '').split('\n');
  const now = after.replace(/\n$/u, '').split('\n');
  let prefix = 0;
  while (prefix < old.length && prefix < now.length && old[prefix] === now[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < now.length - prefix &&
    old[old.length - 1 - suffix] === now[now.length - 1 - suffix]
  )
    suffix += 1;
  const start = Math.max(0, prefix - CONTEXT);
  const oldEnd = Math.min(old.length, old.length - suffix + CONTEXT);
  const newEnd = Math.min(now.length, now.length - suffix + CONTEXT);
  const lines = [
    before === undefined ? '--- /dev/null' : `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${range(start, oldEnd - start)} +${range(start, newEnd - start)} @@`,
    ...old.slice(start, prefix).map(line => ` ${line}`),
    ...old.slice(prefix, old.length - suffix).map(line => `-${line}`),
    ...now.slice(prefix, now.length - suffix).map(line => `+${line}`),
    ...old.slice(old.length - suffix, oldEnd).map(line => ` ${line}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** The instruction files a project root may hold, and which exist. */
export interface RepoInstructionFiles {
  readonly agents: boolean;
  readonly claude: boolean;
}

/**
 * Which file a repo lesson goes into: the AGENTS.md that is there, else the CLAUDE.md that is there,
 * else the one the ferret's own CLI reads (Claude Code: CLAUDE.md; Codex: AGENTS.md).
 */
export function repoInstructionsFileName(present: RepoInstructionFiles, harness: 'claude' | 'codex'): string {
  if (present.agents) return 'AGENTS.md';
  if (present.claude) return 'CLAUDE.md';
  return harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
}
