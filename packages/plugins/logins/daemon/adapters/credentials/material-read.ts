/**
 * Reading one sign-in store's material and making the free usage read with it: the ONE code both the owned store
 * (in-process) and the housekeeping worker (on its own thread) run, so moving the read to the worker changes where it
 * happens and never what it concludes.
 *
 * Material exists only inside these functions, for one read: what comes back is facts (a status, a truncated digest)
 * and a usage reading, never a blob or a token.
 */
import type { CredentialMaterial } from '../../lib/shared/identity.ts';
import type { HarnessKind } from '../../lib/shared/harness.ts';
import {
  type ActiveUsageRead,
  localCredentialFacts,
  type LocalCredentialFacts,
} from '../../lib/credentials/credential-status.ts';
import type { AnthropicUsageProbe } from './anthropic-usage-probe.ts';
import type { CodexUsageProbe } from './codex-usage-probe.ts';
import { credentialFingerprint } from './credential-classifier.ts';

/**
 * The three looks a store read takes, over the path type of whoever holds them: the kernel's `credentials` root on
 * the main thread (fenced paths) and its read-only grant in a worker (relative paths) are both this.
 */
export interface MaterialReader<P extends string = string> {
  lstat(path: P): Promise<{ readonly kind: string; readonly links?: number } | undefined>;
  stat(path: P): Promise<unknown>;
  readText(path: P): Promise<string>;
}

/** Today's readFileMaterial + readClaudeStoreFile: a link or a second name is refused, a missing or empty file is absent. */
export async function readStoreMaterial<P extends string>(
  root: MaterialReader<P>,
  path: P,
  harness: HarnessKind,
): Promise<CredentialMaterial> {
  if (harness === 'claude' && (await root.lstat(path))?.kind === 'symlink')
    return {
      outcome: 'unreadable',
      reason:
        'the Claude credential file is a symbolic link, which Claude replaces with a private copy on its next refresh',
    };
  if (harness === 'codex' && ((await root.lstat(path))?.links ?? 1) > 1)
    return {
      outcome: 'unreadable',
      reason: 'the Codex sign-in file has a second name (another link to it exists), so a ferret cannot be given it',
    };
  if ((await root.stat(path)) === undefined) return { outcome: 'absent' };
  const blob = (await root.readText(path)).trim();
  return blob.length === 0 ? { outcome: 'absent' } : { outcome: 'found', blob };
}

/** One read's material as facts: its status and a truncated digest, never the material. */
export function factsOfMaterial(harness: HarnessKind, material: CredentialMaterial): LocalCredentialFacts {
  return localCredentialFacts(
    harness,
    material,
    material.outcome === 'found' ? credentialFingerprint(material.blob) : undefined,
  );
}

/**
 * Today's MaterialCredentialReads.active: facts for the exact material whose token is sent, and the free read's answer;
 * a probe that throws is answered with a fixed failure and never the caught error.
 */
export async function activeUsageRead(
  harness: HarnessKind,
  material: CredentialMaterial,
  probes: {
    readonly anthropic: Pick<AnthropicUsageProbe, 'probeMaterial'>;
    readonly codex: Pick<CodexUsageProbe, 'probeMaterial'>;
  },
): Promise<ActiveUsageRead> {
  const local = factsOfMaterial(harness, material);
  try {
    const probe = harness === 'claude' ? probes.anthropic : probes.codex;
    return { result: await probe.probeMaterial(material), local };
  } catch {
    return { result: { usageBased: true, ok: false, credentialSignal: 'inconclusive' }, local };
  }
}
