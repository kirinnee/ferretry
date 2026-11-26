import type { HarnessRuntimeModels } from '@ferretry/core-ferrets/contract';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';

/** Catalog ids and models.dev's native provider ids are separate public identifiers. */
const PROVIDER_OF_CATALOG: Readonly<Record<string, string>> = {
  'azure-openai': 'azure',
  'google-gemini': 'google',
  kimi: 'moonshotai',
  qwen: 'alibaba',
  'vercel-ai-gateway': 'vercel',
};

/** Metadata only: templates retain secret references; no status, credential store, provider call or Vault read. */
export async function opencodeModels(
  logins: Pick<LoginsApi, 'environmentTemplates' | 'modelSources'> | undefined,
  login: string,
  nowMs: number,
): Promise<HarnessRuntimeModels> {
  if (logins === undefined) return { choices: [] };
  const [templates, sources] = await Promise.all([logins.environmentTemplates(), logins.modelSources()]);
  const template = templates.find(item => item.id === login);
  if (template?.kind !== 'templates' || sources.discovery === undefined) return { choices: [] };
  const catalogId = sources.presets.find(preset => preset.id === template.preset)?.catalog;
  const providers = sources.discovery.providers;
  const matches = Object.entries(providers).filter(([, provider]) =>
    provider.env?.some(name => Object.hasOwn(template.env ?? {}, name)),
  );
  const providerId =
    catalogId === undefined
      ? matches.length === 1
        ? matches[0]?.[0]
        : undefined
      : (PROVIDER_OF_CATALOG[catalogId] ?? catalogId);
  const provider = providerId === undefined ? undefined : providers[providerId];
  if (provider === undefined || providerId === undefined) return { choices: [] };
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const choices = Object.entries(provider.models).flatMap(([id, model]) => {
    if (
      model.tool_call !== true ||
      model.status === 'retiring' ||
      (model.retires !== undefined && model.retires <= today)
    )
      return [];
    return [
      {
        id: `${providerId}/${id}`,
        label: model.name,
        ...(model.limit?.context === undefined || model.limit.context === 0 ? {} : { context: model.limit.context }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      },
    ];
  });
  const curated =
    catalogId === undefined
      ? undefined
      : sources.catalogs[catalogId]?.opencode?.models.find(model => model.default === true)?.id;
  const preferred =
    curated === undefined
      ? undefined
      : choices.find(choice => choice.id === curated || choice.id === `${providerId}/${curated}`)?.id;
  return { choices, ...(preferred === undefined ? {} : { default: preferred }) };
}
