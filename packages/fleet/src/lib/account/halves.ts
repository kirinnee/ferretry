/**
 * Which CLIs a login drives, and what each one is given (docs/provider-presets.md § One login, both
 * CLIs).
 *
 * A sign-in login drives the one CLI it signed in to. An ENVIRONMENT login drives one CLI too — its
 * `harness`, with its `env` and (Codex) its `codexProvider` at the top of the file — unless it has
 * HALVES: `claude:` and/or `codex:`, each with its own `env` (and, for Codex, its `codexProvider`). A
 * provider that serves both an Anthropic-compatible endpoint and a Responses endpoint is one login with
 * one secret and two halves, and a runtime on it runs whichever CLI it is for.
 *
 * With halves, the top-level `env` is SHARED: every half gets it, and a half's own variable of the same
 * name wins. `harness` still names one of the halves: the CLI a runtime on the login runs when nothing
 * else says (`./scope.ts` `runtimeHarness`).
 *
 * Pure.
 */
import type { HarnessKind } from '../manifest.ts';
import type { CodexProvider } from './environment.ts';

/** What one CLI is given by a login: its variables, and — Codex — the model provider it points at. */
export interface CredentialHalf {
  readonly env: Readonly<Record<string, string>>;
  readonly codexProvider?: CodexProvider;
}

/** The fields of a login this module reads. */
export interface HalvedCredential {
  readonly harness: HarnessKind;
  readonly store: 'host' | 'ferretry' | 'environment';
  readonly env?: Readonly<Record<string, string>>;
  readonly codexProvider?: CodexProvider;
  readonly claude?: { readonly env?: Readonly<Record<string, string>>; readonly codexProvider?: CodexProvider };
  readonly codex?: { readonly env?: Readonly<Record<string, string>>; readonly codexProvider?: CodexProvider };
}

const ORDER: readonly HarnessKind[] = ['claude', 'codex'];

/** Whether the login is written with `claude:` / `codex:` halves. */
export const hasHalves = (credential: HalvedCredential): boolean =>
  credential.store === 'environment' && (credential.claude !== undefined || credential.codex !== undefined);

/** Each CLI the login drives, with what that CLI is given. */
export function credentialHalves(credential: HalvedCredential): Partial<Record<HarnessKind, CredentialHalf>> {
  if (credential.store !== 'environment') return { [credential.harness]: { env: {} } };
  const shared = credential.env ?? {};
  if (!hasHalves(credential)) {
    return {
      [credential.harness]: {
        env: shared,
        ...(credential.codexProvider === undefined ? {} : { codexProvider: credential.codexProvider }),
      },
    };
  }
  const halves: Partial<Record<HarnessKind, CredentialHalf>> = {};
  for (const harness of ORDER) {
    const half = credential[harness];
    if (half === undefined) continue;
    halves[harness] = {
      env: { ...shared, ...half.env },
      ...(half.codexProvider === undefined ? {} : { codexProvider: half.codexProvider }),
    };
  }
  return halves;
}

/** The CLIs a login drives, Claude Code first. */
export const credentialHarnesses = (credential: HalvedCredential): readonly HarnessKind[] => {
  const halves = credentialHalves(credential);
  return ORDER.filter(harness => halves[harness] !== undefined);
};

/** Whether a login can drive `harness`. */
export const credentialServes = (credential: HalvedCredential, harness: HarnessKind): boolean =>
  credentialHarnesses(credential).includes(harness);

/** What `harness` is given by the login, or `undefined` when the login does not drive it. */
export const credentialHalf = (credential: HalvedCredential, harness: HarnessKind): CredentialHalf | undefined =>
  credentialHalves(credential)[harness];

/**
 * Every variable the login sets for any CLI, a half's own winning over the shared ones and Claude
 * Code's over Codex's for one name. For what judges the WHOLE login — which secrets it names, where it
 * sends a key, its Test and its quota — never for a launch, which reads one half.
 */
export function credentialVariables(credential: HalvedCredential): Readonly<Record<string, string>> {
  const halves = credentialHalves(credential);
  return Object.assign({}, ...ORDER.toReversed().map(harness => halves[harness]?.env ?? {}));
}

/** The login's Codex model provider, whichever shape it is written in. */
export const credentialCodexProvider = (credential: HalvedCredential): CodexProvider | undefined =>
  credentialHalves(credential).codex?.codexProvider;
