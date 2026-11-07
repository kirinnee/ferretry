import { randomBytes } from 'node:crypto';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import type { GateTokens } from '../../lib/api/authentication.ts';

/** 32 bytes of CSPRNG output, base64url so it survives a header and a shell (today's `mintToken`). */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The daemon's tokens, held in `state/gate/` (today's `StateApiCredentials`, through the kernel's secret store).
 *
 * They are minted on first use rather than configured: a token in a configuration file is a token in a backup, in a
 * dotfile repository and in a screen share. Both are always present, so the warden-scoped surface exists from the
 * first boot. A blank file is treated as absent: an empty secret authenticates nothing, so leaving it would lock the
 * operator out of their own daemon. The kernel's secret store writes `0600` and refuses links and device files.
 */
export class StateTokens {
  constructor(
    private readonly state: StatePort,
    private readonly files: { readonly admin: StateFileDef; readonly warden: StateFileDef },
    private readonly mint: () => string = mintToken,
  ) {}

  async load(): Promise<GateTokens> {
    return { admin: await this.#tokenAt(this.files.admin), warden: await this.#tokenAt(this.files.warden) };
  }

  async #tokenAt(file: StateFileDef): Promise<string> {
    const read = await this.state.read(file as StateFileDef<string, Uint8Array | string>);
    if (!read.ok) throw new Error(read.error.sentence);
    const existing = decode(read.value)?.trim();
    if (existing !== undefined && existing !== '') return existing;
    const minted = this.mint();
    await this.state.write(file as StateFileDef<string, string>, `${minted}\n`);
    return minted;
  }
}

function decode(value: Uint8Array | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}
