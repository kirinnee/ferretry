/**
 * SMALL PIECES THAT BELONG TO OTHER SUBSYSTEMS, HELD LOCALLY until their owners' contracts carry them.
 *
 * The services in this folder (the catalogue, the setup, the tool install) were written against one big library; the
 * rebuild splits that library among owners, and a plugin may import only another subsystem's `contract` (spine §4).
 * Each name below is the SMALLEST copy that keeps today's behaviour, with the owner named in its `GAP(...)` comment, so a
 * grep lists exactly what to swap when that contract lands. Nothing here is Runtimes' own logic.
 *
 * Pure: no IO.
 */
import type { z } from 'zod';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { HarnessKind } from '../manifest.ts';
import { type BrowserModeSchema, type BrowserPortsSettingSchema, ORIGIN_KEY_PATTERN } from '../../../contract/index.ts';

/** A runtime's old name and its new one (the edits that re-point every other file that names it). */
// GAP(kernel): `fleet/src/lib/config-files/render.ts`.
export interface RuntimeRename {
  readonly from: string;
  readonly to: string;
}

// ── the raw-secret detector ──────────────────────────────────────────────────────────────────────

// GAP(kernel): `fleet/src/lib/config-files/secrets.ts` (the config layer refuses a raw secret in a file; a change that
// would write one is refused here first, with the same test).

const KNOWN_SHAPES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/u,
  /\bsk-or-[A-Za-z0-9_-]{8,}/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bgsk_[A-Za-z0-9]{20,}/u,
  /\bcsk-[A-Za-z0-9]{20,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\bglpat-[A-Za-z0-9_-]{16,}/u,
];
const CREDENTIAL_KEY = /(?:(?:key|token|secret|password|passwd)s?|credentials?)$/iu;
const REFERENCE = /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/u;
const MIN_SECRET_LENGTH = 16;
const ENTROPY_THRESHOLD = 3.5;
const ORIGIN_KEY_FIELD = 'clonedFromKey';

function shannonEntropy(value: string): number {
  const characters = [...value];
  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / characters.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether `value`, found under `key`, looks like a raw secret. It never repeats the value. */
export function looksLikeRawSecret(
  key: string | number | undefined,
  value: string,
  options: { readonly topLevel?: boolean } = {},
): boolean {
  if (KNOWN_SHAPES.some(shape => shape.test(value))) return true;
  if (typeof key !== 'string' || !CREDENTIAL_KEY.test(key)) return false;
  if (options.topLevel === true && key === ORIGIN_KEY_FIELD && ORIGIN_KEY_PATTERN.test(value)) return false;
  const trimmed = value.trim();
  if (REFERENCE.test(trimmed) || trimmed.length < MIN_SECRET_LENGTH || /\s/u.test(trimmed)) return false;
  // A path or a URL under a "...key" name (a key file, a JWKS endpoint) is where a secret is, not one.
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu.test(trimmed)) return false;
  return shannonEntropy(trimmed) >= ENTROPY_THRESHOLD;
}

// ── the harness ──────────────────────────────────────────────────────────────────────────────────

/**
 * Whether Claude Code 2.1.281 offers fast mode on a model, from the id alone: `opus-4-8` or `opus-5` anywhere in it.
 * GAP(claude-code): the rule is the harness plugin's (`session/harness/fast-mode.ts`).
 */
export function claudeFastSupport(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes('opus-4-8') || id.includes('opus-5');
}

/**
 * The one place a harness's package names are spelled. GAP(updates): the harness update owns this table.
 */
export const HARNESS_PACKAGES: Readonly<
  Record<'claude' | 'codex', { readonly npm: string; readonly cask: string; readonly nixpkgs: string }>
> = {
  claude: { npm: '@anthropic-ai/claude-code', cask: 'claude-code', nixpkgs: 'claude-code' },
  codex: { npm: '@openai/codex', cask: 'codex', nixpkgs: 'codex' },
};

// ── sessions ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A session's status as a runtime change reads it. GAP(ferrets): Ferrets' contract has four states
 * (`starting`, `working`, `idle`, `stopped`); the sixteen-word vocabulary below is today's, kept so a removal or a
 * rename still counts exactly the sessions it counted. `sessionStatusOf` maps a Ferrets state onto it.
 */
export const SESSION_STATUSES = [
  'created',
  'starting',
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'retrying',
  'waiting',
  'kill_failed',
  'completed',
  'failed',
  'stalled',
  'stopped',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Ferrets' four states onto the status words: a `stopped` ferret is not running; the rest are. */
export function sessionStatusOf(state: 'starting' | 'working' | 'idle' | 'stopped'): SessionStatus {
  switch (state) {
    case 'starting':
      return 'starting';
    case 'working':
      return 'running';
    case 'idle':
      return 'waiting';
    case 'stopped':
      return 'stopped';
  }
}

// ── the browser settings a machine change carries ────────────────────────────────────────────────

// GAP(browsers): the types are Browsers' (`BrowserMode`, `BrowserPortsSetting`); the runtimes contract holds the schemas.
export type BrowserMode = z.infer<typeof BrowserModeSchema>;
export type BrowserPortsSetting = z.infer<typeof BrowserPortsSettingSchema>;

// ── finding a harness command ────────────────────────────────────────────────────────────────────

/**
 * What the tool installer needs to know about the host's executables. GAP(claude-code, codex): the harness plugins own
 * where `claude` and `codex` are (`core/harness-readiness.ts`); the installer only asks.
 */
export interface ExecutableResolverPort {
  /** The absolute executable a bare NAME resolves to on this host's `PATH`, or `undefined`. */
  resolve(name: string): string | undefined;
  /** Whether this host can run the program at this absolute path right now. */
  runnable(path: string): boolean;
}

/** Where one harness's own command is on this host. */
export type HarnessLocation =
  | { readonly kind: HarnessKind; readonly outcome: 'located'; readonly path: string }
  | { readonly kind: HarnessKind; readonly outcome: 'override-absent'; readonly path: string; readonly reason: string }
  | { readonly kind: HarnessKind; readonly outcome: 'absent'; readonly searched: readonly string[] };

// ── terminal output ──────────────────────────────────────────────────────────────────────────────

// GAP(logins): `fleet-login/output.ts` is the harness sign-in's; the escape stripping is the part the installer reuses.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const SHORT_ESCAPE = /\u001b[()#][0-9A-Za-z]|\u001b[<>=]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** One output line with every terminal escape and stray control character removed. */
export function stripTerminalEscapes(raw: string): string {
  return raw
    .replaceAll(OSC_SEQUENCE, '')
    .replaceAll(CSI_SEQUENCE, '')
    .replaceAll(SHORT_ESCAPE, '')
    .replaceAll(CONTROL_CHARACTERS, '');
}

// ── where a login keeps its sign-in ──────────────────────────────────────────────────────────────

/** The folder name under the fleet directory that holds each login's sign-in. GAP(logins): the store is Logins'. */
export const CREDENTIALS_DIRECTORY = 'credentials';

// ── harness words at the wire ────────────────────────────────────────────────────────────────────

/**
 * Inside the services a harness is `claude` or `codex` (the library's word); on the wire and in the configuration it is
 * the Ferrets key `claude-code` or `codex`. These two are the only places the two spellings meet.
 */
export const harnessKey = (kind: string): HarnessKey => (kind === 'claude' ? 'claude-code' : (kind as HarnessKey));

/** The library's word for a Ferrets harness key. */
export const harnessKind = (key: string): HarnessKind => (key === 'claude-code' ? 'claude' : (key as HarnessKind));

/** A scope word (`claude`, `codex`, `generic`) as the wire spells it. */
export const scopeKey = <Scope extends string>(scope: Scope): Exclude<Scope, 'claude'> | 'claude-code' =>
  scope === 'claude' ? 'claude-code' : (scope as Exclude<Scope, 'claude'>);

/** `T` with every `claude-code` value spelled `claude`: the change as the library reads it. */
export type LoweredHarness<T> = T extends 'claude-code'
  ? 'claude'
  : T extends string
    ? T
    : T extends readonly (infer Item)[]
      ? LoweredHarness<Item>[]
      : T extends object
        ? { -readonly [K in keyof T]: LoweredHarness<T[K]> }
        : T;

/** A change body read off the wire, with its harness values in the library's words. Pure; copies what it changes. */
export function lowerHarness<T>(value: T): LoweredHarness<T> {
  const lower = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(lower);
    if (typeof node !== 'object' || node === null) return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, item]) => [
        key,
        key === 'harness' && item === 'claude-code' ? 'claude' : lower(item),
      ]),
    );
  };
  return lower(value) as LoweredHarness<T>;
}

// ── a sign-in's own secrets ──────────────────────────────────────────────────────────────────────

/**
 * Whether a secret's name is one a sign-in filed itself: an MCP server's OAuth access token. A secret copy refuses these:
 * the token is half of a sign-in whose refresh half cannot travel, and a copy would be a login that is dead on the other
 * machine within the hour (docs/secrets.md). GAP(mcp): the name grammar is MCP's (`mcpOAuthSecretNames`); this is its shape.
 */
export function isSignInSecretName(name: string): boolean {
  return /^MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS$/u.test(name);
}

/** The refusal sentence for a key that is a sign-in's. */
export const SIGN_IN_NOT_COPIED = 'a sign-in is not copied: sign in on the other machine instead';
