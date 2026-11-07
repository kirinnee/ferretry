import { dirname } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { SkillSourceProblem } from '../../contract/index.ts';
import type { ReadSkillFolder, SkillFolderReader } from '../lib/installs/ports.ts';

const WALK_ENTRIES = 1_000;
const WALK_DEPTH = 16;
const FILE_MAX_BYTES = 256 * 1024;
const TOTAL_MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;

/** Files whose NAME says they hold a credential: left out whatever they hold. */
const CREDENTIAL_FILE =
  /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_rsa.*|id_ed25519.*|.*\.pem|.*\.key)$/iu;
const PATH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;

const strictText = new TextDecoder('utf-8', { fatal: true });
const textOf = (bytes: Uint8Array): string | undefined => {
  if (bytes.includes(0)) return undefined;
  try {
    return strictText.decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * A skill folder, turned into the files a copy carries, through a root handle opened ONCE on the folder the owner
 * named (`imports`). NOTHING IS SKIPPED SILENTLY: every entry the walk found is carried or listed with its reason.
 * A link is never followed out of the folder (the handle refuses it), a file that is not text, over 256 KiB, named
 * like a credential, or past the bounds is left out and said.
 */
export class RootSkillFolderReader implements SkillFolderReader {
  constructor(private readonly open: (folder: string) => RootHandle) {}

  async read(manifestPath: string, _boundary: string): Promise<ReadSkillFolder> {
    const folder = dirname(manifestPath);
    const root = this.open(folder);
    const start = root.resolve(folder);
    if (!start.ok)
      return {
        files: [],
        problems: [],
        refusal: 'The skill folder cannot be read any more. It may have been moved or deleted.',
      };
    const problems: SkillSourceProblem[] = [];
    const skip = (path: string, reason: string): void => {
      problems.push({ subject: path.slice(0, 512) || '(unnamed)', reason });
    };
    const found: { path: string; size: number }[] = [];
    let visited = 0;
    let truncated = false;
    const walk = async (relative: string, depth: number): Promise<void> => {
      const here = root.resolve(relative === '' ? folder : `${folder}/${relative}`);
      if (!here.ok) return;
      const names = await root.list(here.value).catch(() => [] as readonly string[]);
      for (const name of names) {
        if (visited >= WALK_ENTRIES) {
          truncated = true;
          return;
        }
        visited += 1;
        const path = relative === '' ? name : `${relative}/${name}`;
        const child = root.resolve(`${folder}/${path}`);
        if (!child.ok) {
          skip(path, 'a link out of the folder, or a device: never followed');
          continue;
        }
        const stat = await root.stat(child.value).catch(() => undefined);
        if (stat === undefined) {
          skip(path, 'not a regular file (a socket, a device or a pipe)');
          continue;
        }
        if (stat.kind === 'directory') {
          if (depth >= WALK_DEPTH)
            skip(path, `a folder nested deeper than ${WALK_DEPTH} levels, so nothing in it was looked at`);
          else await walk(path, depth + 1);
        } else found.push({ path, size: stat.size });
      }
    };
    await walk('', 0);

    const files: { path: string; content: string }[] = [];
    const taken = new Map<string, string>();
    let total = 0;
    for (const entry of found.toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )) {
      if (CREDENTIAL_FILE.test(entry.path.split('/').pop() ?? '')) {
        skip(
          entry.path,
          'not carried: its name says it holds a credential (a .env file, a package-manager login, a private key)',
        );
        continue;
      }
      if (!PATH_SHAPE.test(entry.path) || entry.path.split('/').some(part => part === '.git' || part === '..')) {
        skip(entry.path, 'its name is not one a skill carries (a .git folder, a space, a non-ASCII letter)');
        continue;
      }
      const earlier = taken.get(entry.path.toLowerCase());
      if (earlier !== undefined) {
        skip(entry.path, `it would be the same file as ${earlier} on a Mac or on Windows`);
        continue;
      }
      if (entry.size > FILE_MAX_BYTES) {
        skip(entry.path, `larger than ${FILE_MAX_BYTES / 1024} KiB`);
        continue;
      }
      if (files.length >= MAX_FILES) {
        skip(entry.path, `a skill carries at most ${MAX_FILES} files`);
        continue;
      }
      if (total + entry.size > TOTAL_MAX_BYTES) {
        skip(entry.path, `it would take the skill past ${TOTAL_MAX_BYTES / 1024 / 1024} MiB in total`);
        continue;
      }
      const resolved = root.resolve(`${folder}/${entry.path}`);
      const bytes = resolved.ok
        ? await root.readBytes(resolved.value as FencedPath, FILE_MAX_BYTES).catch(() => undefined)
        : undefined;
      if (bytes === undefined) {
        skip(entry.path, 'it could not be read');
        continue;
      }
      const content = textOf(bytes);
      if (content === undefined) {
        skip(entry.path, 'not text (a binary file, or not UTF-8)');
        continue;
      }
      taken.set(entry.path.toLowerCase(), entry.path);
      total += bytes.length;
      files.push({ path: entry.path, content });
    }
    if (truncated)
      problems.push({
        subject: '(the rest of the folder)',
        reason: `the folder holds more than ${WALK_ENTRIES} entries, so the rest were not looked at`,
      });
    if (!files.some(file => file.path === 'SKILL.md')) {
      const why = problems.find(problem => problem.subject === 'SKILL.md')?.reason ?? 'it is not in the folder';
      return { files, problems, refusal: `SKILL.md cannot be carried: ${why}.` };
    }
    return { files, problems };
  }
}
