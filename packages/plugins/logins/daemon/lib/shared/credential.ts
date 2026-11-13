/**
 * A login as the code reasons about it: the parsed `config/logins/<id>.yaml` (`LoginFile`, parsed by the kernel's
 * config layer) with its harness as the code's kind (`claude` | `codex`) rather than the harness plugin's key.
 *
 * The cross-field rules today's `CredentialSchema.check` holds are ported as {@link credentialIssues}: the contract's
 * `LoginFileSchema` is shape only (its header says the port brings the rules), so a file that parses but breaks one is
 * reported by the sentence here instead of being launched with.
 *
 * Pure.
 */
import type { LoginFile } from '../../../contract/index.ts';
import { cloudCredentialVariable, parseCloudCredential, templatePlaceholders } from './environment.ts';
import {
  credentialCodexProvider,
  credentialHalves,
  credentialHarnesses,
  credentialVariables,
  hasHalves,
} from './halves.ts';
import { type HarnessKind, harnessKind } from './harness.ts';

export type Credential = Omit<LoginFile, 'harness'> & { readonly harness: HarnessKind };

/** A parsed login file as the code's {@link Credential}. */
export function credentialOf(file: LoginFile): Credential {
  return { ...file, harness: harnessKind(file.harness) };
}

/** Every rule that spans two fields, as sentences naming the field; empty when the login is usable. */
export function credentialIssues(credential: Credential): readonly string[] {
  const issues: string[] = [];
  if (credential.store !== 'environment') {
    for (const field of ['env', 'preset', 'cloudCredential', 'codexProvider', 'claude', 'codex'] as const) {
      if (credential[field] === undefined) continue;
      issues.push(
        `"${field}" belongs only to a login with store: environment — this one is store: ${credential.store}`,
      );
    }
    return issues;
  }
  const halved = hasHalves(credential);
  if (halved) {
    if (credential[credential.harness] === undefined) {
      issues.push(
        `"harness: ${credential.harness}" must name one of this login's halves (${credentialHarnesses(credential).join(', ')})`,
      );
    }
    if (credential.codexProvider !== undefined) {
      issues.push('"codexProvider" goes inside "codex:" when the login has halves');
    }
    if (credential.claude?.codexProvider !== undefined) {
      issues.push('"codexProvider" points Codex at a model provider — it goes in "codex:", not "claude:"');
    }
  } else if (credential.codexProvider !== undefined && credential.harness !== 'codex') {
    issues.push('"codexProvider" points Codex at a model provider — this login is for Claude Code');
  }
  const all = credentialVariables(credential);
  if (
    Object.keys(all).length === 0 &&
    credentialCodexProvider(credential) === undefined &&
    credential.cloudCredential === undefined
  ) {
    issues.push('a login kept in the environment must say which variables authenticate it, in "env"');
  }
  const codex = credentialHalves(credential).codex;
  const provider = codex?.codexProvider;
  if (codex !== undefined && provider !== undefined) {
    const env = codex.env;
    if (provider.keyVariable !== undefined && env[provider.keyVariable] === undefined) {
      issues.push(
        `the Codex provider sends its key from ${provider.keyVariable}, so "env" must set ${provider.keyVariable} (as \${secret:NAME})`,
      );
    }
    for (const name of templatePlaceholders(provider.baseUrl ?? '')) {
      if (env[name] === undefined)
        issues.push(`the Codex provider's base URL names {${name}}, so "env" must set ${name}`);
    }
  }
  const reference =
    credential.cloudCredential === undefined ? undefined : parseCloudCredential(credential.cloudCredential);
  const variable = reference === undefined ? undefined : cloudCredentialVariable(reference);
  if (variable !== undefined && all[variable] !== undefined) {
    issues.push(`${variable} comes from "cloudCredential" (${credential.cloudCredential}) — leave it out of "env"`);
  }
  return issues;
}
