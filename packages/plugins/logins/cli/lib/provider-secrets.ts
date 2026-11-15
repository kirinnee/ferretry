import { detectProvider } from '../../contract/detect.ts';
import { PRESET_ENV_NAMES } from '../../contract/preset-env-names.ts';
import type { ProviderPresetCatalog, ProviderPresetView } from '../../contract/index.ts';
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
    throw new LoginsCommandError(
      `No provider could be told from this shell's variables. Name it: ${deps.binaryName} login add <provider> (see \`${deps.binaryName} login presets\`)`,
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
    await deps.gateway.putSecret(need.name, typed);
    say(`${need.name}: stored in the Vault ✓`);
  }
}
