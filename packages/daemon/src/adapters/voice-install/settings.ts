import { checkConfigFile, type ConfigEvaluation, renderConfigFile } from '@ferretry/fleet';
import {
  type ConfigFileAddress,
  configFilePath,
  VoiceConfigSchema,
  type VoiceConfig,
  type VoiceMachineEngine,
} from '@ferretry/protocol';
import type { ConfigFilesService } from '../../lib/config-files/index.ts';
import type { VoiceEngineSettings } from '../../lib/voice-install/index.ts';

const VOICE_FILE: ConfigFileAddress = { kind: 'voice' };

/** `config/voice.yaml` with the model choice changed key by key, so the owner's comments survive. */
function withModel(config: VoiceConfig, role: 'batch' | 'streaming', id: string | null): VoiceConfig {
  const { [role]: _dropped, ...rest } = config.engine;
  return { ...config, engine: id === null ? rest : { ...rest, [role]: id } };
}

/** The edit held for the owner in `voice.yaml`, as settings and as text — `undefined` when none is. */
function heldVoiceConfig(
  evaluation: ConfigEvaluation,
  path: string,
  disk: string | undefined,
): { readonly config: VoiceConfig; readonly text: string } | undefined {
  if (disk === undefined || !evaluation.pending.some(pending => pending.path === path)) return undefined;
  const checked = checkConfigFile(path, disk);
  return checked.ok ? { config: checked.value as VoiceConfig, text: disk } : undefined;
}

/**
 * The speech engine's choices, read from and written to `config/voice.yaml` — the configuration files' own
 * path (docs/config-files.md), so the same file `fy config` edits is the one `fy voice use` and the app write.
 *
 * Reads answer the version IN EFFECT. A write is the owner's own act (`fy voice use`; the route is `voice`
 * › `configure` from a person), so it takes effect at once — and, as the Warden's settings do, it never
 * discards an edit that is waiting for the owner: the choice is made to both versions.
 */
export class ConfigFileVoiceEngineSettings implements VoiceEngineSettings {
  constructor(private readonly config: Pick<ConfigFilesService, 'inEffect' | 'load' | 'writeOwn'>) {}

  async read(): Promise<VoiceMachineEngine> {
    const effective = (await this.config.inEffect()).evaluation.effective.voice;
    return VoiceConfigSchema.parse(effective).engine;
  }

  async setModel(role: 'batch' | 'streaming', id: string | null): Promise<void> {
    const path = configFilePath(VOICE_FILE);
    const { files, evaluation } = await this.config.load();
    const disk = files.get(path)?.text;
    const held = heldVoiceConfig(evaluation, path, disk);
    if (held === undefined) {
      const current = VoiceConfigSchema.parse(evaluation.effective.voice);
      const text = renderConfigFile(path, VOICE_FILE, withModel(current, role, id), disk);
      if (text !== undefined) await this.config.writeOwn(path, text);
      return;
    }
    const accepted = evaluation.accepted[path]?.text;
    const inEffectConfig = VoiceConfigSchema.parse(evaluation.effective.voice);
    const inEffect =
      renderConfigFile(path, VOICE_FILE, withModel(inEffectConfig, role, id), accepted) ?? accepted ?? '';
    const text = renderConfigFile(path, VOICE_FILE, withModel(held.config, role, id), held.text) ?? held.text;
    await this.config.writeOwn(path, text, inEffect);
  }
}
