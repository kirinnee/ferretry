/**
 * A provider preset (docs/provider-presets.md): everything Ferretry knows about running Claude Code or
 * Codex against one backend — the variables and which of them are secrets, the cloud credential
 * reference it takes, the Codex model provider, a cheap Test, where its quota is read from, and how
 * much of that could not be confirmed against the provider's own documentation.
 *
 * A provider that serves both CLIs has a `claude:` half and a `codex:` half, so one login with one
 * secret drives either; the test, the quota source and the detection clues belong to the provider and
 * sit beside the halves.
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
import { type HarnessKind, HarnessKindSchema } from '../manifest.ts';

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

/** A host name as a base URL carries it: lowercase labels, no scheme, no port. */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/**
 * How a set of variables is recognised as this provider's (`./detect.ts`), each clue a fact the
 * provider documents — never a value of anybody's:
 *
 * - `hosts` — a base URL (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, a Codex `base_url`) on one of these
 *   hosts, or below one;
 * - `variables` — a variable only this provider's setup uses (`CLAUDE_CODE_USE_BEDROCK`, `ZAI_API_KEY`), or a
 *   family of them written `DEEPSEEK_*`;
 * - `keyPrefixes` — the documented start of the provider's keys (`sk-or-`). Only checked, never shown.
 */
export const PresetDetectSchema = z.strictObject({
  hosts: z.array(z.string().regex(HOST, { message: 'write a host name, such as api.example.com' })).default([]),
  /** A name, or a family of names written `PREFIX_*`. */
  variables: z
    .array(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$/u, {
        message: 'write a variable name, or NAME_* for every name it starts',
      }),
    )
    .default([]),
  keyPrefixes: z.array(z.string().regex(/^[A-Za-z0-9_-]{3,24}$/u)).default([]),
});
export type PresetDetect = z.infer<typeof PresetDetectSchema>;

/**
 * One CLI's half of a preset: what a login made from it gives Claude Code, or Codex, at launch. A
 * provider that serves both (an Anthropic-compatible endpoint AND a Responses endpoint) has both
 * halves, so ONE login with ONE secret drives either CLI.
 */
export const PresetHalfSchema = z.strictObject({
  /** This CLI's own guide at the provider, when it has one apart from the preset's `docs`. */
  docs: z.url().optional(),
  env: z.record(EnvNameSchema, PresetVariableSchema).default({}),
  /** Codex only: the model provider a login made from it points Codex at. */
  codexProvider: CodexProviderSchema.optional(),
  /** Model ids the provider recommends for this CLI, for display. */
  models: z.array(z.string().min(1).max(120)).default([]),
  /** Set when this half cannot be used: why, and what to use instead. The other half still can. */
  unavailable: Text.optional(),
});
export type PresetHalfFile = z.infer<typeof PresetHalfSchema>;

const HARNESSES = ['claude', 'codex'] as const;

/**
 * A preset file, as written. Two shapes, both current:
 *
 * - **halves** — `claude:` and/or `codex:`, each with its own `env` (and, for Codex, its
 *   `codexProvider`), for a provider one login can use from either CLI;
 * - **one CLI** — `harness:` with `env`, `codexProvider` and `models` at the top, the shape every
 *   preset had before halves. A machine's own file in that shape keeps working.
 */
export const ProviderPresetFileSchema = z
  .strictObject({
    label: z.string().min(1).max(80),
    summary: Text,
    /** The provider's own documentation for this setup. */
    docs: z.url(),
    /** When its facts were last checked against that documentation. */
    verified: z.string().regex(YYYY_MM_DD, { message: 'write the date as YYYY-MM-DD' }),
    /** Each fact that could not be confirmed there, in a sentence. Shown before anyone relies on it. */
    unverified: z.array(Text).default([]),
    /** One CLI only: which. Leave it out when the preset has `claude:` / `codex:` halves. */
    harness: HarnessKindSchema.optional(),
    /** One CLI only: its variables. */
    env: z.record(EnvNameSchema, PresetVariableSchema).optional(),
    /** One CLI only, Codex: the model provider a login made from it points Codex at. */
    codexProvider: CodexProviderSchema.optional(),
    /** One CLI only: model ids the provider recommends, for display. */
    models: z.array(z.string().min(1).max(120)).optional(),
    /** What a login made from it gives Claude Code. */
    claude: PresetHalfSchema.optional(),
    /** What a login made from it gives Codex. */
    codex: PresetHalfSchema.optional(),
    /** The cloud credential references a login made from it takes, and the one it suggests. */
    cloudCredential: z
      .strictObject({ kinds: z.array(CloudCredentialKindSchema).min(1), suggested: z.string().min(1) })
      .optional(),
    test: PresetTestSchema,
    quota: z.strictObject({ source: ProviderQuotaSourceSchema, note: Text }),
    /** The pricing table equivalent cost is computed from, by name, when there is one. */
    pricing: z.string().min(1).max(64).optional(),
    /** Set when the preset cannot be used to add a login: why, and what to use instead. */
    unavailable: Text.optional(),
    /** How a pasted or imported set of variables is recognised as this provider's (`./detect.ts`). */
    detect: PresetDetectSchema.optional(),
  })
  .check(ctx => {
    const preset = ctx.value;
    const push = (message: string, path: readonly PropertyKey[], input: unknown): void => {
      ctx.issues.push({ code: 'custom', message, input, path: [...path] });
    };
    const halved = preset.claude !== undefined || preset.codex !== undefined;
    if (halved) {
      for (const field of ['harness', 'env', 'codexProvider', 'models'] as const) {
        if (preset[field] !== undefined) {
          push(`"${field}" belongs inside "claude:" or "codex:" when the preset has halves`, [field], preset[field]);
        }
      }
    } else if (preset.harness === undefined) {
      push('say which CLI the preset is for: "harness: claude|codex", or "claude:" / "codex:" halves', ['harness'], {});
      return;
    }
    if (preset.codexProvider !== undefined && preset.harness !== 'codex') {
      push('"codexProvider" belongs only to a Codex preset', ['codexProvider'], preset.codexProvider);
    }
    if (preset.claude?.codexProvider !== undefined) {
      push(
        '"codexProvider" belongs in "codex:", not "claude:"',
        ['claude', 'codexProvider'],
        preset.claude.codexProvider,
      );
    }
    const halves = presetFileHalves(preset);
    const test = preset.test;
    if (
      (test.kind === 'request' || test.kind === 'inference') &&
      !Object.values(halves).some(half => half?.env[test.keyVariable]?.secretName !== undefined)
    ) {
      push(
        `the test sends the key in ${test.keyVariable}, so "env" must make ${test.keyVariable} a secret`,
        ['test', 'keyVariable'],
        test.keyVariable,
      );
    }
    // One secret per NAME: a name two halves share is the same key, so they must agree it is a secret.
    const kinds = new Map<string, 'plain' | 'secret'>();
    for (const half of Object.values(halves)) {
      for (const [name, variable] of Object.entries(half?.env ?? {})) {
        const kind = variable.secretName === undefined ? 'plain' : 'secret';
        if ((kinds.get(name) ?? kind) !== kind) {
          push(`${name} is a secret in one half and a plain value in the other`, ['codex', 'env', name], name);
        }
        kinds.set(name, kind);
      }
    }
  });
export type ProviderPresetFile = z.infer<typeof ProviderPresetFileSchema>;

/** One CLI's half of a preset, read: the shape both file shapes come to. */
export interface PresetHalf {
  readonly docs?: string;
  readonly env: Readonly<Record<string, PresetVariable>>;
  readonly codexProvider?: z.infer<typeof CodexProviderSchema>;
  readonly models: readonly string[];
  readonly unavailable?: string;
}

/** A file's halves, whichever shape it was written in. */
function presetFileHalves(file: ProviderPresetFile): Partial<Record<HarnessKind, PresetHalf>> {
  if (file.claude !== undefined || file.codex !== undefined) {
    return {
      ...(file.claude === undefined ? {} : { claude: file.claude }),
      ...(file.codex === undefined ? {} : { codex: file.codex }),
    };
  }
  const harness = file.harness as HarnessKind;
  return {
    [harness]: {
      env: file.env ?? {},
      ...(file.codexProvider === undefined ? {} : { codexProvider: file.codexProvider }),
      models: file.models ?? [],
    },
  };
}

/**
 * A preset, read: the id its file name gives it, where it came from, and its halves — whichever shape
 * the file was in.
 *
 * `harness`, `env`, `codexProvider` and `models` are what a reader that predates halves expects: the
 * first USABLE half's CLI (Claude Code before Codex), every variable and recommended model of every
 * usable half, and the Codex half's provider. A launch never reads them; it reads one half.
 */
export interface ProviderPreset {
  readonly id: string;
  readonly origin: 'built-in' | 'file';
  readonly label: string;
  readonly summary: string;
  readonly docs: string;
  readonly verified: string;
  readonly unverified: readonly string[];
  readonly halves: Readonly<Partial<Record<HarnessKind, PresetHalf>>>;
  readonly harness: HarnessKind;
  readonly env: Readonly<Record<string, PresetVariable>>;
  readonly codexProvider?: z.infer<typeof CodexProviderSchema>;
  readonly models: readonly string[];
  readonly cloudCredential?: ProviderPresetFile['cloudCredential'];
  readonly test: PresetTest;
  readonly quota: ProviderPresetFile['quota'];
  readonly pricing?: string;
  readonly unavailable?: string;
  readonly detect: PresetDetect;
}

/** The CLIs a preset has a USABLE half for, Claude Code first. Empty when the whole preset is unavailable. */
export function presetHarnesses(preset: Pick<ProviderPreset, 'halves' | 'unavailable'>): readonly HarnessKind[] {
  if (preset.unavailable !== undefined) return [];
  return HARNESSES.filter(harness => {
    const half = preset.halves[harness];
    return half !== undefined && half.unavailable === undefined;
  });
}

/** A checked file as a preset. */
export function presetFromFile(id: string, file: ProviderPresetFile, origin: ProviderPreset['origin']): ProviderPreset {
  const halves = presetFileHalves(file);
  const present = HARNESSES.filter(harness => halves[harness] !== undefined);
  const usable = present.filter(harness => halves[harness]?.unavailable === undefined);
  const harness = usable[0] ?? (present[0] as HarnessKind);
  // What a login from it gets: the usable halves (every half, for a preset that is not offered at all).
  const given = usable.length === 0 ? present : usable;
  const env: Record<string, PresetVariable> = {};
  for (const name of given) Object.assign(env, { ...halves[name]?.env, ...env });
  const codexProvider = given.includes('codex') ? halves.codex?.codexProvider : undefined;
  // A preset whose every half is unavailable is unavailable, with the halves' own reasons.
  const unavailable =
    file.unavailable ??
    (usable.length === 0 ? present.map(name => halves[name]?.unavailable as string).join(' ') : undefined);
  return {
    id,
    origin,
    label: file.label,
    summary: file.summary,
    docs: file.docs,
    verified: file.verified,
    unverified: file.unverified,
    halves,
    harness,
    env,
    ...(codexProvider === undefined ? {} : { codexProvider }),
    models: [...new Set(given.flatMap(name => halves[name]?.models ?? []))],
    ...(file.cloudCredential === undefined ? {} : { cloudCredential: file.cloudCredential }),
    test: file.test,
    quota: file.quota,
    ...(file.pricing === undefined ? {} : { pricing: file.pricing }),
    ...(unavailable === undefined ? {} : { unavailable }),
    detect: file.detect ?? { hosts: [], variables: [], keyPrefixes: [] },
  };
}
