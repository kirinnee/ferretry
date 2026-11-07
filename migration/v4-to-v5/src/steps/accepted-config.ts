/**
 * The accepted record: what v4 had put into effect, carried so a loosening the owner already confirmed is not asked
 * about again (lead decision 2026-11-07: carry it).
 *
 * v4 keeps `state/config-accepted.json`, `{ "<config path>": {etag, text} }`: an entry for EVERY file it put into
 * effect, with the text it was in effect as (`fleet/src/lib/config-files/evaluate.ts`). A file is in effect AS WRITTEN
 * only when its entry's etag is the SHA-256 of its text on disk. Otherwise v4 was holding an edit (a loosening the owner
 * had not confirmed), refusing the file, or had never read it, and enforced an older text or the defaults.
 *
 * v5 keeps one document per config path under `state/kernel/accepted-config/` (`acceptedConfigFile`,
 * `acceptedName(path)`), `{etag: sha256(text), text}`. The converter's v5 files are not v4's texts, so the record cannot
 * be copied; instead, when EVERY v4 config file was in effect as written, every config file this run wrote is recorded
 * as accepted with its own text: v5 then starts with exactly what v4 enforced, confirmations included. When ANY v4
 * file was not (a held edit, an invalid file, a file v4 never accepted, a deletion still held), nothing is recorded and
 * the report names those files: v5 judges every file against its defaults and holds any loosening until the owner
 * confirms it again — the safe direction to be wrong in, never wider than v4.
 *
 * Runs LAST, after every step that writes config. Texts are hashed and written, never reported.
 */
import { acceptedConfigFile, acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { StepReport } from '../report.ts';
import { readV4Json } from '../v4/documents.ts';
import type { Step, StepContext } from './index.ts';

export const V4_CONFIG_ACCEPTED = 'state/config-accepted.json';
const V5_ACCEPTED_DIR = 'state/kernel/accepted-config';

/** The kernel's declared body for one accepted document (`{etag, text}`, strict). */
const ACCEPTED_BODY = acceptedConfigFile.schema;
if (ACCEPTED_BODY === undefined) throw new Error('the kernel declares accepted-config with no schema');

const V4AcceptedRecord = z.record(z.string(), z.strictObject({ etag: z.string().min(1), text: z.string() }));

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Every YAML file under v4's `config/` (not `.schema/`), by config-relative path; a link is listed as `null`. */
async function v4ConfigFiles(root: string): Promise<Map<string, string | null>> {
  const files = new Map<string, string | null>();
  const walk = async (folder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(folder, entry.name);
      const facts = await lstat(path);
      if (facts.isDirectory()) await walk(path);
      else if (/\.ya?ml$/u.test(entry.name))
        files.set(relative(root, path), facts.isFile() ? await readFile(path, 'utf8') : null);
    }
  };
  await walk(root);
  return files;
}

/** The v4 config files that were NOT in effect as written (by path only). */
async function notInEffect(ctx: StepContext): Promise<{ readonly paths: string[]; readonly files: number }> {
  const decoded = await readV4Json(ctx.v4.home, join(ctx.v4.home, V4_CONFIG_ACCEPTED)).catch(() => null);
  const parsed = decoded === undefined ? { success: true as const, data: {} } : V4AcceptedRecord.safeParse(decoded);
  const accepted: Record<string, { etag: string; text: string }> = parsed.success ? parsed.data : {};
  const files = await v4ConfigFiles(ctx.v4.config);
  const paths: string[] = [];
  if (!parsed.success) paths.push(V4_CONFIG_ACCEPTED);
  for (const [path, text] of files) {
    const entry = accepted[path];
    if (text === null || entry === undefined || entry.etag !== sha256(text) || entry.text !== text) paths.push(path);
  }
  // An entry whose file is gone: v4 was holding the deletion and still enforced the old text.
  for (const path of Object.keys(accepted)) if (!files.has(path)) paths.push(path);
  return { paths: [...new Set(paths)].sort(), files: files.size };
}

export const acceptedConfigStep: Step = {
  id: 'accepted-config',
  title: 'Confirmed settings (the accepted record, so a loosening already confirmed is not asked again)',
  owner: ['kernel'],
  reads: [V4_CONFIG_ACCEPTED, 'config/**/*.yaml (hashed, never reported)'],
  sealed: [],
  notCarried: [],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] };
    try {
      const configs = [...ctx.v5.writtenConfigs()].sort(([a], [b]) => a.localeCompare(b));
      const held = await notInEffect(ctx);
      if (held.paths.length > 0)
        return {
          ...base,
          status: 'converted',
          kept: [],
          notCarried: [
            {
              what: `${V4_CONFIG_ACCEPTED} (v4 was not enforcing as written: ${held.paths.join(', ')})`,
              why: 'v4 was holding an unconfirmed edit, refusing a file, or had never accepted it, so what it enforced is not the text on disk. Nothing is recorded as accepted: v5 judges every file against its defaults and holds any loosening until the owner confirms it again (never wider than v4)',
            },
          ],
        };
      for (const [path, text] of configs) {
        const name = acceptedName(relative('config', path));
        await ctx.v5.stamped(
          { path: join(V5_ACCEPTED_DIR, `${name}.json`), format: acceptedConfigFile.format, schema: ACCEPTED_BODY },
          { etag: sha256(text), text },
        );
      }
      return {
        ...base,
        status: 'converted',
        ...(ctx.dryRun ? { note: 'dry run: nothing written' } : {}),
        kept: [
          { what: 'v4 config files in effect as written', count: held.files },
          { what: 'v5 config files recorded as accepted', count: configs.length },
        ],
        notCarried: [],
      };
    } catch {
      return {
        ...base,
        status: 'failed',
        note: `the accepted record could not be carried (${V4_CONFIG_ACCEPTED} or a config file could not be read)`,
        kept: [],
        notCarried: [],
      };
    }
  },
};
