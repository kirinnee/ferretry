/**
 * The provider presets this machine offers (docs/provider-presets.md), as the Add a login flow reads
 * them: the built-in catalogue, with this machine's own `config/presets/<id>.yaml` laid over it.
 *
 * A preset is never a secret and names none by value — only the NAME a secret is suggested to be kept
 * under — so the whole catalogue may travel to any caller with `fleet.use`.
 */
import { catalogModelValue, type ModelCatalog } from '../catalog/schema.ts';
import { type HarnessKind, harnessKey } from '../shared/harness.ts';
import { type PresetTest, type ProviderPreset, presetHarnesses } from '../presets/schema.ts';
import { presetCatalog } from '../presets/catalog.ts';
// Parsed when this build is made, never at boot: `../built-ins.ts` says why.
import { checkedBuiltInPresets } from '../built-ins.ts' with { type: 'macro' };
import type { LoginAct, LoginTestAct, ProviderPresetCatalog, ProviderPresetView } from '../../../contract/index.ts';

/** This machine's own preset files that check, by id: the configuration in effect. */
export interface MachinePresetSource {
  presets(): Promise<Readonly<Record<string, ProviderPreset>>>;
}

/** What a preset's Test does, before any login exists: whether one is offered and what it spends. */
export function presetTestAct(test: PresetTest): LoginTestAct {
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
const offered = (preset: ProviderPreset): LoginAct =>
  preset.unavailable === undefined ? { available: true } : { available: false, reason: preset.unavailable };

/**
 * The halves that set a variable. The wire's `harnesses` is required (a preset with one usable half names it), where
 * today's was absent for such a preset.
 */
function variableHalves(preset: ProviderPreset, name: string): { harnesses: ReturnType<typeof harnessKey>[] } {
  const usable = presetHarnesses(preset);
  if (usable.length < 2) return { harnesses: [harnessKey(preset.harness)] };
  return { harnesses: usable.filter(harness => preset.halves[harness]?.env[name] !== undefined).map(harnessKey) };
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

function halvesView(preset: ProviderPreset, catalogs: CatalogsById): NonNullable<ProviderPresetView['halves']> {
  const usable = presetHarnesses(preset);
  return HALF_ORDER.flatMap(harness => {
    const half = preset.halves[harness];
    if (half === undefined) return [];
    return [
      {
        harness: harnessKey(harness),
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
export function presetView(preset: ProviderPreset, catalogs: CatalogsById = {}): ProviderPresetView {
  return {
    id: preset.id,
    label: preset.label,
    harness: harnessKey(preset.harness),
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

  async catalog(): Promise<ProviderPresetCatalog> {
    const [presets, catalogs] = await Promise.all([this.presets(), this.catalogs()]);
    return { presets: presets.map(preset => presetView(preset, catalogs)) };
  }
}
