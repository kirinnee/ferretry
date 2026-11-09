/**
 * The preview's HOLD: what is left out because it is not provably a Claude Code runtime (see `PREVIEW_CODEX_RUNTIMES`
 * in `../v5/preview-env.ts`). One owner of "which runtimes are held", so the settings, ferrets and packs steps agree.
 * Reads only the harness line of each v4 runtime file; never a value of any other key.
 */
import { isMap, isScalar } from 'yaml';
import { listV4Config, readV4Yaml } from '../v4/config.ts';
import { CODEX_HELD_SENTENCE, PREVIEW_CODEX_RUNTIMES } from '../v5/preview-env.ts';
import type { StepContext } from './index.ts';

export { CODEX_HELD_SENTENCE };

/** Whether this run holds Codex (and harness-less) runtimes and what uses them. */
export const holdsCodex = (ctx: Pick<StepContext, 'preview'>): boolean =>
  ctx.preview === true && !PREVIEW_CODEX_RUNTIMES;

/** The names of the v4 runtimes the preview holds: a runtime file whose own `harness` is not `claude`. */
export async function heldRuntimeNames(ctx: StepContext): Promise<ReadonlySet<string>> {
  const held = new Set<string>();
  if (!holdsCodex(ctx)) return held;
  for (const file of (await listV4Config(ctx.v4.home, ctx.v4.configOverrides)).files) {
    if (file.address.kind !== 'runtime') continue;
    const map = (await readV4Yaml(file)).contents;
    const harness = isMap(map) ? map.get('harness', true) : undefined;
    if (!(isScalar(harness) && harness.value === 'claude')) held.add(file.address.name);
  }
  return held;
}
