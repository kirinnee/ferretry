/**
 * Writing v5 files. Every document is parsed by the v5 schema it is declared with BEFORE it is written, so the
 * converter can only produce a file the v5 reader accepts; the schemas come from the v5 contracts
 * (`@ferretry/<pkg>/contract`), never from a copy here.
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';

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
  /** Where a byte-for-byte file lands (sealed blobs, a harness's own folder). */
  resolve(relativePath: string): string;
}

export function v5Writer(home: string, options: { readonly dryRun: boolean }): V5Writer {
  const place = async (relativePath: string, text: string, mode: number): Promise<void> => {
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
      const parsed = def.schema.parse(value);
      await place(def.path, `${JSON.stringify(parsed, null, 2)}\n`, def.mode ?? 0o600);
    },
    async jsonl(def, lines) {
      const text = lines.map(line => JSON.stringify(def.schema.parse(line))).join('\n');
      await place(def.path, lines.length === 0 ? '' : `${text}\n`, def.mode ?? 0o600);
    },
    resolve(relativePath) {
      return join(home, relativePath);
    },
  };
}
