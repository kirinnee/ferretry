import { secretReference } from '@ferretry/core-vault/contract';
import type { ProviderPreset } from '../../daemon/lib/presets/schema.ts';

/** What a preset fills in by itself: a secret as a reference to its suggested NAME, a plain value as it is. */
export const presetDefaultEnv = (entry: ProviderPreset): Record<string, string> =>
  Object.fromEntries(
    Object.entries(entry.env).map(([name, variable]) => [
      name,
      variable.secretName === undefined ? (variable.value ?? '') : secretReference(variable.secretName),
    ]),
  );

/** A value for every variable a preset leaves for the person to fill in, so its login can be made. */
export const filledEnv = (entry: ProviderPreset): Record<string, string> =>
  Object.fromEntries(
    Object.entries(presetDefaultEnv(entry)).map(([name, value]) => [
      name,
      value === '' && entry.env[name]?.required === true && entry.env[name]?.allowEmpty !== true
        ? name.endsWith('_URL')
          ? 'https://gateway.example.com'
          : 'acme'
        : value,
    ]),
  );
