import { posix } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import {
  MAX_SKILL_FOLDER_FILES,
  type ProjectSkillFiles as CatalogProjectSkillFiles,
  type SkillFilesReading,
  SkillFolderChanged,
  type SkillFolderChange,
  type SkillFolderReading,
  SkillFolderRefused,
} from '@ferretry/plugin-catalogs/contract';
import { sha256Hex } from './sha256.ts';
import { SKILL_FILE_MAX_BYTES, SKILL_MAX_BYTES } from './skill-bounds.ts';

/** More than a skill is: a folder past either limit is refused, not read. */
const MAX_FOLDER_BYTES = 4 * 1024 * 1024;
const NEW_FILE_MODE = 0o644;
/** `.claude/skills/<name>` or `.agents/skills/<name>`: the only folders a project install touches. */
const SKILL_FOLDER = /^\.(?:claude|agents)\/skills\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const withoutTrailingSlash = (path: string): string => path.replace(/(?<=.)\/+$/u, '');

/** A path a record can name: relative, inside the folder, with no empty or dot segments. */
const insideFolder = (path: string): boolean =>
  path !== '' && !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

/**
 * A skill folder inside a project, through the kernel's `project-files` root scoped to that one project folder (Skills'
 * declared `.claude/skills/*` and `.agents/skills/*` and nothing else). The root refuses a link at any level and a file
 * with a second hard link, so an install can never write through one; this adds v4's rules on top: the project must be a
 * root the daemon already knows, the folder must be exactly `<harness folder>/skills/<name>`, anything that is not a plain
 * file or folder inside it is refused (never skipped, so an install never claims a folder it half understood), and every
 * touched path is re-hashed just before it is written or deleted (compare, then swap).
 */
export class ProjectSkillFolders implements CatalogProjectSkillFiles {
  constructor(
    private readonly roots: () => Promise<readonly string[]>,
    private readonly open: (root: string) => RootHandle,
  ) {}

  async inspect(root: string, folder: string): Promise<SkillFolderReading> {
    const held = await this.#held(root, folder);
    const exists = await this.#folderExists(held.handle, folder);
    return exists
      ? { exists: true, files: await this.#tree(held.handle, folder) }
      : { exists: false, files: new Map() };
  }

  async read(root: string, folder: string, paths: readonly string[]): Promise<SkillFilesReading> {
    const { handle } = await this.#held(root, folder);
    const files = new Map<string, string>();
    const tooLarge: string[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0;
    for (const path of new Set(paths)) {
      if (!insideFolder(path)) throw new SkillFolderRefused(`${path} is not a path inside a skill folder.`);
      const target = this.#fenced(handle, `${folder}/${path}`);
      const found = await handle.lstat(target).catch(() => undefined);
      if (found === undefined) continue;
      if (found.kind !== 'file') throw this.#notPlain(path);
      if (found.size > SKILL_FILE_MAX_BYTES || total + found.size > SKILL_MAX_BYTES) {
        tooLarge.push(path);
        continue;
      }
      const bytes = await this.#bytes(handle, target, path);
      total += bytes.byteLength;
      try {
        files.set(path, decoder.decode(bytes));
      } catch {
        tooLarge.push(path);
      }
    }
    return { files, tooLarge };
  }

  async apply(root: string, folder: string, change: SkillFolderChange): Promise<void> {
    const { handle } = await this.#held(root, folder);
    const exists = await this.#folderExists(handle, folder);
    const hashes = exists ? await this.#tree(handle, folder) : new Map<string, string>();
    for (const [path, expected] of change.expected)
      if ((hashes.get(path) ?? null) !== expected) throw new SkillFolderChanged();
    await this.#guard(() => handle.makeDirectory(this.#fenced(handle, folder), { mode: 0o755 }));
    for (const file of change.write) {
      if (!insideFolder(file.path)) throw new SkillFolderRefused(`${file.path} is not a path inside a skill folder.`);
      const directory = posix.dirname(file.path);
      if (directory !== '.')
        await this.#guard(() => handle.makeDirectory(this.#fenced(handle, `${folder}/${directory}`)));
      const target = this.#fenced(handle, `${folder}/${file.path}`);
      const present = await handle.lstat(target).catch(() => undefined);
      if (present !== undefined && present.kind !== 'file')
        throw new SkillFolderRefused(`${file.path} is not a plain file, so Ferretry will not replace it.`);
      await this.#guard(() =>
        handle.writeBytes(target, new TextEncoder().encode(file.content), { mode: NEW_FILE_MODE }),
      );
    }
    for (const path of change.remove) {
      if (!insideFolder(path)) throw new SkillFolderRefused(`${path} is not a path inside a skill folder.`);
      await this.#guard(() => handle.remove(this.#fenced(handle, `${folder}/${path}`)));
    }
    const touched = new Set(
      [...change.write.map(file => file.path), ...change.remove].map(path => posix.dirname(path)),
    );
    for (const directory of [...touched].toSorted((left, right) => right.length - left.length))
      await this.#prune(handle, folder, directory === '.' ? '' : directory);
  }

  /** The project's root handle, once the project is one the daemon knows and `folder` is a skill folder in it. */
  async #held(root: string, folder: string): Promise<{ readonly handle: RootHandle }> {
    const wanted = withoutTrailingSlash(root);
    if (!(await this.roots()).some(known => withoutTrailingSlash(known) === wanted))
      throw new SkillFolderRefused(`${root} is not a project Ferretry knows, so nothing is written there.`);
    if (!SKILL_FOLDER.test(folder))
      throw new SkillFolderRefused(
        `${folder} is not a skill folder of a project (.claude/skills/<name> or .agents/skills/<name>).`,
      );
    return { handle: this.open(wanted) };
  }

  #fenced(handle: RootHandle, relative: string): FencedPath {
    const resolved = handle.resolve(relative);
    if (!resolved.ok) throw new SkillFolderRefused(`${relative} cannot be reached: ${String(resolved.error)}`);
    return resolved.value;
  }

  /** The kernel's refusals (a link on the way, a file with a second name) are the person's sentence, never a stack. */
  async #guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SkillFolderRefused || error instanceof SkillFolderChanged) throw error;
      throw new SkillFolderRefused(
        `a path of the skill folder is a link, or not a plain file or folder, so Ferretry left it alone (${error instanceof Error ? error.message : 'refused'}).`,
      );
    }
  }

  async #folderExists(handle: RootHandle, folder: string): Promise<boolean> {
    let walked = '';
    for (const part of folder.split('/')) {
      walked = walked === '' ? part : `${walked}/${part}`;
      const found = await this.#guard(async () => await handle.lstat(this.#fenced(handle, walked)));
      if (found === undefined) return false;
      if (found.kind === 'symlink')
        throw new SkillFolderRefused(
          `${walked} is a symbolic link, and Ferretry will not follow it. Replace it with the folder itself.`,
        );
      if (found.kind !== 'directory')
        throw new SkillFolderRefused(`${walked} is not a folder, so a skill cannot go there.`);
    }
    return true;
  }

  async #tree(handle: RootHandle, folder: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    let total = 0;
    const walk = async (relative: string): Promise<void> => {
      const at = relative === '' ? folder : `${folder}/${relative}`;
      for (const entry of await this.#guard(async () => await handle.entries(this.#fenced(handle, at)))) {
        const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.kind === 'directory') {
          await walk(next);
          continue;
        }
        if (entry.kind !== 'file') throw this.#notPlain(next);
        const bytes = await this.#bytes(handle, this.#fenced(handle, `${folder}/${next}`), next);
        total += bytes.byteLength;
        if (files.size >= MAX_SKILL_FOLDER_FILES || total > MAX_FOLDER_BYTES)
          throw new SkillFolderRefused(`${folder} holds more than a skill can, so Ferretry left it alone.`);
        files.set(next, await sha256Hex(bytes));
      }
    };
    await walk('');
    return files;
  }

  async #bytes(handle: RootHandle, target: FencedPath, path: string): Promise<Uint8Array> {
    const found = await this.#guard(async () => await handle.lstat(target));
    if (found?.kind !== 'file') throw this.#notPlain(path);
    if (found.size > MAX_FOLDER_BYTES) throw new SkillFolderRefused(`${path} is larger than a skill file can be.`);
    return await this.#guard(async () => await handle.readBytes(target, MAX_FOLDER_BYTES));
  }

  /** Removes empty folders from `directory` up to and including the skill's own folder, stopping at the first that is not empty. */
  async #prune(handle: RootHandle, folder: string, directory: string): Promise<void> {
    let current = directory;
    for (;;) {
      const at = current === '' ? folder : `${folder}/${current}`;
      const target = this.#fenced(handle, at);
      if ((await handle.lstat(target).catch(() => undefined))?.kind !== 'directory') return;
      if ((await handle.list(target)).length > 0) return;
      await this.#guard(() => handle.remove(target, { onlyIfEmpty: true }));
      if (current === '') return;
      current = posix.dirname(current) === '.' ? '' : posix.dirname(current);
    }
  }

  #notPlain(path: string): SkillFolderRefused {
    return new SkillFolderRefused(
      `${path} is not a plain file (a link or a special file), so Ferretry will not read it.`,
    );
  }
}
