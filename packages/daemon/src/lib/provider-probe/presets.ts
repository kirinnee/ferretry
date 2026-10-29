/**
 * The provider presets this machine offers (docs/provider-presets.md), as the Add a login flow reads
 * them: the built-in catalogue, with this machine's own `config/presets/<id>.yaml` laid over it.
 *
 * A preset is never a secret and names none by value — only the NAME a secret is suggested to be kept
 * under — so the whole catalogue may travel to any caller with `fleet.use`.
 */
import {
  catalogModelValue,
  type HarnessKind,
  type ModelCatalog,
  type PresetTest,
  type ProviderPreset,
  presetCatalog,
  presetHarnesses,
} from '@ferretry/fleet';
// Parsed when this build is made, never at boot: `@ferretry/fleet/built-ins` says why.
import { checkedBuiltInPresets } from '@ferretry/fleet/built-ins' with { type: 'macro' };
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
/**
 * The models a half offers, for display: its model catalog's (docs/model-catalog.md), as the values a
 * CLI is handed, else whatever the preset file itself lists.
 */
function halfModels(preset: ProviderPreset, harness: HarnessKind, catalogs: CatalogsById): readonly string[] {
  const half = preset.catalog === undefined ? undefined : catalogs[preset.catalog]?.[harness];
  return half === undefined ? (preset.halves[harness]?.models ?? []) : half.models.map(catalogModelValue);
}

type CatalogsById = Readonly<Record<string, ModelCatalog>>;

function halvesView(preset: ProviderPreset, catalogs: CatalogsById): NonNullable<FleetProviderPresetView['halves']> {
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
        models: [...halfModels(preset, harness, catalogs)],
      },
    ];
  });
}

/** One preset as the wire carries it. */
export function presetView(preset: ProviderPreset, catalogs: CatalogsById = {}): FleetProviderPresetView {
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
    models: [...new Set(presetHarnesses(preset).flatMap(harness => halfModels(preset, harness, catalogs)))],
    test: presetTestAct(preset.test),
    quota: { source: preset.quota.source, note: preset.quota.note },
    unverified: [...preset.unverified],
    verified: preset.verified,
    offered: offered(preset),
    halves: halvesView(preset, catalogs),
    ...(isEmptyDetect(preset) ? {} : { detect: { ...preset.detect } }),
  };
}

/** The catalogue, read fresh: a preset file saved a moment ago is offered at once. */
export class ProviderPresetService {
  readonly #builtIns: readonly ProviderPreset[];

  constructor(
    private readonly machine: MachinePresetSource,
    builtIns: readonly ProviderPreset[] = checkedBuiltInPresets(),
    /** The model catalogs in effect, so a preset shows the models its catalog offers. */
    private readonly catalogs: () => Promise<CatalogsById> = async () => ({}),
  ) {
    this.#builtIns = builtIns;
  }

  /** Every preset this machine offers, the built-ins first in their order. */
  async presets(): Promise<readonly ProviderPreset[]> {
    return presetCatalog(this.#builtIns, await this.machine.presets());
  }

  async catalog(): Promise<FleetProviderPresetCatalog> {
    const [presets, catalogs] = await Promise.all([this.presets(), this.catalogs()]);
    return { presets: presets.map(preset => presetView(preset, catalogs)) };
  }
}
