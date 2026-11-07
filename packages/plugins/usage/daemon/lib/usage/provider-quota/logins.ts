import type { LoginList, ProviderPresetCatalog } from '../../../../contract/index.ts';
import type { ProviderQuotaLogin } from './plan.ts';

/**
 * Every environment login as the quota reader needs it, built from what Logins publishes (`LoginView.environment`) and the
 * preset catalogue. Pure. A secret variable becomes `${secret:NAME}` only when it names exactly one secret; a hidden one
 * is left out, so the reader asks the Vault by NAME and never holds a value. Harness sign-ins have no quota endpoint and
 * are not listed.
 */
export function providerQuotaLogins(list: LoginList, presets: ProviderPresetCatalog): readonly ProviderQuotaLogin[] {
  return list.logins.flatMap(login => {
    const environment = login.environment;
    if (login.store !== 'environment' || environment === undefined) return [];
    const preset = presets.presets.find(candidate => candidate.id === environment.preset?.id);
    const variables: Record<string, string> = {};
    for (const variable of environment.variables) {
      if (variable.kind === 'plain') variables[variable.name] = variable.value;
      else if (variable.kind === 'secret' && variable.secrets.length === 1)
        variables[variable.name] = `\${secret:${variable.secrets[0]}}`;
    }
    const secretVariables = preset?.variables.filter(variable => variable.kind === 'secret') ?? [];
    const keyed = secretVariables.length === 1 ? secretVariables[0] : undefined;
    return [
      {
        id: login.id,
        source: environment.quotaSource,
        variables,
        ...(keyed === undefined ? {} : { keyVariable: keyed.name }),
        ...(keyed?.secret === undefined ? {} : { presetSecretName: keyed.secret }),
        ...(environment.codexProvider?.baseUrl === undefined ? {} : { codexBaseUrl: environment.codexProvider.baseUrl }),
        builtIn: preset?.origin === 'built-in',
        unverified: (preset?.unverified.length ?? 0) > 0,
        agent: login.id,
      },
    ];
  });
}
