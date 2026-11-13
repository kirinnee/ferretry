import type { FerretId } from '@ferretry/kernel/contract';
import type { VaultApi } from '@ferretry/core-vault/contract';
import type { SecretChildOutcome, SecretChildRunner, SecretChildSpec } from '../../lib/local-ports.ts';
import { SecureCopyError, type CopyMasking } from '../../lib/secure-copy/index.ts';

/**
 * THE SEALED COMMAND RUNNER (docs/secure-copy.md, "Capturing"): a command copy's program runs through the VAULT's child
 * runner, which is the one place that spawns with an allowlisted environment (no admin token, none of the daemon's own
 * secrets): NO shell, stdin closed, a timeout and a byte cap. What it printed goes once to the copy service, which seals
 * stdout and masks stderr before anybody else sees a byte. A Vault that offers no runner starts nothing.
 *
 * NOTHING HERE QUOTES THE COMMAND: a spawn failure says that it failed and nothing about what was spawned.
 */
export class VaultCopyRunner implements SecretChildRunner {
  constructor(private readonly vault: () => Pick<VaultApi, 'captureCommand'> | undefined) {}

  async run(spec: SecretChildSpec): Promise<SecretChildOutcome> {
    const capture = this.vault()?.captureCommand;
    if (capture === undefined) return { outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false };
    try {
      return await capture({
        command: spec.command,
        cwd: spec.cwd,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
      });
    } catch {
      return { outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false };
    }
  }
}

/**
 * THE MASKING REGISTRY, through the Vault (`VaultApi.maskCopy`): from the moment a copy is held, its value is masked
 * wherever the daemon scrubs text. A Vault that offers no registry REFUSES the capture: a value held where nothing masks it
 * would be an honest-looking lie.
 */
export class VaultCopyMasking implements CopyMasking {
  constructor(private readonly vault: () => Pick<VaultApi, 'maskCopy'> | undefined) {}

  holdUntil(sessionId: string, value: string, marker: string, until: number): void {
    const registry = this.vault()?.maskCopy;
    if (registry === undefined)
      throw new SecureCopyError('unavailable', 'Secure copy is not available: nothing here can mask a held value.');
    registry.hold(sessionId as FerretId, value, marker, until);
  }

  retime(sessionId: string, marker: string, until: number): void {
    this.vault()?.maskCopy?.retime(sessionId as FerretId, marker, until);
  }
}
