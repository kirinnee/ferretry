/**
 * The provider presets and model catalogs Ferretry ships, as test data: copies of the YAML files Logins owns, read
 * through the same schemas, so the libraries that turn them into logins and runtime models are tested against what
 * a machine really holds. (The shipped files themselves are Logins' data; refresh these when they change.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelCatalogFileSchema } from '@ferretry/plugin-logins/contract';
import { builtInPresets as presetsFromTexts } from '../../../../daemon/lib/presets/catalog.ts';
import type { ModelCatalog } from '../../../../daemon/lib/models/schema.ts';
import { configText } from './config-text.ts';

const text = (folder: string, id: string): string => readFileSync(join(import.meta.dir, folder, `${id}.yaml`), 'utf8');

/** The presets in the order the Add a login flow lists them: Anthropic's own, the clouds, the gateways, then Codex alone. */
const PRESET_IDS = [
  'anthropic-api-key',
  'amazon-bedrock',
  'amazon-bedrock-api-key',
  'bedrock-mantle',
  'google-vertex',
  'microsoft-foundry-api-key',
  'microsoft-foundry-azure-cli',
  'zai-glm',
  'kimi',
  'minimax',
  'deepseek',
  'qwen-coding-plan',
  'openrouter',
  'vercel-ai-gateway',
  'litellm',
  'custom-gateway',
  'openai-api-key',
  'azure-openai',
  'ollama-codex',
] as const;

const CATALOG_IDS = [
  'anthropic',
  'openai',
  'amazon-bedrock',
  'bedrock-mantle',
  'google-vertex',
  'microsoft-foundry',
  'zai',
  'kimi',
  'minimax',
  'deepseek',
  'qwen',
  'openrouter',
  'vercel-ai-gateway',
  'gateway',
  'azure-openai',
  'ollama',
] as const;

export const BUILT_IN_PRESET_TEXTS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(PRESET_IDS.map(id => [id, text('presets', id)])),
);

export const builtInPresets = () => presetsFromTexts(configText, BUILT_IN_PRESET_TEXTS);

export function builtInModelCatalogs(): Readonly<Record<string, ModelCatalog>> {
  return Object.fromEntries(
    CATALOG_IDS.map(id => {
      const read = configText.read(text('models', id));
      if (!read.ok) throw new Error(`model catalog ${id} does not parse`);
      return [id, { ...ModelCatalogFileSchema.parse(read.read.value), id, origin: 'built-in' as const }];
    }),
  );
}
