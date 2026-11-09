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
import { isMap, isScalar, isSeq } from 'yaml';
import { listV4Config, readV4Yaml } from '../v4/config.ts';
import { CODEX_HELD_SENTENCE, PREVIEW_CODEX_RUNTIMES } from '../v5/preview-env.ts';
import type { StepContext } from './index.ts';

export { CODEX_HELD_SENTENCE };

/** Why a runtime of unknown harness is held: said truthfully, it is not a Codex runtime. */
export const UNKNOWN_HELD_SENTENCE = `held: its harness is unknown (its runtime file does not say, and the login that decides it is not in the preview), so it is held like a Codex runtime. ${CODEX_HELD_SENTENCE.replace(/^held: /u, 'Why Codex is held: ')}`;

/** Why a runtime on a login that drives both CLIs is held when its profile does not say which one it runs. */
export const BOTH_HELD_SENTENCE = `held: its login drives both CLIs and its profile does not say which one it runs, so its harness is unknown and it is held like a Codex runtime. ${CODEX_HELD_SENTENCE.replace(/^held: /u, 'Why Codex is held: ')}`;

/** What the stage knows of one v4 login: its harness, and whether it drives both CLIs (halves for both). */
export interface LoginHarness {
  readonly harness: 'claude' | 'codex';
  readonly both: boolean;
}

/** What a runtime is, as far as the preview can prove. `both`: a two-CLI login whose profile does not decide. */
export type RuntimeHarness = 'claude-code' | 'codex' | 'unknown' | 'both';

/** Why a held runtime, or what uses one, is held. */
export const heldReason = (harness: RuntimeHarness): string =>
  harness === 'unknown' ? UNKNOWN_HELD_SENTENCE : harness === 'both' ? BOTH_HELD_SENTENCE : CODEX_HELD_SENTENCE;

/** A profile's scope as v4 derives it (`profileScope`): the one CLI its layers are for, or `undefined` when they do not decide. */
export type ProfileScopes = ReadonlyMap<string, 'claude' | 'codex' | undefined>;

/**
 * v4's `profileScope` for every profile file: a layer is a component (its own `harness`, else generic) or a base
 * profile (folded in); a profile is scoped to one CLI only when its layers name that CLI and not the other. Anything
 * v4 would call generic or mixed does not decide. A model set without a `harness` is scoped by its model ids in v4, a
 * table this tool does not copy, so a profile with one does not decide either (it can only hold more, never less).
 */
export async function previewProfileScopes(ctx: Pick<StepContext, 'v4'>): Promise<ProfileScopes> {
  const profiles = new Map<string, readonly string[]>();
  const components = new Map<string, 'claude' | 'codex' | 'generic' | 'unsure'>();
  for (const file of (await listV4Config(ctx.v4.home, ctx.v4.configOverrides)).files) {
    const { address } = file;
    if (address.kind !== 'profile' && address.kind !== 'component') continue;
    const map = (await readV4Yaml(file)).contents;
    if (!isMap(map)) continue;
    if (address.kind === 'profile') {
      const layers = map.get('contents', true);
      profiles.set(
        address.name,
        isSeq(layers)
          ? layers.items.flatMap(item => (isScalar(item) && typeof item.value === 'string' ? [item.value] : []))
          : [],
      );
    } else if (address.kind === 'component') {
      const harness = map.get('harness', false);
      components.set(
        `${address.componentKind}/${address.name}`,
        harness === 'claude' || harness === 'codex'
          ? harness
          : address.componentKind === 'modelSets'
            ? 'unsure'
            : 'generic',
      );
    }
  }
  type Folded = 'claude' | 'codex' | 'generic' | 'mixed' | 'unsure';
  const fold = (layers: readonly string[], visiting: ReadonlySet<string>): Folded => {
    let claude = false;
    let codex = false;
    let unsure = false;
    for (const layer of layers) {
      const slash = layer.indexOf('/');
      const [kind, name] = [layer.slice(0, slash), layer.slice(slash + 1)];
      let scope: Folded = 'generic';
      if (slash >= 0 && kind === 'profile') {
        const base = profiles.get(name);
        if (base !== undefined && !visiting.has(name)) scope = fold(base, new Set([...visiting, name]));
      } else if (slash >= 0) scope = components.get(layer) ?? 'generic';
      if (scope === 'claude' || scope === 'mixed') claude = true;
      if (scope === 'codex' || scope === 'mixed') codex = true;
      if (scope === 'unsure') unsure = true;
    }
    if (claude && codex) return 'mixed';
    if (unsure) return 'unsure';
    return claude ? 'claude' : codex ? 'codex' : 'generic';
  };
  const scopes = new Map<string, 'claude' | 'codex' | undefined>();
  for (const [name, layers] of profiles) {
    const scope = fold(layers, new Set([name]));
    scopes.set(name, scope === 'claude' || scope === 'codex' ? scope : undefined);
  }
  return scopes;
}

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
  profile: 'claude' | 'codex' | undefined,
): RuntimeHarness {
  if (own === 'claude' || own === 'claude-code') return 'claude-code';
  if (own === 'codex') return 'codex';
  if (own !== undefined) return 'unknown';
  const fromLogin = login === undefined ? undefined : ctx.previewLoginHarnesses?.get(login);
  if (fromLogin === undefined) return 'unknown';
  // v4 `runtimeHarness`: a login that drives both CLIs is decided by the runtime's PROFILE; if the profile does not
  // decide, nothing here does, and the runtime is held (v4 would fall back to the login's `harness`, which is stricter).
  const harness = fromLogin.both ? profile : fromLogin.harness;
  return harness === 'claude' ? 'claude-code' : harness === 'codex' ? 'codex' : 'both';
}

/** The v4 runtimes the preview holds, by name, with why (`codex`, or `unknown` when nothing proves a harness). */
export async function heldRuntimes(ctx: StepContext): Promise<ReadonlyMap<string, RuntimeHarness>> {
  const held = new Map<string, RuntimeHarness>();
  if (!holdsCodex(ctx)) return held;
  const scopes = await previewProfileScopes(ctx);
  for (const file of (await listV4Config(ctx.v4.home, ctx.v4.configOverrides)).files) {
    if (file.address.kind !== 'runtime') continue;
    const map = (await readV4Yaml(file)).contents;
    const scalar = (key: string): string | undefined => {
      const value = isMap(map) ? map.get(key, true) : undefined;
      return isScalar(value) && typeof value.value === 'string' ? value.value : undefined;
    };
    const profile = scalar('profile');
    const harness = runtimeHarnessOf(
      ctx,
      scalar('harness'),
      scalar('credential'),
      profile === undefined ? undefined : scopes.get(profile),
    );
    if (harness !== 'claude-code') held.set(file.address.name, harness);
  }
  return held;
}
