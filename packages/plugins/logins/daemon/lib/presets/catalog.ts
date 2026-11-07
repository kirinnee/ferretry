/**
 * The built-in provider presets (docs/provider-presets.md), read from the YAML files shipped beside
 * this package, and the catalogue a machine offers: those, with each of its own preset files laid over
 * them by id.
 *
 * The files are imported as TEXT, so the binary carries them exactly as they are in the repository and
 * a person who wants one as a starting point copies the same text Ferretry reads.
 *
 * Pure.
 */
import amazonBedrock from '../../data/endpoints/amazon-bedrock.yaml' with { type: 'text' };
import amazonBedrockApiKey from '../../data/endpoints/amazon-bedrock-api-key.yaml' with { type: 'text' };
import anthropicApiKey from '../../data/endpoints/anthropic-api-key.yaml' with { type: 'text' };
import azureOpenai from '../../data/endpoints/azure-openai.yaml' with { type: 'text' };
import bedrockMantle from '../../data/endpoints/bedrock-mantle.yaml' with { type: 'text' };
import customGateway from '../../data/endpoints/custom-gateway.yaml' with { type: 'text' };
import deepseek from '../../data/endpoints/deepseek.yaml' with { type: 'text' };
import googleVertex from '../../data/endpoints/google-vertex.yaml' with { type: 'text' };
import kimi from '../../data/endpoints/kimi.yaml' with { type: 'text' };
import litellm from '../../data/endpoints/litellm.yaml' with { type: 'text' };
import microsoftFoundryApiKey from '../../data/endpoints/microsoft-foundry-api-key.yaml' with { type: 'text' };
import microsoftFoundryAzureCli from '../../data/endpoints/microsoft-foundry-azure-cli.yaml' with { type: 'text' };
import minimax from '../../data/endpoints/minimax.yaml' with { type: 'text' };
import ollamaCodex from '../../data/endpoints/ollama-codex.yaml' with { type: 'text' };
import openaiApiKey from '../../data/endpoints/openai-api-key.yaml' with { type: 'text' };
import openrouter from '../../data/endpoints/openrouter.yaml' with { type: 'text' };
import qwenCodingPlan from '../../data/endpoints/qwen-coding-plan.yaml' with { type: 'text' };
import vercelAiGateway from '../../data/endpoints/vercel-ai-gateway.yaml' with { type: 'text' };
import zaiGlm from '../../data/endpoints/zai-glm.yaml' with { type: 'text' };
import { readConfigText } from '../shared/yaml-text.ts';
import { type ProviderPreset, ProviderPresetFileSchema, presetFromFile } from './schema.ts';

/**
 * Every built-in preset's text, by id, in the order the Add a login flow lists them: Anthropic's own,
 * the clouds, the providers that serve both CLIs and the other Anthropic-compatible ones, the gateways —
 * then what serves Codex alone.
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
  return { ok: true, preset: presetFromFile(id, parsed.data, origin) };
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
