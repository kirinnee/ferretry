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
 * be copied. When EVERY v4 config file was in effect as written, every config file this run wrote is recorded as
 * accepted with its own text: v5 then starts with exactly what v4 enforced, confirmations included.
 *
 * When ANY v4 file was not (a held edit, an invalid file, a file v4 never accepted, a deletion still held), a v4 edit
 * that v4 still HELD stays held in v5 whatever its direction relative to v5's defaults: the v5 file carries v4's
 * CURRENT text converted (what the owner sees and may confirm), and the record carries the conversion of what v4
 * ENFORCED (v4's accepted text for each held file; a held file v4 never accepted is left out, because v4 used defaults
 * for it). The conversion is a plain dry run of the config-writing steps in which each held file READS as its accepted
 * text ({@link StepContext.dryConfigs}): an in-memory override, so no copy of any v4 file is written anywhere (a login
 * file may hold a plain key) and every other file is read from v4 itself, read-only. A login file's enforced text goes
 * through the same key rule as the live file: it is recorded only when the enforced conversion took the same keys under
 * the same names, so no record ever holds a plain key. The kernel then judges the file on disk against the enforced
 * record, as v4 did: a loosening is held and the enforced version stays in effect. A held DELETION leaves the v5 file
 * absent but the record carries the enforced text, and the kernel treats a missing file with a record as a deletion (an
 * edit to the defaults, held when it loosens). Where v4 enforced nothing for a file, no record is carried. If the record
 * of v4 is damaged (what it enforced is unknown), nothing is recorded for a held file (fail closed). If the dry conversion
 * cannot run, or a config-writing step fails in it, NO record is written for any file, the step fails (the conversion is
 * incomplete) and it never falls back to the current text.
 *
 * The files the PREVIEW itself wrote or changed (its text differs from the plain conversion's, e.g. `terminals.yaml`, the
 * `fy-preview` settings item, the forced `limits.yaml`) are recorded only when the owner ran `prepare --owner` (the flag
 * is the owner's act of accepting them; without it nothing of theirs is recorded), and only the ones with NO held v4
 * source (a held edit, or a held deletion, of any v4 file the writing step named for it). One with a held v4 source gets
 * no record of the PREVIEW's text even with the flag (the owner's "not yet" on that edit stands); it carries the record
 * of what v4 enforced instead (none when v4 enforced nothing), so the kernel holds the preview's text where it loosens it.
 *
 * Runs LAST, after every step that writes config. Texts are hashed and written, never reported.
 */
import { acceptedConfigFile, acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { KeptItem, StepReport } from '../report.ts';
import { classifyV4ConfigPath, V4_SINGLETONS, YAML_OPTIONS } from '../v4/config.ts';
import { readV4Json } from '../v4/documents.ts';
import { configOwner } from '../v5/targets.ts';
import { UNKNOWN_SOURCE } from '../v5/write.ts';
import type { Step, StepContext } from './index.ts';
import { PREVIEW_AUTHOR } from './settings.ts';

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

/** The report item that names the preview-authored config files NOT accepted even with `--owner` (a held v4 source). */
const HELD_PREFIX = 'preview-authored config files NOT accepted (a v4 source has an unconfirmed edit): ';

/** The preview-authored config files the report names as held (`previewHeldFiles`'s counterpart of the authored list). */
export function previewHeldFiles(steps: readonly StepReport[]): readonly string[] {
  const item = steps.find(step => step.id === 'accepted-config')?.kept.find(kept => kept.what.startsWith(HELD_PREFIX));
  return item === undefined ? [] : item.what.slice(HELD_PREFIX.length).split(', ');
}

/** The report item that names each v4 file not in effect as written, with its kind (paths only). */
const V4_HELD_PREFIX = 'v4 config files not in effect as written: ';

/** Those v4 files, each `config/<path> (<kind>)`, as the report names them. */
export function v4HeldFiles(steps: readonly StepReport[]): readonly string[] {
  const item = steps
    .find(step => step.id === 'accepted-config')
    ?.kept.find(kept => kept.what.startsWith(V4_HELD_PREFIX));
  return item === undefined ? [] : item.what.slice(V4_HELD_PREFIX.length).split(', ');
}

/**
 * Whether a v4 file the target came from was held (not in effect as written). The sources are the v4 files the writing
 * step named for the target (`V5Writer.writtenSources`), not a map kept here. A target with no v4 source (the preview
 * wrote it whole) has none held. Unknown sources count as held whenever anything was held (fail closed). A held v4
 * DELETION counts too: a deleted file is never read, so it is in no source set, and a held deletion holds every target
 * that has any v4 source at all (fail closed).
 */
const sourceHeld = (ctx: StepContext, path: string, state: V4State): boolean => {
  const sources = ctx.v5.writtenSources().get(path);
  if (sources === undefined || sources.has(UNKNOWN_SOURCE)) return state.paths.length > 0;
  if (state.deleted.length > 0 && [...sources].some(source => source !== PREVIEW_AUTHOR)) return true;
  return state.paths.some(file => sources.has(`config/${file}`) || sources.has(file));
};

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * v4's `fy config confirm` list, ported from `evaluateConfigFiles` (`packages/fleet/src/lib/config-files/evaluate.ts`):
 * a file whose etag moved from its accepted entry waits ONLY when it LOOSENS, and a file that is gone waits ONLY when
 * deleting it loosens. v4 applies every other edit at once and rewrites its record on that load, so an edit that is not
 * pending is in effect as written. What loosens (`configLoosening`, `loginLoosening`, `runtimeLoosening`):
 * - a login: a budget limit dropped, removed, raised, or the login file gone while it had a budget;
 * - a runtime: moved off, or removed from, a login whose budget was in effect;
 * - a singleton: any value that moves toward more spend or control. GAP(migration): the singleton schemas and their
 *   defaults are v4 code this tool does not copy, so ANY change in a singleton's values counts (comments and key order
 *   do not), a superset of v4's list that only ever holds more, never less;
 * - every other file (profile, component, preset, model catalog): never.
 */
const BUDGET_PERIODS = ['daily', 'weekly'] as const;
const BUDGET_LEVELS = ['trigger', 'hard'] as const;

const asMap = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** A YAML text as plain data (an empty file is an empty mapping, as v4 read it), or `undefined` when it does not parse. */
function plain(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = parse(text, YAML_OPTIONS);
    return value === null || value === undefined ? {} : asMap(value);
  } catch {
    return undefined;
  }
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    const map = asMap(item);
    return map === undefined ? item : Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)));
  });

/** `loginLoosening`: a budget limit that goes away or goes up (`after` absent: the login file is gone). */
function loginLoosens(before: Record<string, unknown>, after: Record<string, unknown> | undefined): boolean {
  const budget = (login: Record<string, unknown> | undefined, period: string, level: string): unknown =>
    asMap(asMap(login?.budget)?.[period])?.[level];
  return BUDGET_PERIODS.some(period =>
    BUDGET_LEVELS.some(level => {
      const was = budget(before, period, level);
      if (was === undefined) return false;
      const now = budget(after, period, level);
      return now === undefined || (typeof was === 'number' && typeof now === 'number' && now > was);
    }),
  );
}

type V4Address = NonNullable<ReturnType<typeof classifyV4ConfigPath>>;

/** Whether the edit from `previous` (its accepted text) to `current` (absent: the file is gone) waits for the owner. */
function loosens(
  address: V4Address,
  previous: string | undefined,
  current: string | undefined,
  budgeted: ReadonlySet<string>,
): boolean {
  const before = previous === undefined ? undefined : plain(previous);
  const after = current === undefined ? undefined : plain(current);
  if (address.kind === 'login') return before !== undefined && loginLoosens(before, after);
  if (address.kind === 'runtime') {
    const was = before?.credential;
    return typeof was === 'string' && budgeted.has(was) && (after === undefined || after.credential !== was);
  }
  if (address.kind in V4_SINGLETONS) return canonical(before ?? {}) !== canonical(after ?? {});
  return false;
}

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

interface V4State {
  /** The v4 config files that were NOT in effect as written (by path only). */
  readonly paths: string[];
  readonly files: number;
  /** v4's accepted record (what it enforced), by config-relative path. Empty when it is absent or damaged. */
  readonly accepted: Readonly<Record<string, { etag: string; text: string }>>;
  /** False when the record is damaged: what v4 enforced is then unknown. */
  readonly readable: boolean;
  /** Every v4 config file on disk, by config-relative path (`null`: a link, never read). */
  readonly onDisk: ReadonlyMap<string, string | null>;
  /** The held paths whose file is gone (a held deletion). */
  readonly deleted: string[];
  /** Each held v4 file by path and kind, for the report (never a text). */
  readonly named: string[];
}

type HeldKind = 'edit' | 'deletion' | 'unread';
const KIND_WORDS: Record<HeldKind, string> = {
  edit: 'an unconfirmed edit',
  deletion: 'a held deletion',
  unread: 'not read: a link or a file that does not parse',
};

async function notInEffect(ctx: StepContext): Promise<V4State> {
  const decoded = await readV4Json(ctx.v4.home, join(ctx.v4.home, V4_CONFIG_ACCEPTED)).catch(() => null);
  const parsed = decoded === undefined ? { success: true as const, data: {} } : V4AcceptedRecord.safeParse(decoded);
  const accepted: Record<string, { etag: string; text: string }> = parsed.success ? parsed.data : {};
  const files = await v4ConfigFiles(ctx.v4.config);
  const paths: string[] = [];
  const deleted: string[] = [];
  const named: string[] = [];
  const hold = (path: string, kind: HeldKind): void => {
    paths.push(path);
    named.push(`config/${path} (${KIND_WORDS[kind]})`);
    if (kind === 'deletion') deleted.push(path);
  };
  if (!parsed.success) {
    paths.push(V4_CONFIG_ACCEPTED);
    named.push(`${V4_CONFIG_ACCEPTED} (damaged)`);
  }
  // A login whose budget was in effect: the runtimes on it may not leave it unconfirmed (`runtimeLoosening`).
  const budgeted = new Set(
    Object.entries(accepted).flatMap(([path, entry]) => {
      const login = /^logins\/([^/]+)\.yaml$/u.exec(path)?.[1];
      return login !== undefined && plain(entry.text)?.budget !== undefined ? [login] : [];
    }),
  );
  for (const [path, text] of files) {
    const address = classifyV4ConfigPath(path);
    // v4 never reads a path it cannot classify: it is in no list.
    if (address === undefined) continue;
    const entry = accepted[path];
    if (text !== null && entry?.etag === sha256(text)) continue;
    // A link, or a file that does not parse: v4 keeps the last good version in effect (an issue, not a held edit).
    if (text === null || plain(text) === undefined) {
      if (entry !== undefined) hold(path, 'unread');
      continue;
    }
    if (loosens(address, entry?.text, text, budgeted)) hold(path, 'edit');
  }
  // An entry whose file is gone waits only when deleting it loosens; any other deletion v4 applied at once. The
  // preview leaves `config/logins` out on purpose (the owner adds logins fresh), so a login entry is not a deletion there.
  for (const [path, entry] of Object.entries(accepted)) {
    if (files.has(path)) continue;
    const address = classifyV4ConfigPath(path);
    if (address === undefined || (ctx.preview === true && address.kind === 'login')) continue;
    if (loosens(address, entry.text, undefined, budgeted)) hold(path, 'deletion');
  }
  return {
    paths: [...new Set(paths)].sort(),
    named: [...new Set(named)].sort(),
    files: files.size,
    accepted,
    readable: parsed.success,
    onDisk: files,
    deleted,
  };
}

/** What v4 ENFORCED, converted (see {@link enforcedConfigs}). */
type Enforced =
  /** v4's record is damaged: what it enforced is unknown, so nothing is recorded for a held file (the old rule). */
  | { readonly kind: 'unknown' }
  /** The conversion could not run, or a config-writing step failed in it: the step fails closed (see the header). */
  | { readonly kind: 'failed'; readonly why: string }
  | {
      readonly kind: 'ok';
      readonly configs: ReadonlyMap<string, string>;
      readonly fingerprint: (login: string) => string;
    };

/**
 * What v4 ENFORCED, converted: the plain dry conversion of the v4 home in which every held file READS as v4's accepted
 * text for it (a held deletion's file comes back; a held file v4 never accepted reads as absent, because v4 used the
 * defaults for it). The override is a map held in memory ({@link V4Paths.configOverrides}): no copy of any v4 file is
 * written anywhere, every other file is read from v4 itself, read-only. Never falls back to the current text.
 */
async function enforcedConfigs(ctx: StepContext, state: V4State): Promise<Enforced> {
  if (!state.readable) return { kind: 'unknown' };
  if (ctx.dryConfigs === undefined)
    return { kind: 'failed', why: 'the conversion of what v4 enforced is not available' };
  const overrides = new Map<string, string | null>();
  for (const path of state.paths) overrides.set(`config/${path}`, state.accepted[path]?.text ?? null);
  try {
    const result = await ctx.dryConfigs(overrides);
    if (result.failed.length > 0)
      return {
        kind: 'failed',
        why: `the conversion of what v4 enforced failed in: ${result.failedWhy.join('; ')}`,
      };
    return { kind: 'ok', configs: result.configs, fingerprint: result.fingerprint };
  } catch {
    return { kind: 'failed', why: 'the conversion of what v4 enforced could not run' };
  }
}

/** The login a `config/logins/<id>.yaml` path names, or `undefined` for any other path. */
const loginOf = (path: string): string | undefined => /^config\/logins\/([^/]+)\.yaml$/u.exec(path)?.[1];

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
        enforced = false,
      ): Promise<{ readonly recorded: number; readonly unowned: readonly string[] }> => {
        let recorded = 0;
        const unowned: string[] = [];
        for (const [path, text] of entries) {
          // An enforced text is the PLAIN conversion of what v4 enforced: never a preview-authored one.
          if (!enforced && isPreviewAuthored(ctx, path, text) && !ownerRan) continue;
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
        // Also held: a file v4's ENFORCED conversion writes differently from the plain conversion of what v4 has now,
        // so a held v4 file (a deletion included) feeds it even though no step named that file as a source.
        const enforced = await enforcedConfigs(ctx, held);
        // The conversion of what v4 enforced could not be made: nothing is recorded for ANY file it would have
        // produced (never the current text instead), and the conversion is incomplete, so v5 does not start on it.
        if (enforced.kind === 'failed')
          return {
            ...base,
            status: 'failed',
            note: `${enforced.why}; v4 was not enforcing as written (${held.named.join(', ')}), so no accepted record was written for any file and the conversion is incomplete (it never falls back to the current text). Fix what the failure above names (when it is one of those v4 files, confirm it in v4 instead), then run again`,
            kept: [],
            notCarried: [],
          };
        const enforcedConfigsMap = enforced.kind === 'ok' ? enforced.configs : undefined;
        const heldSource = authored.filter(
          path =>
            sourceHeld(ctx, path, held) ||
            (enforcedConfigsMap?.has(path) === true && enforcedConfigsMap.get(path) !== ctx.plainConfigs?.get(path)),
        );
        const own = await record(configs.filter(([path]) => authored.includes(path) && !heldSource.includes(path)));
        // A login file's enforced text holds `${secret:NAME}` where the live file does. It is recorded only when the
        // enforced conversion took the SAME keys out of it under the SAME names as the live one (a comparison of digests);
        // otherwise v4 enforced another key than the vault now holds, and no record is written for it (held).
        const loginHeld: string[] = [];
        // Everything else carries what v4 ENFORCED, so a held edit stays held whatever its direction (see the header).
        const carried =
          enforced.kind !== 'ok'
            ? { recorded: 0, unowned: [] as readonly string[] }
            : await record(
                [...enforced.configs]
                  .filter(([path]) => !authored.includes(path) || heldSource.includes(path))
                  .filter(([path]) => {
                    const login = loginOf(path);
                    if (
                      login === undefined ||
                      enforced.fingerprint(login) === (ctx.loginKeys?.fingerprint(login) ?? '')
                    )
                      return true;
                    loginHeld.push(path);
                    return false;
                  })
                  .sort(([a], [b]) => a.localeCompare(b)),
                true,
              );
        return {
          ...base,
          status: 'converted',
          kept: [
            ...named,
            { what: `${V4_HELD_PREFIX}${held.named.join(', ')}`, count: held.named.length },
            ...(ownerRan && heldSource.length > 0
              ? [{ what: `${HELD_PREFIX}${heldSource.join(', ')}`, count: heldSource.length }]
              : []),
            ...(own.recorded === 0
              ? []
              : [{ what: "the preview's own config files recorded as accepted", count: own.recorded }]),
            ...(carried.recorded === 0
              ? []
              : [
                  {
                    what: 'v5 config files recorded as what v4 enforced (held edits stay held)',
                    count: carried.recorded,
                  },
                ]),
          ],
          notCarried: [
            ...(ownerRan
              ? heldSource.map(path => ({
                  what: `${path} (the preview's forced setting, NOT accepted even with --owner)`,
                  why: `a v4 file it comes from has an unconfirmed edit or a held deletion (${held.named.join(', ')}), so the preview's text is not recorded as accepted. The record carries what v4 enforced for it instead (none when v4 enforced nothing, then the kernel judges it against its defaults), so the kernel holds the preview's text wherever it loosens that; a file that can loosen nothing (runtimes.yaml) is in effect anyway. To fix: confirm the edit in v4 first, then \`preview.sh clean\` and \`preview.sh prepare --owner\``,
                }))
              : []),
            ...(carried.unowned.length === 0
              ? []
              : [
                  {
                    what: `no accepted record for ${carried.unowned.join(', ')}`,
                    why: 'no v5 plugin declares a config def for the path, so the kernel could not read a record for it: the file stays held until the owner confirms it',
                  },
                ]),
            ...(loginHeld.length === 0
              ? []
              : [
                  {
                    what: `no accepted record for ${loginHeld.join(', ')}`,
                    why: 'the file v4 enforced would name a different secret than the live one (a different value, a different name, or none), and a record never holds a plain key: the file stays held until the owner confirms it',
                  },
                ]),
            {
              what: `${V4_CONFIG_ACCEPTED} (v4 was not enforcing as written: ${held.named.join(', ')})`,
              why:
                enforced.kind === 'unknown'
                  ? "v4 was holding an unconfirmed edit, refusing a file, or had never accepted it, and what it enforced could not be converted (its record is damaged or the conversion was not available). Nothing is recorded as accepted (the preview's own files excepted): v5 judges every file against its defaults and holds any loosening until the owner confirms it again"
                  : "v4 was holding an unconfirmed edit, refusing a file, or had never accepted it. The v5 file carries v4's current text; the accepted record carries the conversion of what v4 ENFORCED, so v5 holds the difference until the owner confirms it (never wider than v4). A file v4 never accepted has no record: v4 used the defaults for it",
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
