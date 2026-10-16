/**
 * The built-in provider presets (docs/provider-presets.md), read from the YAML files shipped beside
 * this package, and the catalogue a machine offers: those, with each of its own preset files laid over
 * them by id.
 *
 * The files are imported as TEXT, so the binary carries them exactly as they are in the repository and
 * a person who wants one as a starting point copies the same text Ferretry reads (`presetFileText`).
 *
 * Pure.
 */
import amazonBedrock from '../../../presets/amazon-bedrock.yaml' with { type: 'text' };
import amazonBedrockApiKey from '../../../presets/amazon-bedrock-api-key.yaml' with { type: 'text' };
import anthropicApiKey from '../../../presets/anthropic-api-key.yaml' with { type: 'text' };
import azureOpenai from '../../../presets/azure-openai.yaml' with { type: 'text' };
import bedrockMantle from '../../../presets/bedrock-mantle.yaml' with { type: 'text' };
import customGateway from '../../../presets/custom-gateway.yaml' with { type: 'text' };
import deepseek from '../../../presets/deepseek.yaml' with { type: 'text' };
import deepseekCodex from '../../../presets/deepseek-codex.yaml' with { type: 'text' };
import googleVertex from '../../../presets/google-vertex.yaml' with { type: 'text' };
import kimi from '../../../presets/kimi.yaml' with { type: 'text' };
import kimiCodex from '../../../presets/kimi-codex.yaml' with { type: 'text' };
import litellm from '../../../presets/litellm.yaml' with { type: 'text' };
import microsoftFoundryApiKey from '../../../presets/microsoft-foundry-api-key.yaml' with { type: 'text' };
import microsoftFoundryAzureCli from '../../../presets/microsoft-foundry-azure-cli.yaml' with { type: 'text' };
import minimax from '../../../presets/minimax.yaml' with { type: 'text' };
import minimaxCodex from '../../../presets/minimax-codex.yaml' with { type: 'text' };
import ollamaCodex from '../../../presets/ollama-codex.yaml' with { type: 'text' };
import openaiApiKey from '../../../presets/openai-api-key.yaml' with { type: 'text' };
import openrouter from '../../../presets/openrouter.yaml' with { type: 'text' };
import openrouterCodex from '../../../presets/openrouter-codex.yaml' with { type: 'text' };
import qwenCodingPlan from '../../../presets/qwen-coding-plan.yaml' with { type: 'text' };
import vercelAiGateway from '../../../presets/vercel-ai-gateway.yaml' with { type: 'text' };
import zaiGlm from '../../../presets/zai-glm.yaml' with { type: 'text' };
import zaiGlmCodex from '../../../presets/zai-glm-codex.yaml' with { type: 'text' };
import { readConfigText } from '../config-files/yaml-text.ts';
import { type ProviderPreset, ProviderPresetFileSchema } from './schema.ts';

/**
 * Every built-in preset's text, by id, in the order the Add a login flow lists them: Anthropic's own,
 * the clouds, the Anthropic-compatible providers, the gateways — then Codex the same way.
 */
export const BUILT_IN_PRESET_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  'anthropic-api-key': anthropicApiKey,
  'amazon-bedrock': amazonBedrock,
  'amazon-bedrock-api-key': amazonBedrockApiKey,
  'bedrock-mantle': bedrockMantle,
  'google-vertex': googleVertex,
  'microsoft-foundry-api-key': microsoftFoundryApiKey,
  'microsoft-foundry-azure-cli': microsoftFoundryAzureCli,
  'zai-glm': zaiGlm,
  kimi,
  minimax,
  deepseek,
  'qwen-coding-plan': qwenCodingPlan,
  openrouter,
  'vercel-ai-gateway': vercelAiGateway,
  litellm,
  'custom-gateway': customGateway,
  'openai-api-key': openaiApiKey,
  'azure-openai': azureOpenai,
  'openrouter-codex': openrouterCodex,
  'deepseek-codex': deepseekCodex,
  'kimi-codex': kimiCodex,
  'minimax-codex': minimaxCodex,
  'zai-glm-codex': zaiGlmCodex,
  'ollama-codex': ollamaCodex,
});

/** A built-in preset that does not check: a defect in this repository, never a person's mistake. */
export class BuiltInPresetError extends Error {
  constructor(id: string, problem: string) {
    super(`built-in preset ${id} does not check: ${problem}`);
    this.name = 'BuiltInPresetError';
  }
}

/** One preset file's text, checked: the preset, or every problem in one sentence. */
export function parsePresetText(
  id: string,
  text: string,
  origin: ProviderPreset['origin'],
): { readonly ok: true; readonly preset: ProviderPreset } | { readonly ok: false; readonly problem: string } {
  const read = readConfigText(text);
  if (!read.ok) return { ok: false, problem: read.errors.map(error => error.message).join('; ') };
  const parsed = ProviderPresetFileSchema.safeParse(read.read.value);
  if (!parsed.success) {
    return {
      ok: false,
      problem: parsed.error.issues.map(issue => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; '),
    };
  }
  return { ok: true, preset: { ...parsed.data, id, origin } };
}

/** The built-in catalogue, checked. Throws {@link BuiltInPresetError} when a shipped file is broken. */
export function builtInPresets(): readonly ProviderPreset[] {
  return Object.entries(BUILT_IN_PRESET_TEXTS).map(([id, text]) => {
    const parsed = parsePresetText(id, text, 'built-in');
    if (!parsed.ok) throw new BuiltInPresetError(id, parsed.problem);
    return parsed.preset;
  });
}

/**
 * The catalogue a machine offers: the built-ins in their order, a file of the same id replacing a
 * built-in in its place, then the machine's own new presets by id.
 */
export function presetCatalog(
  builtIns: readonly ProviderPreset[],
  files: Readonly<Record<string, ProviderPreset>>,
): readonly ProviderPreset[] {
  const known = new Set(builtIns.map(preset => preset.id));
  return [
    ...builtIns.map(preset => files[preset.id] ?? preset),
    ...Object.entries(files)
      .filter(([id]) => !known.has(id))
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([, preset]) => preset),
  ];
}

/** The text to start a machine's own copy of a built-in preset from, or `undefined` for an unknown id. */
export function presetFileText(id: string): string | undefined {
  return BUILT_IN_PRESET_TEXTS[id];
}
