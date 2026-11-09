/**
 * Writing v5 files. Every document is parsed by the v5 schema it is declared with BEFORE it is written, so the
 * converter can only produce a file the v5 reader accepts; the schemas come from the v5 contracts
 * (`@ferretry/<pkg>/contract`), never from a copy here.
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';

/**
 * The part of a v5 `defineConfig` declaration the writer needs: one file under `config/`, or a folder of
 * `<name>.yaml` items. A contract's own `ConfigDef` fits; a def declared only in a manifest is restated with the same
 * file name and the schema its contract exports.
 */
export type V5ConfigDef =
  | { readonly shape: 'file'; readonly file: string; readonly schema: z.ZodType<unknown> }
  | {
      readonly shape: 'collection';
      readonly collection: string;
      readonly name: RegExp;
      readonly schema: z.ZodType<unknown>;
    };

/** A {@link V5ConfigDef} with the id of the plugin that declares it (`data.config` of its manifest). */
export type V5ConfigTarget = V5ConfigDef & { readonly plugin: string };

/** Where a config file lands, relative to the v5 home: `config/<file>` or `config/<collection>/<name>.yaml`. */
export function configPath(target: V5ConfigTarget, name?: string): string {
  return target.shape === 'file'
    ? join('config', target.file)
    : join('config', target.collection, `${name ?? ''}.yaml`);
}

/**
 * Why v5 would refuse this text at this place, or `undefined` when it accepts it. The text is read back exactly as the
 * v5 kernel reads a config file (YAML 1.2, unique keys, an empty file is an empty mapping) and parsed with the
 * declared schema. The answer names key paths and zod issue codes only, never a value.
 */
export function v5ConfigProblem(target: V5ConfigTarget, name: string | undefined, text: string): string | undefined {
  if (target.shape === 'collection' && (name === undefined || !target.name.test(name)))
    return `the name is not a valid v5 ${target.collection} item name`;
  const document = parseDocument(text, { version: '1.2', uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) return 'the written YAML does not read back';
  const parsed = target.schema.safeParse(document.toJS() ?? {});
  if (parsed.success) return undefined;
  return parsed.error.issues
    .map(issue => `${issue.path.length === 0 ? '(top)' : issue.path.join('.')} (${issue.code})`)
    .join(', ');
}

/** The part of a v5 `defineState` / `defineConfig` declaration the writer needs. */
export interface V5FileDef<Shape> {
  /** Relative to the v5 home, e.g. `state/board/counters.json`. */
  readonly path: string;
  readonly format: number;
  readonly schema: z.ZodType<Shape>;
  /** Defaults to 0600: every v5 state file is owner-only. */
  readonly mode?: number;
}

export interface V5Writer {
  json<Shape>(def: V5FileDef<Shape>, value: Shape): Promise<void>;
  jsonl<Shape>(def: V5FileDef<Shape>, lines: readonly Shape[]): Promise<void>;
  /**
   * A document whose v5 schema describes the body WITHOUT `format` (the kernel stamps it on write and strips it on
   * read: `packages/core/kernel/host/state/format.ts`). The body is parsed by the schema, then written with
   * `"format": <def.format>` first, exactly as the kernel's own write lands it.
   */
  stamped<Shape extends object>(def: V5FileDef<Shape>, body: Shape): Promise<void>;
  /**
   * An `opaque` file whose owner reads its own exact bytes (Asks' per-ferret agenda files): written as given, 0600.
   * The caller has already checked the bytes against what the v5 reader accepts.
   */
  opaque(relativePath: string, bytes: string | Uint8Array, mode?: number): Promise<void>;
  /**
   * An owner-edited YAML config file under `config/`, 0600, written as given (comments kept). Refused unless v5
   * would accept it at that place ({@link v5ConfigProblem}); the error names the path and key paths only.
   */
  config(target: V5ConfigTarget, name: string | undefined, text: string, from?: readonly string[]): Promise<void>;
  /**
   * For every config file THIS run gave {@link V5Writer.config}: the v4 sources (labels relative to the v4 home, plus
   * the preview's own author label) its callers named, unioned over every write. A write that named none adds
   * {@link UNKNOWN_SOURCE}: the sources are then not known, and a reader must fail closed.
   */
  writtenSources(): ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The text an earlier step of THIS run gave {@link V5Writer.config} for that place (also in a dry run), or
   * `undefined`. Two steps that each own keys of one v5 file (Settings and Daemon settings both write the harness
   * and agenda files) merge through this instead of the later one overwriting the earlier one.
   */
  written(target: V5ConfigTarget, name: string | undefined): string | undefined;
  /** Every config file THIS run gave {@link V5Writer.config} (also in a dry run): its `config/…` path and text. */
  writtenConfigs(): ReadonlyMap<string, string>;
  /** Where a byte-for-byte file lands (sealed blobs, a harness's own folder). */
  resolve(relativePath: string): string;
}

/**
 * `value` with `format` as its FIRST key when it is a plain object that has one (or `stamp` is given), else unchanged.
 * The kernel reads the first key to decide a line's or document's format, so order matters here, unlike in JSON.
 */
export function formatFirst(value: unknown, stamp?: number): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!('format' in record)) return stamp === undefined ? value : { format: stamp, ...record };
  const { format, ...rest } = record;
  return { format, ...rest };
}

/** The source of a config write whose caller named none: its v4 sources are not known. */
export const UNKNOWN_SOURCE = '*';

export function v5Writer(home: string, options: { readonly dryRun: boolean }): V5Writer {
  const configs = new Map<string, string>();
  const sources = new Map<string, Set<string>>();
  const place = async (relativePath: string, text: string | Uint8Array, mode: number): Promise<void> => {
    if (options.dryRun) return;
    const target = join(home, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, text, { mode, flag: 'wx' });
    await chmod(temporary, mode);
    await rename(temporary, target);
  };
  return {
    async json(def, value) {
      // A document that carries `format` has it FIRST, as the kernel writes it (a parsed `.extend({format})` puts it
      // last). One without it is a file v5 itself keeps bare, and is written as parsed.
      const parsed = def.schema.parse(value) as unknown;
      await place(def.path, `${JSON.stringify(formatFirst(parsed), null, 2)}\n`, def.mode ?? 0o600);
    },
    async jsonl(def, lines) {
      // Every v5 JSONL line is an object whose FIRST key is `"format": <n>` (the kernel's one-format rule,
      // `packages/core/kernel/host/state/format.ts`): a line whose schema does not name `format` is stamped here, as
      // the kernel's own append stamps it, and one that does has it moved first.
      const text = lines
        .map(line => JSON.stringify(formatFirst(def.schema.parse(line) as unknown, def.format)))
        .join('\n');
      await place(def.path, lines.length === 0 ? '' : `${text}\n`, def.mode ?? 0o600);
    },
    async stamped(def, body) {
      const parsed = def.schema.parse(body) as Record<string, unknown>;
      if ('format' in parsed) throw new TypeError(`${def.path}: a stamped body names no format of its own`);
      await place(def.path, `${JSON.stringify({ format: def.format, ...parsed }, null, 2)}\n`, def.mode ?? 0o600);
    },
    async opaque(relativePath, bytes, mode = 0o600) {
      await place(relativePath, bytes, mode);
    },
    async config(target, name, text, from) {
      const path = configPath(target, name);
      const problem = v5ConfigProblem(target, name, text);
      if (problem !== undefined) throw new Error(`${path}: v5 refuses it: ${problem}`);
      configs.set(path, text);
      const known = sources.get(path) ?? new Set<string>();
      for (const source of from ?? [UNKNOWN_SOURCE]) known.add(source);
      sources.set(path, known);
      await place(path, text, 0o600);
    },
    written(target, name) {
      return configs.get(configPath(target, name));
    },
    writtenConfigs() {
      return new Map(configs);
    },
    writtenSources() {
      return new Map(sources);
    },
    resolve(relativePath) {
      return join(home, relativePath);
    },
  };
}
