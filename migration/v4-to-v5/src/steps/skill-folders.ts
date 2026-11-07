/**
 * The skill folders a runtime install put in v4's asset tree (`fleet/assets/skills/<name>/`) → the same path in the v5
 * home, byte for byte.
 *
 * WHY THIS PATH. v5 Runtimes still reads its asset tree at `join(paths.fleet, 'assets')`
 * (`packages/plugins/runtimes/daemon/adapters/account-model-files.ts`, `skillItemsIn(…, 'skills')` in `setup-files.ts`),
 * with `fleet` = `<home>/fleet` as in v4; only the kernel root that hands it that folder is still a GAP(kernel)
 * (`runtimes/daemon/index.ts`). The kernel never refuses a folder it has not declared, so carrying the folders to the
 * path v5 will read keeps the owner's skills in the new home instead of only in the v4 backup. The Catalogs step carries
 * the install records (`state/skills/installs.json`) that name these folders, with the hash of every file they wrote.
 *
 * Files are copied byte for byte and never opened (`moveSealed`); a link is never followed or re-made (as for harness
 * folders) and is counted; an unreadable file fails the step with a `chmod u+r` remedy and its path.
 */
import { constants } from 'node:fs';
import { access, chmod, mkdir, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { moveSealed } from '../sealed.ts';
import { info } from '../v4/ferrets.ts';
import { V4InputError } from '../v4/documents.ts';
import type { Step } from './index.ts';

export const V4_SKILL_FOLDERS = 'fleet/assets/skills';
/** v5 Runtimes' `join(paths.fleet, 'assets', 'skills')`, relative to the home. */
export const V5_SKILL_FOLDERS = 'fleet/assets/skills';

export const skillFoldersStep: Step = {
  id: 'skill-folders',
  title: 'Skill folders (runtime-installed skills in the asset tree)',
  owner: ['plugin-runtimes', 'plugin-skills'],
  reads: [`${V4_SKILL_FOLDERS}/<name>/**`],
  sealed: [],
  notCarried: [
    {
      what: `links inside ${V4_SKILL_FOLDERS}`,
      why: 'never followed or re-made (a link could point anywhere on the machine); counted in the report',
    },
  ],
  async run(ctx) {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    const root = join(ctx.v4.home, V4_SKILL_FOLDERS);
    const sealed: { file: string; bytes: number }[] = [];
    let links = 0;
    let skills = 0;
    try {
      // Every ancestor must be a real folder: a link in the path could otherwise lead the copy anywhere.
      for (const folder of [ctx.v4.fleet, join(ctx.v4.fleet, 'assets'), root]) {
        const facts = await info(folder);
        if (facts === undefined) return { ...base, status: 'converted', kept: [], sealed };
        if (!facts.isDirectory())
          throw new V4InputError(`${V4_SKILL_FOLDERS}: a link or file sits in a folder's place`);
      }
      const copy = async (from: string, to: string): Promise<void> => {
        const facts = await info(from);
        if (facts === undefined) return;
        if (facts.isSymbolicLink()) {
          links++;
          return;
        }
        if (facts.isDirectory()) {
          if (!ctx.dryRun) await mkdir(ctx.v5.resolve(to), { recursive: true, mode: 0o700 });
          for (const name of (await readdir(from)).sort()) await copy(join(from, name), join(to, name));
          if (!ctx.dryRun) {
            await chmod(ctx.v5.resolve(to), facts.mode & 0o777);
            await utimes(ctx.v5.resolve(to), facts.atime, facts.mtime);
          }
          return;
        }
        if (!facts.isFile()) throw new V4InputError(`${to}: is not a file, folder or link`);
        const readable = await access(from, constants.R_OK).then(
          () => true,
          () => false,
        );
        if (!readable)
          throw new V4InputError(
            `${to}: cannot be read by this user; run \`chmod u+r\` on it in the v4 home, then again`,
          );
        if (!ctx.dryRun) await moveSealed(from, ctx.v5.resolve(to));
        sealed.push({ file: to, bytes: facts.size });
      };
      for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) {
          links++;
          continue;
        }
        if (entry.isDirectory()) skills++;
        await copy(join(root, entry.name), join(V5_SKILL_FOLDERS, entry.name));
      }
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note: error instanceof V4InputError ? error.message : `cannot copy ${V4_SKILL_FOLDERS}`,
        kept: [],
        sealed: [],
      };
    }
    return {
      ...base,
      status: 'converted',
      ...(ctx.dryRun ? { note: 'dry run: nothing written' } : {}),
      kept: [
        { what: 'skill folders', count: skills },
        { what: 'skill files copied without opening', count: sealed.length },
        ...(links > 0 ? [{ what: 'links not followed or re-made', count: links }] : []),
      ],
      sealed,
    };
  },
};
