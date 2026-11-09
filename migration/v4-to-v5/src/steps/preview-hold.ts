/**
 * The preview's HOLD: what is left out because it is not provably a Claude Code runtime (see `PREVIEW_CODEX_RUNTIMES`
 * in `../v5/preview-env.ts`). One owner of "which runtimes are held", so the settings, ferrets and packs steps agree.
 *
 * v4 decides a runtime's harness in `runtimeHarness` (`packages/fleet/src/lib/account/scope.ts`): the runtime's own
 * `harness`, else (a login that drives both CLIs) the one its profile is scoped to, else the LOGIN's `harness`. A runtime
 * file almost never says, so the login decides, and the preview stage leaves login files out because they can hold a
 * credential. So the stage hands over one thing from each login file, through a schema that picks only that field
 * ({@link StepContext.previewLoginHarnesses}); this module never infers a harness from a runtime's NAME.
 * Reads only the harness and credential lines of each v4 runtime file; never a value of any other key.
 */
import { isMap, isScalar } from 'yaml';
import { listV4Config, readV4Yaml } from '../v4/config.ts';
import { CODEX_HELD_SENTENCE, PREVIEW_CODEX_RUNTIMES } from '../v5/preview-env.ts';
import type { StepContext } from './index.ts';

export { CODEX_HELD_SENTENCE };

/** Why a runtime of unknown harness is held: said truthfully, it is not a Codex runtime. */
export const UNKNOWN_HELD_SENTENCE = `held: its harness is unknown (its runtime file does not say, and the login that decides it is not in the preview), so it is held like a Codex runtime. ${CODEX_HELD_SENTENCE.replace(/^held: /u, 'Why Codex is held: ')}`;

/** What a runtime is, as far as the preview can prove. */
export type RuntimeHarness = 'claude-code' | 'codex' | 'unknown';

/** Why a held runtime, or what uses one, is held. */
export const heldReason = (harness: RuntimeHarness): string =>
  harness === 'unknown' ? UNKNOWN_HELD_SENTENCE : CODEX_HELD_SENTENCE;

/** Whether this run holds Codex (and harness-less) runtimes and what uses them. */
export const holdsCodex = (ctx: Pick<StepContext, 'preview'>): boolean =>
  ctx.preview === true && !PREVIEW_CODEX_RUNTIMES;

/**
 * The harness of one runtime: its own `harness` (v4 `claude`, or v5 `claude-code`, or `codex`), else the one its login
 * names in the stage's map. A login that is not in the map (unreadable, or a login with halves) leaves it unknown.
 */
export function runtimeHarnessOf(
  ctx: Pick<StepContext, 'previewLoginHarnesses'>,
  own: string | undefined,
  login: string | undefined,
): RuntimeHarness {
  if (own === 'claude' || own === 'claude-code') return 'claude-code';
  if (own === 'codex') return 'codex';
  if (own !== undefined) return 'unknown';
  const fromLogin = login === undefined ? undefined : ctx.previewLoginHarnesses?.get(login);
  return fromLogin === 'claude' ? 'claude-code' : fromLogin === 'codex' ? 'codex' : 'unknown';
}

/** The v4 runtimes the preview holds, by name, with why (`codex`, or `unknown` when nothing proves a harness). */
export async function heldRuntimes(ctx: StepContext): Promise<ReadonlyMap<string, RuntimeHarness>> {
  const held = new Map<string, RuntimeHarness>();
  if (!holdsCodex(ctx)) return held;
  for (const file of (await listV4Config(ctx.v4.home, ctx.v4.configOverrides)).files) {
    if (file.address.kind !== 'runtime') continue;
    const map = (await readV4Yaml(file)).contents;
    const scalar = (key: string): string | undefined => {
      const value = isMap(map) ? map.get(key, true) : undefined;
      return isScalar(value) && typeof value.value === 'string' ? value.value : undefined;
    };
    const harness = runtimeHarnessOf(ctx, scalar('harness'), scalar('credential'));
    if (harness !== 'claude-code') held.set(file.address.name, harness);
  }
  return held;
}
