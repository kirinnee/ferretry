/**
 * Which system this daemon runs on, as the one fact the tool installer needs (which package managers to offer).
 *
 * Runtimes declares no `hostFacts` (that grant reaches `/proc` and the process list, far wider than one word), so the
 * word comes from `uname -s`, the way the Claude Code and Codex plugins ask it. The installer plans synchronously, so
 * the answer is looked up ahead ({@link HostPlatform.prime}, with the other lookups a read starts with) and read from
 * memory ({@link HostPlatform.name}). Until it is known the answer is `unknown`, which offers npm only: the safe
 * answer, never a Homebrew cask on a system that cannot take one.
 */
import type { SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';

const UNAME_TIMEOUT_MS = 5_000;

export class HostPlatform {
  #known: string | undefined;

  constructor(private readonly spawn: () => SpawnPort | undefined) {}

  /** The lower-cased system name (`darwin`, `linux`), or `unknown` before it has been asked or when it cannot be. */
  name(): string {
    return this.#known ?? 'unknown';
  }

  /** Ask once; a failed ask is retried at the next prime. */
  async prime(): Promise<void> {
    if (this.#known !== undefined) return;
    try {
      const result = await this.spawn()?.run('uname', ['-s'], { timeout: milliseconds(UNAME_TIMEOUT_MS) });
      const word = result?.exitCode === 0 ? result.stdout.trim().toLowerCase() : '';
      if (word !== '') this.#known = word;
    } catch {
      // Not asked, or refused: stay unknown.
    }
  }
}
