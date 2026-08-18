import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  HarnessDocumentRead,
  HarnessHomeDocuments,
  HarnessHomeLayout,
} from '../../lib/fleet/harness-discovery.ts';

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Reading a harness's own home, read-only and bounded.
 *
 * THE SIZE IS CHECKED BEFORE THE BYTES ARE TAKEN. A ceiling applied after the read is not a ceiling:
 * a person with a gigabyte where their instructions used to be would have the daemon allocate it
 * before anything refused. So `stat` decides first, and a document over the bound is reported with its
 * size rather than read at all — never truncated, because half an instructions file that looks whole
 * is the one outcome nobody would catch.
 *
 * A path that is not a regular file is `unreadable` rather than `absent`. A directory named
 * `CLAUDE.md`, or a FIFO left where one used to be, is a real thing somebody has to look at; calling
 * it "not found" would send them looking for a file that is right there.
 */
export class NodeHarnessHomeDocuments implements HarnessHomeDocuments {
  async read(path: string, maxBytes: number): Promise<HarnessDocumentRead> {
    let information: Stats;
    try {
      // `stat`, not `lstat`: a harness home is somebody's own directory and a symlinked settings file
      // is an ordinary way to keep one under version control. Nothing here is written, so following
      // the link grants no authority — this read is disclosure of a file the caller already governs.
      information = await stat(path);
    } catch (error) {
      return missing(error) ? { kind: 'absent' } : { kind: 'unreadable', reason: reason(error) };
    }
    if (!information.isFile()) return { kind: 'unreadable', reason: 'that path is not a regular file' };
    if (information.size > maxBytes) return { kind: 'too-large', bytes: information.size };
    try {
      const text = await Bun.file(path).text();
      // The size that travels is the TEXT's own byte length rather than the one `stat` reported: the
      // file can have changed between the two calls, and the number beside the offered text has to
      // describe the text actually being offered.
      return { kind: 'text', text, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (error) {
      return { kind: 'unreadable', reason: reason(error) };
    }
  }
}

/**
 * The two real harness layouts on this host.
 *
 * Claude Code keeps `settings.json` and `CLAUDE.md` under `~/.claude`; Codex keeps `config.toml` and
 * `AGENTS.md` under `~/.codex`. Named HERE and nowhere else, exactly as `foreignHistoryRoots` names
 * the same two homes for the history importer: a test drives fixture directories and never a real
 * home, and the discovery module itself has no opinion about where anybody keeps their files.
 */
export function harnessHomeLayouts(home: string = homedir()): readonly HarnessHomeLayout[] {
  return [
    {
      kind: 'claude',
      settingsPath: join(home, '.claude', 'settings.json'),
      settingsFormat: 'json',
      instructionsPath: join(home, '.claude', 'CLAUDE.md'),
      instructionsName: 'CLAUDE.md',
    },
    {
      kind: 'codex',
      settingsPath: join(home, '.codex', 'config.toml'),
      settingsFormat: 'toml',
      instructionsPath: join(home, '.codex', 'AGENTS.md'),
      instructionsName: 'AGENTS.md',
    },
  ];
}
