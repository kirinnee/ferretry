/**
 * The provider presets and model catalogs Ferretry ships, as test data. Logins owns both: the presets are held here
 * only in the shape `LoginsApi.modelSources` answers (the catalog a preset reads and the variable NAMES each half takes),
 * and the model catalogs are copies of Logins' YAML read through Logins' own contract schema, so the libraries that turn
 * them into logins and runtime models are tested against what a machine really holds. Refresh these when Logins' data
 * changes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ModelCatalogSourcesView, ModelCatalogFileSchema } from '@ferretry/plugin-logins/contract';
import type { ModelCatalog } from '../../../../daemon/lib/models/schema.ts';
import type { ModelSourcePreset } from '../../../../daemon/lib/models/catalog.ts';
import { configText } from './config-text.ts';

const text = (folder: string, id: string): string => readFileSync(join(import.meta.dir, folder, `${id}.yaml`), 'utf8');

/** The presets in the order the Add a login flow lists them: Anthropic's own, the clouds, the gateways, then Codex alone. */
const PRESETS: ModelCatalogSourcesView['presets'] = [
  { id: 'anthropic-api-key', catalog: 'anthropic', variables: { claude: ['ANTHROPIC_API_KEY'] } },
  { id: 'amazon-bedrock', catalog: 'amazon-bedrock', variables: { claude: ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION'] } },
  {
    id: 'amazon-bedrock-api-key',
    catalog: 'amazon-bedrock',
    variables: { claude: ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK'] },
  },
  { id: 'bedrock-mantle', catalog: 'bedrock-mantle', variables: { claude: ['CLAUDE_CODE_USE_MANTLE', 'AWS_REGION'] } },
  {
    id: 'google-vertex',
    catalog: 'google-vertex',
    variables: { claude: ['CLAUDE_CODE_USE_VERTEX', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID'] },
  },
  {
    id: 'microsoft-foundry-api-key',
    catalog: 'microsoft-foundry',
    variables: {
      claude: [
        'CLAUDE_CODE_USE_FOUNDRY',
        'ANTHROPIC_FOUNDRY_RESOURCE',
        'ANTHROPIC_FOUNDRY_API_KEY',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ],
    },
  },
  {
    id: 'microsoft-foundry-azure-cli',
    catalog: 'microsoft-foundry',
    variables: {
      claude: [
        'CLAUDE_CODE_USE_FOUNDRY',
        'ANTHROPIC_FOUNDRY_RESOURCE',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ],
    },
  },
  {
    id: 'zai-glm',
    catalog: 'zai',
    variables: { claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'API_TIMEOUT_MS'], codex: ['ZAI_API_KEY'] },
  },
  {
    id: 'kimi',
    catalog: 'kimi',
    variables: {
      claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'],
      codex: ['KIMI_API_KEY'],
    },
  },
  {
    id: 'minimax',
    catalog: 'minimax',
    variables: { claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'], codex: ['MINIMAX_API_KEY'] },
  },
  {
    id: 'deepseek',
    catalog: 'deepseek',
    variables: { claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'], codex: ['DEEPSEEK_API_KEY'] },
  },
  {
    id: 'qwen-coding-plan',
    catalog: 'qwen',
    variables: { claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'] },
  },
  {
    id: 'openrouter',
    catalog: 'openrouter',
    variables: {
      claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
      codex: ['OPENROUTER_API_KEY'],
    },
  },
  {
    id: 'vercel-ai-gateway',
    catalog: 'vercel-ai-gateway',
    variables: {
      claude: [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
      ],
    },
  },
  {
    id: 'litellm',
    catalog: 'gateway',
    variables: { claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'] },
  },
  {
    id: 'custom-gateway',
    catalog: 'gateway',
    variables: { claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'] },
  },
  { id: 'openai-api-key', catalog: 'openai', variables: { codex: ['OPENAI_API_KEY'] } },
  {
    id: 'azure-openai',
    catalog: 'azure-openai',
    variables: { codex: ['AZURE_OPENAI_RESOURCE', 'AZURE_OPENAI_API_KEY'] },
  },
  { id: 'ollama-codex', catalog: 'ollama', variables: { codex: [] } },
];

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

/** The shipped presets, mapped the way the Logins adapter hands them to Runtimes (`loginsModelCatalogs`): each half's variable names as keys. */
export function builtInPresets(): readonly ModelSourcePreset[] {
  return PRESETS.map(preset => ({
    id: preset.id,
    ...(preset.catalog === undefined ? {} : { catalog: preset.catalog }),
    halves: Object.fromEntries(
      Object.entries(preset.variables).map(([harness, names]) => [
        harness,
        { env: Object.fromEntries(names.map(name => [name, true])) },
      ]),
    ),
  }));
}

export function builtInModelCatalogs(): Readonly<Record<string, ModelCatalog>> {
  return Object.fromEntries(
    CATALOG_IDS.map(id => {
      const read = configText.read(text('models', id));
      if (!read.ok) throw new Error(`model catalog ${id} does not parse`);
      return [id, { ...ModelCatalogFileSchema.parse(read.read.value), id, origin: 'built-in' as const }];
    }),
  );
}
