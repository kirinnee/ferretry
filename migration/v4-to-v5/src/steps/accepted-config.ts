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
 * `acceptedName(path)`), `{etag: sha256(text), text, plugin}`, where `plugin` is the plugin whose def owns the path
 * (the kernel reads a record only for the plugin it names; a path no def owns is not recorded and stays held). The converter's v5 files are not v4's texts, so the record cannot
 * be copied; instead, when EVERY v4 config file was in effect as written, every config file this run wrote is recorded
 * as accepted with its own text: v5 then starts with exactly what v4 enforced, confirmations included. When ANY v4
 * file was not (a held edit, an invalid file, a file v4 never accepted, a deletion still held), nothing is recorded and
 * the report names those files: v5 judges every file against its defaults and holds any loosening until the owner
 * confirms it again — the safe direction to be wrong in, never wider than v4. The one exception is the files the
 * PREVIEW itself wrote or changed (its text differs from the plain conversion's, e.g. `terminals.yaml`, the `fy-preview`
 * settings item, the forced `limits.yaml`), and only the ones with NO held v4 source: they are recorded either way, but
 * ONLY when the owner ran `prepare --owner` (the flag is the owner's act of accepting them; without it nothing of theirs
 * is recorded). A preview-changed file whose v4 source files (the ones the writing step named for it) include a held
 * one gets no record even with the flag: the owner's "not yet" on that edit stands, and the preview runs with the
 * kernel's last good or default for it.
 *
 * Runs LAST, after every step that writes config. Texts are hashed and written, never reported.
 */
import { acceptedConfigFile, acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { KeptItem, StepReport } from '../report.ts';
import { readV4Json } from '../v4/documents.ts';
import { configOwner } from '../v5/targets.ts';
import { UNKNOWN_SOURCE } from '../v5/write.ts';
import type { Step, StepContext } from './index.ts';

export const V4_CONFIG_ACCEPTED = 'state/config-accepted.json';
const V5_ACCEPTED_DIR = 'state/kernel/accepted-config';

/** The kernel's declared body for one accepted document (`{etag, text, plugin?}`, strict). */
const ACCEPTED_BODY = acceptedConfigFile.schema;
if (ACCEPTED_BODY === undefined) throw new Error('the kernel declares accepted-config with no schema');

const V4AcceptedRecord = z.record(z.string(), z.strictObject({ etag: z.string().min(1), text: z.string() }));

/**
 * A file whose text the PREVIEW wrote or changed: in a preview run, its text differs from what the plain, non-preview
 * conversion of the same v4 home writes (or the plain conversion writes no such file). Derived from the two
 * conversions ({@link StepContext.plainConfigs}), never from a list. Without that comparison (absent) every file counts
 * as authored, the safe direction. A preview-authored file is recorded only when the owner ran `prepare --owner`.
 */
const isPreviewAuthored = (ctx: StepContext, path: string, text: string): boolean =>
  ctx.preview === true && ctx.plainConfigs?.get(path) !== text;

/** The report item that names every preview-authored config file of this run (`previewAuthoredFiles` reads it back). */
const AUTHORED_PREFIX = 'preview-authored config files: ';

/** The preview-authored config files a conversion report names (computed by the accepted-config step, never listed by hand). */
export function previewAuthoredFiles(steps: readonly StepReport[]): readonly string[] {
  const item = steps
    .find(step => step.id === 'accepted-config')
    ?.kept.find(kept => kept.what.startsWith(AUTHORED_PREFIX));
  return item === undefined ? [] : item.what.slice(AUTHORED_PREFIX.length).split(', ');
}

/**
 * Whether a v4 file the target came from was held (not in effect as written). The sources are the v4 files the writing
 * step named for the target (`V5Writer.writtenSources`), not a map kept here. A target with no v4 source (the preview
 * wrote it whole) has none held. Unknown sources count as held whenever anything was held (fail closed).
 */
const sourceHeld = (ctx: StepContext, path: string, held: readonly string[]): boolean => {
  const sources = ctx.v5.writtenSources().get(path);
  if (sources === undefined || sources.has(UNKNOWN_SOURCE)) return held.length > 0;
  return held.some(file => sources.has(`config/${file}`) || sources.has(file));
};

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
      // Only when the OWNER ran `prepare --owner`: accepting the preview's own files is the owner's act, never an agent's.
      const ownerRan = ctx.preview === true && ctx.previewOwner === true;
      /**
       * Records each entry for the plugin whose def owns its path. A preview-authored path is never recorded without
       * the owner's flag, and a path no def owns is dropped (that file stays held). Returns what was recorded and
       * what no def owned.
       */
      const record = async (
        entries: readonly (readonly [string, string])[],
      ): Promise<{ readonly recorded: number; readonly unowned: readonly string[] }> => {
        let recorded = 0;
        const unowned: string[] = [];
        for (const [path, text] of entries) {
          if (isPreviewAuthored(ctx, path, text) && !ownerRan) continue;
          const plugin = configOwner(path);
          if (plugin === undefined) {
            unowned.push(path);
            continue;
          }
          const name = acceptedName(relative('config', path));
          await ctx.v5.stamped(
            { path: join(V5_ACCEPTED_DIR, `${name}.json`), format: acceptedConfigFile.format, schema: ACCEPTED_BODY },
            { etag: sha256(text), text, plugin },
          );
          recorded += 1;
        }
        return { recorded, unowned };
      };
      const held = await notInEffect(ctx);
      const authored = configs.filter(([path, text]) => isPreviewAuthored(ctx, path, text)).map(([path]) => path);
      const named: KeptItem[] =
        authored.length === 0 ? [] : [{ what: `${AUTHORED_PREFIX}${authored.join(', ')}`, count: authored.length }];
      if (held.paths.length > 0) {
        // A preview-authored file with NO v4 source (the preview wrote it whole) is the owner's act (the owner runs
        // `prepare --owner`), recorded whatever v4's record says: a held terminals.yaml would open every terminal with only
        // {PATH, HOME} and reach v4's `fy`. One that carries a held v4 file's text stays held even with the flag: the
        // owner's "not yet" on that edit stands.
        const heldSource = authored.filter(path => sourceHeld(ctx, path, held.paths));
        const own = await record(configs.filter(([path]) => authored.includes(path) && !heldSource.includes(path)));
        return {
          ...base,
          status: 'converted',
          kept: [
            ...named,
            ...(own.recorded === 0
              ? []
              : [{ what: "the preview's own config files recorded as accepted", count: own.recorded }]),
          ],
          notCarried: [
            ...(ownerRan
              ? heldSource.map(path => ({
                  what: `${path} (the preview's forced setting, NOT accepted even with --owner)`,
                  why: `v4 had an unconfirmed edit in a v4 file it comes from (${held.paths.join(', ')}), so the preview's text stays held and the preview runs with the kernel's last good or default for it (for limits.yaml: tighter limits). To fix: confirm it in v4 first, then \`preview.sh clean\` and \`preview.sh prepare --owner\``,
                }))
              : []),
            {
              what: `${V4_CONFIG_ACCEPTED} (v4 was not enforcing as written: ${held.paths.join(', ')})`,
              why: "v4 was holding an unconfirmed edit, refusing a file, or had never accepted it, so what it enforced is not the text on disk. Nothing is recorded as accepted (the preview's own files excepted): v5 judges every file against its defaults and holds any loosening until the owner confirms it again (never wider than v4)",
            },
          ],
        };
      }
      const all = await record(configs);
      return {
        ...base,
        status: 'converted',
        ...(ctx.dryRun ? { note: 'dry run: nothing written' } : {}),
        kept: [
          { what: 'v4 config files in effect as written', count: held.files },
          { what: 'v5 config files recorded as accepted', count: all.recorded },
          ...named,
        ],
        notCarried:
          all.unowned.length === 0
            ? []
            : [
                {
                  what: `no accepted record for ${all.unowned.join(', ')}`,
                  why: 'no v5 plugin declares a config def for the path, so the kernel could not read a record for it: the file stays held until the owner confirms it',
                },
              ],
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
