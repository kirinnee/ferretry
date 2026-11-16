import names from './preset-env-names.json' with { type: 'json' };

/**
 * The shell variable names the provider presets declare — the ONLY ones `fy login add --from-env` may read
 * (`permissions.cliEnvReads` in the manifest, `CliContext.readEnvironment` in the shell). The list is written from the
 * shipped preset YAML by `scripts/built-ins.ts`, and `tests/unit/models/built-ins.test.ts` fails when it is stale, so
 * a preset's variable is readable exactly when the preset declares it and no name is copied by hand.
 */
export const PRESET_ENV_NAMES: readonly string[] = names;
