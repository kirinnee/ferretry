import { detectProvider } from '../../contract/detect.ts';
import { PRESET_ENV_NAMES } from '../../contract/preset-env-names.ts';
import type { ProviderPresetCatalog, ProviderPresetView } from '../../contract/index.ts';
import { namesACredential, plainPaste } from '../../contract/secret-shape.ts';
import { type LoginsCommandDeps, LoginsCommandError } from './ports.ts';

/**
 * The secrets a provider login needs and how they get into the Vault (docs/provider-presets.md §2–3).
 *
 * A VALUE GOES ONE WAY: from a hidden prompt or this shell's own variables straight to the Vault's `POST /v1/secrets`
 * (`deps.gateway.putSecret`), and nothing here prints, logs, returns or keeps it — the login file only ever gets the
 * `${secret:NAME}` reference the preset already wrote. Every message below names a variable or a secret, never a value.
 */

/** One secret a login needs: its NAME in the Vault, and every preset variable that carries it. */
export interface SecretNeed {
  readonly name: string;
  readonly variables: readonly string[];
}

/**
 * The secrets `preset` names whose variable is still the preset's own `${secret:NAME}` reference in `env` (a variable
 * the person overrode with `--env` is theirs to settle), each NAME once however many variables carry it.
 */
export function secretNeeds(preset: ProviderPresetView, env: Readonly<Record<string, string>>): readonly SecretNeed[] {
  const byName = new Map<string, string[]>();
  for (const variable of preset.variables) {
    const name = variable.secret ?? variable.name;
    if (variable.kind === 'secret' && env[variable.name] === `\${secret:${name}}`) {
      byName.set(name, [...(byName.get(name) ?? []), variable.name]);
    }
  }
  return [...byName].map(([name, variables]) => ({ name, variables }));
}

/**
 * The shell's variables `--from-env` may use: only the names the presets declare, only the ones set and not empty.
 * A shell this command line cannot read from is refused in words, never read around.
 *
 * GAP(logins): a `PREFIX_*` family a preset's `detect.variables` names is not an exact name the manifest can declare
 * (`permissions.cliEnvReads`), so the shell is never asked for it and a provider told only by one is not detected.
 */
export function shellVariables(deps: LoginsCommandDeps): Readonly<Record<string, string>> {
  if (deps.readEnvironment === undefined) {
    throw new LoginsCommandError(
      `This command line cannot read your shell's variables, so --from-env reads nothing. Name the provider and type its key instead: ${deps.binaryName} login add <provider>`,
    );
  }
  const asked = deps.readEnvironment(PRESET_ENV_NAMES);
  return Object.fromEntries(
    PRESET_ENV_NAMES.flatMap(name => {
      const value = asked[name];
      return value === undefined || value === '' ? [] : [[name, value]];
    }),
  );
}

/** The host of an address, lower-cased; `undefined` when it is not one. Userinfo is never part of it. */
function hostOf(address: string): string | undefined {
  try {
    return new URL(address).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** What `--from-env` took from the shell, and the address variables it left on the preset's own host (by NAME). */
export interface ShellPlain {
  readonly values: Readonly<Record<string, string>>;
  readonly keptPreset: readonly string[];
}

/**
 * The plain variables `--from-env` fills from the shell: a variable the preset requires and leaves empty (a gateway's
 * `ANTHROPIC_BASE_URL`), or one it fills with a default the shell declares a different value for (`AWS_REGION`,
 * `CLOUD_ML_REGION`, a Foundry deployment name) — the shell's own setting wins over the preset's default. Never one the preset
 * deliberately leaves empty (`allowEmpty`: `ANTHROPIC_API_KEY` under openrouter, so the gateway key is the one sent), never
 * one whose NAME reads as a credential, and only a value the stored rule takes (`plainPaste(…, 'stored')`). A key in the shell
 * therefore never reaches the login file, nor a route that is not the Vault.
 *
 * One exception: a `*_BASE_URL` the preset sets keeps the preset's address when the shell's host differs, so a provider's key
 * never follows a shell address to another host; the variable is returned in `keptPreset` so it is said by name.
 */
export function shellPlainValues(
  preset: ProviderPresetView | undefined,
  shell: Readonly<Record<string, string>>,
): ShellPlain {
  const values: Record<string, string> = {};
  const keptPreset: string[] = [];
  for (const variable of preset?.variables ?? []) {
    const value = shell[variable.name];
    if (value === undefined || variable.kind !== 'plain' || variable.allowEmpty || namesACredential(variable.name))
      continue;
    const presetValue = variable.value ?? '';
    // An empty preset value is taken only when the preset requires one; a filled one is the preset's default to replace.
    if (presetValue === '' && !variable.required) continue;
    const verdict = plainPaste(variable.name, value, variable.allowEmpty, 'stored');
    if (verdict.kind !== 'take') continue;
    if (presetValue !== '' && variable.name.endsWith('_BASE_URL')) {
      const theirs = hostOf(verdict.value);
      if (theirs === undefined || theirs !== hostOf(presetValue)) {
        keptPreset.push(variable.name);
        continue;
      }
    }
    values[variable.name] = verdict.value;
  }
  return { values, keptPreset };
}

/** The preset the shell's variables point at, said by variable NAMES; a custom gateway or nothing is refused. */
export function detectedPreset(
  deps: LoginsCommandDeps,
  catalog: ProviderPresetCatalog,
  shell: Readonly<Record<string, string>>,
): ProviderPresetView {
  const table = catalog.presets.flatMap(preset =>
    preset.detect === undefined ? [] : [{ id: preset.id, detect: preset.detect }],
  );
  const detection = detectProvider(table, shell);
  const preset = catalog.presets.find(entry => entry.id === detection.preset);
  if (preset === undefined) {
    // Nothing read is not the same as nothing matched: say which, so a missing declaration is not mistaken for a shell with no clue.
    const said =
      Object.keys(shell).length === 0
        ? 'Nothing was read: none of the variables the providers name is set, declared or readable in this shell'
        : "No provider could be told from this shell's variables";
    throw new LoginsCommandError(
      `${said}. Name it: ${deps.binaryName} login add <provider> (see \`${deps.binaryName} login presets\`)`,
    );
  }
  deps.out.warn(`Detected ${preset.label} from ${detection.clues.map(clue => clue.variable).join(', ')}.`);
  return preset;
}

/**
 * Puts every needed secret in the Vault: one it already holds is kept (never replaced), else the shell's own value
 * for any of its variables, else a hidden prompt. With nobody to ask, each missing one is refused by NAME with the
 * command that stores it. `say` carries a name and a state only.
 */
export async function storeSecrets(
  deps: LoginsCommandDeps,
  needs: readonly SecretNeed[],
  shell: Readonly<Record<string, string>>,
  say: (line: string) => void,
): Promise<void> {
  if (needs.length === 0) return;
  const held = await deps.gateway.secretNames();
  const stored: string[] = [];
  for (const need of needs) {
    if (held.has(need.name)) {
      say(`${need.name}: already set ✓`);
      continue;
    }
    // A variable that carries the secret, or one named like the secret itself (`ZAI_API_KEY`), whichever the shell has.
    const given = [...need.variables, need.name].map(variable => shell[variable]).find(value => value !== undefined);
    const typed = given ?? (await deps.promptHidden?.(`${need.name} (hidden; press Enter when done): `));
    if (typed === undefined) {
      throw new LoginsCommandError(
        `${need.name} is needed and there is no terminal to type it at. Store it, then run this again: printf %s "$KEY" | ${deps.binaryName} secret set ${need.name}`,
      );
    }
    if (typed === '') throw new LoginsCommandError(`${need.name} is needed: nothing was typed, so nothing was stored.`);
    try {
      await deps.gateway.putSecret(need.name, typed);
    } catch (error) {
      throw new LoginsCommandError(refusedSentence(need.name, stored, error, typed));
    }
    stored.push(need.name);
    say(`${need.name}: stored in the Vault ✓`);
  }
}

/**
 * The sentence for a Vault that would not take a secret (a governed caller's 403, a full store): the daemon's own words
 * when it answered with a status, with the value taken out of them should they ever echo it, else none; the name, never
 * the value; and what is left behind — the login is not added, a secret stored before this one stays in the Vault.
 */
function refusedSentence(name: string, stored: readonly string[], error: unknown, value: string): string {
  const answered = error instanceof Error && typeof (error as { status?: unknown }).status === 'number';
  const why = answered
    ? `: ${error.message
        .split(value)
        .join('…')
        .replace(/[.\s]+$/u, '')}`
    : '';
  const left = stored.length === 0 ? '' : ` ${stored.join(', ')} was stored before it and stays in the Vault.`;
  return `${name} was not stored${why}. The login was not added.${left}`;
}
