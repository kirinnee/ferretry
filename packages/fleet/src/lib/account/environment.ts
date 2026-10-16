/**
 * The two things an ENVIRONMENT login (`store: environment`) can carry beyond its variables
 * (docs/provider-presets.md):
 *
 * - **A cloud credential reference** — `aws-profile:<name>`, `gcloud-adc`, `gcloud-adc:<path>` or
 *   `azure-cli`. It names a credential this machine already has and is kept as that name, never as a
 *   copy: Ferretry hands the CLI the variable that points at it (`AWS_PROFILE`,
 *   `GOOGLE_APPLICATION_CREDENTIALS`) or nothing at all, and the cloud's own SDK inside the CLI reads
 *   the credential where it already lives. Clone copies the reference and says the target needs it.
 * - **A Codex model provider** — the `model_providers.<id>` table Codex reads from `config.toml`,
 *   given to the runtime as `-c` launch flags so Ferretry never writes anybody's `~/.codex`. The key it
 *   authenticates with travels the way every secret does: `env_key` names a variable, and that variable
 *   is `${secret:NAME}` in the login's own environment.
 *
 * Pure: strings in, strings out.
 */
import { isLoopbackHost } from '@ferretry/protocol';
import { z } from 'zod';
import { EnvNameSchema } from '../config.ts';

// ── Cloud credential references ──────────────────────────────────────────────────────────────────

/** A cloud credential reference, read. */
export type CloudCredentialReference =
  | { readonly kind: 'aws-profile'; readonly profile: string }
  | { readonly kind: 'gcloud-adc'; readonly path?: string }
  | { readonly kind: 'azure-cli' };

/** An AWS profile name as the AWS CLI accepts one in `~/.aws/config`: no spaces, no brackets. */
const AWS_PROFILE = /^[A-Za-z0-9_.+=,@-]{1,64}$/u;

/** A credentials file: absolute, or under the person's home, and nothing a shell would expand. */
const CREDENTIALS_PATH = /^(?:\/|~\/)[^\s$`"'\\]+$/u;

/** Read a reference, or `undefined` when it is not one. Total over every string. */
export function parseCloudCredential(text: string): CloudCredentialReference | undefined {
  if (text === 'azure-cli') return { kind: 'azure-cli' };
  if (text === 'gcloud-adc') return { kind: 'gcloud-adc' };
  const separator = text.indexOf(':');
  if (separator < 0) return undefined;
  const kind = text.slice(0, separator);
  const rest = text.slice(separator + 1);
  if (kind === 'aws-profile' && AWS_PROFILE.test(rest)) return { kind: 'aws-profile', profile: rest };
  if (kind === 'gcloud-adc' && CREDENTIALS_PATH.test(rest) && !rest.split('/').includes('..')) {
    return { kind: 'gcloud-adc', path: rest };
  }
  return undefined;
}

export const CloudCredentialSchema = z.string().check(ctx => {
  if (parseCloudCredential(ctx.value) !== undefined) return;
  ctx.issues.push({
    code: 'custom',
    message: `"${ctx.value}" is not a cloud credential reference — write aws-profile:<profile>, gcloud-adc, gcloud-adc:<path to a credentials file> or azure-cli`,
    input: ctx.value,
  });
});

/** The variable a reference is given to the CLI as, when it is given as one. */
export function cloudCredentialVariable(reference: CloudCredentialReference): string | undefined {
  if (reference.kind === 'aws-profile') return 'AWS_PROFILE';
  if (reference.kind === 'gcloud-adc' && reference.path !== undefined) return 'GOOGLE_APPLICATION_CREDENTIALS';
  return undefined;
}

/**
 * What the CLI is launched with for a reference: the profile NAME or the file's PATH, never what is in
 * it. `gcloud-adc` with no path and `azure-cli` need nothing — the cloud SDK inside the CLI finds the
 * default credentials itself.
 */
export function cloudCredentialEnvironment(
  reference: CloudCredentialReference,
  userHome: string,
): Readonly<Record<string, string>> {
  if (reference.kind === 'aws-profile') return { AWS_PROFILE: reference.profile };
  if (reference.kind === 'gcloud-adc' && reference.path !== undefined) {
    const path = reference.path.startsWith('~/')
      ? `${userHome.replace(/\/+$/u, '')}/${reference.path.slice(2)}`
      : reference.path;
    return { GOOGLE_APPLICATION_CREDENTIALS: path };
  }
  return {};
}

/** A reference in words: "your AWS profile acme-dev on this machine". */
export function cloudCredentialSentence(reference: CloudCredentialReference): string {
  switch (reference.kind) {
    case 'aws-profile':
      return `your AWS profile ${reference.profile} on this machine`;
    case 'gcloud-adc':
      return reference.path === undefined
        ? 'your Google application-default credentials on this machine (gcloud auth application-default login)'
        : `the Google credentials file ${reference.path} on this machine`;
    default:
      return 'whoever is signed in to the Azure CLI on this machine (az login)';
  }
}

// ── Codex model providers ────────────────────────────────────────────────────────────────────────

/**
 * Codex's own providers, which it configures itself: naming one is all it takes. A table under one
 * of these ids would override Codex's built-in definition, so it is refused.
 */
export const CODEX_BUILT_IN_PROVIDERS = ['openai', 'ollama', 'lmstudio', 'amazon-bedrock'] as const;

/** The one `wire_api` Codex accepts: `chat` was removed in 2026 (docs/provider-presets.md). */
export const CODEX_WIRE_API = 'responses' as const;

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/** A `{VARIABLE}` placeholder in a base URL, filled from the login's own plain variables at launch. */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

/** The placeholders a template names, in order of first appearance. */
export function templatePlaceholders(template: string): readonly string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1] as string))];
}

/** Whether `url` may carry a bearer token: HTTPS, or plain HTTP to this machine. */
export function isCredentialSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
  } catch {
    return false;
  }
}

/** A base URL with every placeholder replaced by a DNS-label-shaped sample, to check its shape. */
const sampleUrl = (template: string): string => template.replace(PLACEHOLDER, 'sample');

export const CodexProviderSchema = z
  .strictObject({
    /** The `model_providers` key, and the `model_provider` a runtime selects. */
    id: z.string().regex(PROVIDER_ID, { message: 'use lowercase letters, digits, dashes and underscores' }),
    /** Shown by Codex. */
    name: z.string().min(1).max(100).optional(),
    /** Where Codex sends its requests: `https://…`, or `http://` to this machine. May hold `{VARIABLE}`. */
    baseUrl: z.string().min(1).max(512).optional(),
    /** The variable whose value Codex sends as its bearer token. Must be one of the login's own. */
    keyVariable: EnvNameSchema.optional(),
    /** The model a runtime on this login starts on, unless its profile names one. */
    model: z.string().min(1).max(120).optional(),
    /** Extra query parameters on every request (`api-version` on an older Azure endpoint). */
    queryParams: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u), z.string().max(200)).optional(),
  })
  .check(ctx => {
    const provider = ctx.value;
    const builtIn = (CODEX_BUILT_IN_PROVIDERS as readonly string[]).includes(provider.id);
    if (builtIn) {
      if (provider.baseUrl !== undefined || provider.name !== undefined || provider.queryParams !== undefined) {
        ctx.issues.push({
          code: 'custom',
          message: `"${provider.id}" is one of Codex's own providers — name it alone, without "name", "baseUrl" or "queryParams"`,
          input: provider,
          path: ['id'],
        });
      }
      return;
    }
    if (provider.baseUrl === undefined || provider.name === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: `a Codex provider of your own needs a "name" and a "baseUrl" (Codex's own are ${CODEX_BUILT_IN_PROVIDERS.join(', ')})`,
        input: provider,
        path: [provider.name === undefined ? 'name' : 'baseUrl'],
      });
      return;
    }
    if (!isCredentialSafeUrl(sampleUrl(provider.baseUrl))) {
      ctx.issues.push({
        code: 'custom',
        message: '"baseUrl" must be https:// (plain http only on this machine), because Codex sends its key there',
        input: provider.baseUrl,
        path: ['baseUrl'],
      });
    }
  });
export type CodexProvider = z.infer<typeof CodexProviderSchema>;

/** A TOML basic string. JSON's escapes are a subset TOML reads the same way. */
const tomlString = (value: string): string => JSON.stringify(value);

/** A dotted-key segment Codex splits on `.`: a bare key when it can be one, quoted otherwise. */
const tomlKey = (key: string): string => (/^[A-Za-z0-9_-]+$/u.test(key) ? key : tomlString(key));

/** The launch flags for a provider, or why there are none: a `{VARIABLE}` the login does not set plainly. */
export function codexProviderArgs(
  provider: CodexProvider,
  env: Readonly<Record<string, string>>,
): { readonly args: readonly string[] } | { readonly problem: string } {
  const select = ['-c', `model_provider=${tomlString(provider.id)}`];
  if (provider.baseUrl === undefined) return { args: select };
  const missing = templatePlaceholders(provider.baseUrl).filter(name => {
    const value = env[name];
    return value === undefined || !/^[A-Za-z0-9.-]+$/u.test(value);
  });
  if (missing.length > 0) {
    return {
      problem: `its Codex provider's base URL needs ${missing.join(', ')} set to a plain host name in the login's variables`,
    };
  }
  const baseUrl = provider.baseUrl.replace(PLACEHOLDER, (_, name: string) => env[name] as string);
  const table = `model_providers.${tomlKey(provider.id)}`;
  const set = (key: string, value: string): readonly string[] => ['-c', `${table}.${key}=${tomlString(value)}`];
  return {
    args: [
      ...set('name', provider.name ?? provider.id),
      ...set('base_url', baseUrl),
      ...(provider.keyVariable === undefined ? [] : set('env_key', provider.keyVariable)),
      ...set('wire_api', CODEX_WIRE_API),
      ...Object.entries(provider.queryParams ?? {})
        .toSorted(([left], [right]) => (left < right ? -1 : 1))
        .flatMap(([key, value]) => ['-c', `${table}.query_params.${tomlKey(key)}=${tomlString(value)}`]),
      ...select,
    ],
  };
}

/**
 * The flags that start a runtime on its provider's own model. Used only when the runtime's profile names
 * no model: a model set's default is passed by the launch already, and it must win.
 */
export function codexProviderModelArgs(model: string): readonly string[] {
  return ['-c', `model=${tomlString(model)}`];
}
