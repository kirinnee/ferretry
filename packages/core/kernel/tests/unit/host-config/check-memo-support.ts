/**
 * What `check-memo.test.ts` (unit: the memo holds only what a load settled, a patch parses once) and
 * `tests/perf/host-config/check-memo-bound.test.ts` (perf: the heap at 2 000 refused writes, the patch's cost) share.
 * This file reads no clock and no counter: what is measured is the perf test's.
 */
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { type ConfigCheckMemo, createConfigCheckMemo } from '../../../host/config/check-memo.ts';
import type { checkConfigText } from '../../../host/config/check.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import type { HostFs } from '../../../host/state/host-fs.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, loginsDef, manualClock } from './support.ts';

export type Checked = ReturnType<typeof checkConfigText>;

export const VOICE = `${HOME}/config/voice.yaml`;

export const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), note: z.unknown().optional() }),
  axis: 'configure',
  loosens: () => [],
});

/** A memo that records every check it is asked to keep, so a test can inspect all it ever held. */
function spyMemo(): ConfigCheckMemo & { readonly kept: { path: string; digest: string; checked: Checked }[] } {
  const inner = createConfigCheckMemo();
  const kept: { path: string; digest: string; checked: Checked }[] = [];
  return {
    kept,
    get: (path, key) => inner.get(path, key),
    keep: (path, key, checked) => {
      kept.push({ path, digest: key, checked });
      inner.keep(path, key, checked);
    },
    keepOnly: present => inner.keepOnly(present),
    size: () => inner.size(),
  };
}

export function world(options: { fs?: HostFs & { seed(path: string, data: string): void } } = {}) {
  const fs = options.fs ?? createMemoryHostFs();
  const checks = spyMemo();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    checks,
    defs: [
      { plugin: 'voice', def: voiceDef },
      { plugin: 'logins', def: loginsDef },
    ],
  });
  return { fs, files, checks };
}

/** Refused writes of a text that fails its schema, under `count` new names; each returns the write's outcome kind. */
export async function refuseWrites(
  files: ReturnType<typeof world>['files'],
  names: readonly number[],
  noteBytes: number,
): Promise<string[]> {
  const writer = files.writer();
  const kinds: string[] = [];
  for (const n of names) {
    const outcome = await writer.write(
      { plugin: 'logins', def: loginsDef, name: `n${String(n)}` },
      // An unknown key and a wrong type.
      `budget: "${String(n)}"\nnote: ${'x'.repeat(noteBytes)}\n`,
      { byAgent: true },
    );
    kinds.push(outcome.kind);
  }
  return kinds;
}

/** Hand-written files an edit replaces whole: not YAML, a key twice, over the cap, each filled to about `size` bytes. */
export function brokenTexts(size: number): readonly (readonly [label: string, text: string])[] {
  return [
    ['quote soup', `limit: 7\n${'" : \' '.repeat(Math.floor((size - 10) / 6))}`],
    ['broken lines', `limit: 7\n${'"\n'.repeat(Math.floor((size - 10) / 2))}`],
    ['a key twice', 'limit: 7\nlimit: 8\n'],
    ['over the cap', `limit: 7\n${'#'.repeat(size)}`],
  ];
}
