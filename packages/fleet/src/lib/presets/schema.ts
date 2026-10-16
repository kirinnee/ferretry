/**
 * A provider preset (docs/provider-presets.md): everything Ferretry knows about running Claude Code or
 * Codex against one backend — the variables and which of them are secrets, the cloud credential
 * reference it takes, the Codex model provider, a cheap Test, where its quota is read from, and how
 * much of that could not be confirmed against the provider's own documentation.
 *
 * A preset is a TEMPLATE. A login made from one copies what it needs into its own file
 * (`logins/<id>.yaml`) and names the preset only for display, its Test and its quota source — so a
 * preset edited or removed later never changes what a login launches with.
 *
 * The built-in catalogue is `packages/fleet/presets/<id>.yaml`; a machine adds its own (or replaces a
 * built-in one by its id) with a file of the same shape in `$FY_HOME/config/presets/<id>.yaml`. The id is
 * the file name, as a login's is.
 *
 * Pure.
 */
import { CloudCredentialKindSchema, ProviderQuotaSourceSchema, SecretNameSchema } from '@ferretry/protocol';
import { z } from 'zod';
import { CodexProviderSchema } from '../account/environment.ts';
import { EnvNameSchema } from '../config.ts';
import { HarnessKindSchema } from '../manifest.ts';

const Text = z.string().min(1).max(600);

/** One variable a login made from the preset sets: a plain value, or a secret by its suggested name. */
export const PresetVariableSchema = z
  .strictObject({
    /** A plain value as the preset fills it in. `""` when the person must type one. */
    value: z.string().max(1024).optional(),
    /**
     * The secret's suggested NAME in the store; the login holds `${secret:NAME}`. Not `secret`: the
     * raw-secret detector reads a long value under a key named like a credential as a pasted key.
     */
    secretName: SecretNameSchema.optional(),
    /** Whether a login needs it. An optional variable left empty is left out of the login. */
    required: z.boolean().default(true),
    /** Whether an empty value is a deliberate value (`ANTHROPIC_API_KEY: ""` so a token wins). */
    allowEmpty: z.boolean().default(false),
    description: Text.optional(),
  })
  .check(ctx => {
    if ((ctx.value.value === undefined) === (ctx.value.secretName === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'a preset variable is exactly one of "value" (a plain value) or "secretName" (a secret name)',
        input: ctx.value,
        path: [],
      });
    }
  });
export type PresetVariable = z.infer<typeof PresetVariableSchema>;

/** The parts of an HTTP probe every kind that sends one shares. */
const PROBE_SHAPE = {
  /** The address, `https://…` (or `http://` to this machine). May hold `{VARIABLE}` from the login's plain values. */
  url: z.string().min(1).max(512),
  /** The variable whose secret authenticates the request (not `key`, for the reason `secretName` is not). */
  keyVariable: EnvNameSchema,
  /** The header the key rides in, lower case. */
  header: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/u)
    .default('authorization'),
  /** Written before the key and a space; `""` for a bare key. */
  scheme: z.string().max(32).default('Bearer'),
  /** Fixed headers, never a credential: `anthropic-version`. */
  headers: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/u), z.string().max(200)).default({}),
  /** What it does, in one sentence a person reads before pressing Test. */
  note: Text,
};

/**
 * How a login made from the preset is tested:
 *
 * - `request` — one authenticated read that costs nothing (a model list, a balance);
 * - `inference` — one message capped at one output token, sent only with the person's consent, for a
 *   provider that documents no free read;
 * - `local` — one unauthenticated read of a server on this machine;
 * - `none` — no test is offered, and `reason` says why.
 */
export const PresetTestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), ...PROBE_SHAPE }),
  z.strictObject({
    kind: z.literal('inference'),
    ...PROBE_SHAPE,
    /** The JSON body. `{VARIABLE}` is replaced by the login's plain value, JSON-escaped. */
    body: z.string().min(2).max(2048),
  }),
  z.strictObject({ kind: z.literal('local'), url: z.string().min(1).max(512), note: Text }),
  z.strictObject({ kind: z.literal('none'), reason: Text }),
]);
export type PresetTest = z.infer<typeof PresetTestSchema>;

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/u;

/** A preset file, as written. */
export const ProviderPresetFileSchema = z
  .strictObject({
    label: z.string().min(1).max(80),
    harness: HarnessKindSchema,
    summary: Text,
    /** The provider's own documentation for this setup. */
    docs: z.url(),
    /** When its facts were last checked against that documentation. */
    verified: z.string().regex(YYYY_MM_DD, { message: 'write the date as YYYY-MM-DD' }),
    /** Each fact that could not be confirmed there, in a sentence. Shown before anyone relies on it. */
    unverified: z.array(Text).default([]),
    env: z.record(EnvNameSchema, PresetVariableSchema).default({}),
    /** The cloud credential references a login made from it takes, and the one it suggests. */
    cloudCredential: z
      .strictObject({ kinds: z.array(CloudCredentialKindSchema).min(1), suggested: z.string().min(1) })
      .optional(),
    /** Codex only: the model provider a login made from it points Codex at. */
    codexProvider: CodexProviderSchema.optional(),
    /** Model ids the provider recommends, for display. */
    models: z.array(z.string().min(1).max(120)).default([]),
    test: PresetTestSchema,
    quota: z.strictObject({ source: ProviderQuotaSourceSchema, note: Text }),
    /** The pricing table equivalent cost is computed from, by name, when there is one. */
    pricing: z.string().min(1).max(64).optional(),
    /** Set when the preset cannot be used to add a login: why, and what to use instead. */
    unavailable: Text.optional(),
  })
  .check(ctx => {
    const preset = ctx.value;
    if (preset.codexProvider !== undefined && preset.harness !== 'codex') {
      ctx.issues.push({
        code: 'custom',
        message: '"codexProvider" belongs only to a Codex preset',
        input: preset.codexProvider,
        path: ['codexProvider'],
      });
    }
    const test = preset.test;
    if (
      (test.kind === 'request' || test.kind === 'inference') &&
      preset.env[test.keyVariable]?.secretName === undefined
    ) {
      ctx.issues.push({
        code: 'custom',
        message: `the test sends the key in ${test.keyVariable}, so "env" must make ${test.keyVariable} a secret`,
        input: test.keyVariable,
        path: ['test', 'keyVariable'],
      });
    }
  });
export type ProviderPresetFile = z.infer<typeof ProviderPresetFileSchema>;

/** A preset, with the id its file name gives it and where it came from. */
export interface ProviderPreset extends ProviderPresetFile {
  readonly id: string;
  readonly origin: 'built-in' | 'file';
}
