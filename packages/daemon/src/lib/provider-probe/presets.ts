/**
 * The provider presets this machine offers (docs/provider-presets.md), as the Add a login flow reads
 * them: the built-in catalogue, with this machine's own `config/presets/<id>.yaml` laid over it.
 *
 * A preset is never a secret and names none by value — only the NAME a secret is suggested to be kept
 * under — so the whole catalogue may travel to any caller with `fleet.use`.
 */
import {
  builtInPresets,
  type HarnessKind,
  type PresetTest,
  type ProviderPreset,
  presetCatalog,
  presetHarnesses,
} from '@ferretry/fleet';
import type {
  FleetCredentialAct,
  FleetCredentialTestAct,
  FleetProviderPresetCatalog,
  FleetProviderPresetView,
} from '@ferretry/protocol';

/** This machine's own preset files that check, by id: the configuration in effect. */
export interface MachinePresetSource {
  presets(): Promise<Readonly<Record<string, ProviderPreset>>>;
}

/** What a preset's Test does, before any login exists: whether one is offered and what it spends. */
export function presetTestAct(test: PresetTest): FleetCredentialTestAct {
  switch (test.kind) {
    case 'none':
      return { available: false, reason: test.reason };
    case 'inference':
      return { available: true, spends: 'one-token', note: test.note };
    default:
      return { available: true, spends: 'nothing', note: test.note };
  }
}

/** Whether a preset declares no detection clue: it is never offered as a detection. */
const isEmptyDetect = (preset: ProviderPreset): boolean =>
  preset.detect.hosts.length + preset.detect.variables.length + preset.detect.keyPrefixes.length === 0;

/** Whether a preset may add a login here. */
const offered = (preset: ProviderPreset): FleetCredentialAct =>
  preset.unavailable === undefined ? { available: true } : { available: false, reason: preset.unavailable };

/** The halves that set a variable, said only for a preset a login from which drives both CLIs. */
function variableHalves(preset: ProviderPreset, name: string): { harnesses?: HarnessKind[] } {
  const usable = presetHarnesses(preset);
  if (usable.length < 2) return {};
  return { harnesses: usable.filter(harness => preset.halves[harness]?.env[name] !== undefined) };
}

const HALF_ORDER: readonly HarnessKind[] = ['claude', 'codex'];

/**
 * Each half and whether it is offered: a half is offered when the preset is and the half itself says no
 * reason it cannot be.
 */
function halvesView(preset: ProviderPreset): NonNullable<FleetProviderPresetView['halves']> {
  const usable = presetHarnesses(preset);
  return HALF_ORDER.flatMap(harness => {
    const half = preset.halves[harness];
    if (half === undefined) return [];
    return [
      {
        harness,
        offered: usable.includes(harness)
          ? { available: true as const }
          : { available: false as const, reason: half.unavailable ?? (preset.unavailable as string) },
        ...(half.docs === undefined ? {} : { docs: half.docs }),
        models: [...half.models],
      },
    ];
  });
}

/** One preset as the wire carries it. */
export function presetView(preset: ProviderPreset): FleetProviderPresetView {
  return {
    id: preset.id,
    label: preset.label,
    harness: preset.harness,
    summary: preset.summary,
    ...(preset.group === undefined ? {} : { group: preset.group }),
    docs: preset.docs,
    origin: preset.origin,
    variables: Object.entries(preset.env).map(([name, variable]) => ({
      name,
      kind: variable.secretName === undefined ? ('plain' as const) : ('secret' as const),
      ...(variable.value === undefined ? {} : { value: variable.value }),
      ...(variable.secretName === undefined ? {} : { secret: variable.secretName }),
      required: variable.required,
      allowEmpty: variable.allowEmpty,
      ...(variable.description === undefined ? {} : { description: variable.description }),
      ...variableHalves(preset, name),
    })),
    ...(preset.cloudCredential === undefined
      ? {}
      : { cloudCredential: { kinds: [...preset.cloudCredential.kinds], suggested: preset.cloudCredential.suggested } }),
    models: [...preset.models],
    test: presetTestAct(preset.test),
    quota: { source: preset.quota.source, note: preset.quota.note },
    unverified: [...preset.unverified],
    verified: preset.verified,
    offered: offered(preset),
    halves: halvesView(preset),
    ...(isEmptyDetect(preset) ? {} : { detect: { ...preset.detect } }),
  };
}

/** The catalogue, read fresh: a preset file saved a moment ago is offered at once. */
export class ProviderPresetService {
  readonly #builtIns: readonly ProviderPreset[];

  constructor(
    private readonly machine: MachinePresetSource,
    builtIns: readonly ProviderPreset[] = builtInPresets(),
  ) {
    this.#builtIns = builtIns;
  }

  /** Every preset this machine offers, the built-ins first in their order. */
  async presets(): Promise<readonly ProviderPreset[]> {
    return presetCatalog(this.#builtIns, await this.machine.presets());
  }

  async catalog(): Promise<FleetProviderPresetCatalog> {
    return { presets: (await this.presets()).map(presetView) };
  }
}
