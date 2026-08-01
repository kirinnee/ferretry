/**
 * Claude's transcript path, which the daemon DECIDES rather than discovers.
 *
 * Claude Code accepts `--session-id <uuid>` and writes that session's transcript to
 * `<harness home>/projects/<sanitized cwd>/<uuid>.jsonl`. Both halves are therefore known before
 * the process starts: the daemon mints the uuid and puts it on the argv, and the directory is a
 * pure function of the working directory it also chose.
 *
 * That is the whole reason this harness needs no discovery at all. Nothing here searches, nothing
 * ranks candidates by recency, and nothing can attribute another agent's transcript to this
 * session — a second session in the same directory carries a different uuid and therefore a
 * different filename.
 */

import { join } from 'node:path';

/**
 * Claude's own project-directory encoding: every character outside `[A-Za-z0-9]` becomes `-`.
 *
 * It is lossy on purpose — `/work/repo` and `/work-repo` collide — and that is fine here because
 * the FILENAME is the identity. The directory only has to match what the harness writes.
 */
export function claudeProjectDirectory(cwd: string): string {
  return cwd.replaceAll(/[^a-zA-Z0-9]/gu, '-');
}

/** The exact file Claude will write for a session launched with this id in this directory. */
export function claudeTranscriptFile(home: string, cwd: string, harnessSessionId: string): string {
  return join(home, 'projects', claudeProjectDirectory(cwd), `${harnessSessionId}.jsonl`);
}

/** The argv Claude needs so it writes the transcript this daemon just named. */
export function claudeSessionArguments(harnessSessionId: string): readonly string[] {
  return ['--session-id', harnessSessionId];
}
