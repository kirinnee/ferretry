/**
 * THE ONE-TIME MIGRATION TO ONE ROUTING PROMPT (docs/pack-mode.md § Migration). A machine that kept a
 * use-case guide (`models-guide.yaml` `useCases`, `routing`, `models`) or the old builder's preferences
 * (`pack.yaml` `routingPreferences`) has them rendered into ONE prompt and removed, once:
 *
 * 1. both files are copied, whole and as they were, into a backup in the state home — written FIRST, so a
 *    failure after it loses nothing;
 * 2. `models-guide.yaml` gets `prompt` — the old use cases (or, for a guide that named none, the default
 *    prompt), the old routing prompt and the preferences, in that order (`./routing.ts` `legacyPrompt`) —
 *    unless it already has one, and loses the old keys and the old `suggested`, which described a guide that
 *    is gone;
 * 3. `pack.yaml` loses `routingPreferences`.
 *
 * Both writes go through the configuration writer every editor uses, so each is checked; neither loosens
 * anything (the prompt widens nothing, and removing a key the settings no longer read changes none). A machine
 * with none of the old keys is left alone, so running it at every start is a no-op after the first.
 */
import { editConfigText } from '@ferretry/fleet/config-text';
import { configSchemaModeline, type ModelsGuideFile, ModelsGuideFileSchema } from '@ferretry/protocol';
import { GUIDE_MODELINE, type GuideFileText, rawOf, without } from './cleanup/file.ts';
import { legacyPrompt } from './routing.ts';

const PACK_MODELINE = configSchemaModeline({ kind: 'pack' });

/** What the migration kept: both files as they were, and the prompt it wrote. */
export interface RoutingMigrationBackup {
  readonly at: string;
  /** `models-guide.yaml` as it was; `null` when there was none. */
  readonly modelsGuide: string | null;
  /** `pack.yaml` as it was, when it held `routingPreferences`; `null` otherwise. */
  readonly pack: string | null;
  /** The prompt written, when one was. */
  readonly prompt?: string;
  /** Whether the prompt had to be cut to fit; the whole of it is in `modelsGuide` and `pack`. */
  readonly cut: boolean;
}

export interface RoutingMigrationPorts {
  readGuide(): Promise<GuideFileText>;
  writeGuide(text: string, etag: string): Promise<void>;
  readPack(): Promise<GuideFileText>;
  writePack(text: string, etag: string): Promise<void>;
  /** The default prompt, rendered from the catalogs in effect: what a guide with no use cases ran on. */
  defaultPrompt(): Promise<string>;
  /** Keeps the backup; where it is, in words, for the log. */
  backup(value: RoutingMigrationBackup): Promise<string>;
  now(): string;
}

export type RoutingMigrationOutcome =
  | { readonly outcome: 'nothing' }
  | {
      readonly outcome: 'migrated';
      readonly prompt?: string;
      readonly cut: boolean;
      /** Where the old files were kept. */
      readonly backup: string;
    };

const LEGACY_GUIDE_KEYS = ['useCases', 'routing', 'models'] as const;

export class RoutingMigration {
  constructor(private readonly ports: RoutingMigrationPorts) {}

  async run(): Promise<RoutingMigrationOutcome> {
    const [guide, pack] = await Promise.all([this.ports.readGuide(), this.ports.readPack()]);
    const guideRaw = rawOf(guide);
    const packRaw = rawOf(pack);
    const legacyGuide = LEGACY_GUIDE_KEYS.some(key => key in guideRaw);
    const hasPreferences = 'routingPreferences' in packRaw;
    if (!legacyGuide && !hasPreferences) return { outcome: 'nothing' };

    const preferences = typeof packRaw.routingPreferences === 'string' ? packRaw.routingPreferences : undefined;
    const file: ModelsGuideFile = ModelsGuideFileSchema.safeParse(guideRaw).data ?? {
      ...(Array.isArray(guideRaw.useCases) ? { useCases: guideRaw.useCases } : {}),
      ...('routing' in guideRaw ? { routing: guideRaw.routing } : {}),
    };
    const rendered =
      typeof guideRaw.prompt === 'string'
        ? undefined
        : legacyPrompt(file, preferences, await this.ports.defaultPrompt());
    const backup = await this.ports.backup({
      at: this.ports.now(),
      modelsGuide: guide.exists ? guide.text : null,
      pack: hasPreferences ? pack.text : null,
      ...(rendered === undefined ? {} : { prompt: rendered.text }),
      cut: rendered?.cut ?? false,
    });
    if (legacyGuide || rendered !== undefined) {
      const kept = without(guideRaw, ...LEGACY_GUIDE_KEYS, ...(rendered === undefined ? [] : ['suggested']));
      const target = rendered === undefined ? kept : { prompt: rendered.text, ...kept };
      await this.ports.writeGuide(editConfigText(guide.text, target, guideRaw, GUIDE_MODELINE), guide.etag);
    }
    if (hasPreferences)
      await this.ports.writePack(
        editConfigText(pack.text, without(packRaw, 'routingPreferences'), packRaw, PACK_MODELINE),
        pack.etag,
      );
    return {
      outcome: 'migrated',
      ...(rendered === undefined ? {} : { prompt: rendered.text }),
      cut: rendered?.cut ?? false,
      backup,
    };
  }
}
