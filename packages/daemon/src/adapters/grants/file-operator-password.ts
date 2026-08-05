import { z } from 'zod';
import type { FileSystemPort, OperatorPasswordPort } from '../../lib/index.ts';

/**
 * argon2id, at the parameters Bun's own defaults use for interactive verification.
 *
 * A MODERN MEMORY-HARD KDF, not a hash. The threat this defends against is somebody who has taken a
 * copy of the state home and is guessing offline, and against that a fast digest — SHA-256, even
 * salted — buys almost nothing: the whole cost of guessing is what makes a short, human-chosen
 * password survivable at all. 19 MiB and two passes is the OWASP interactive baseline; it costs a
 * few tens of milliseconds per attempt here, which is invisible behind a five-attempt limiter and
 * ruinous at scale.
 *
 * Bun ships argon2id, so this needs no dependency and no vendored implementation — the same reason
 * the secret cipher uses WebCrypto rather than pulling one in.
 */
const ARGON2 = { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2 } as const;

const SECRET_MODE = 0o600;

/**
 * The stored form.
 *
 * The digest carries its own salt and parameters — that is what a PHC string is — so nothing else is
 * recorded. There is deliberately no `updatedAt`, no length, no hint and no attempt counter: every
 * one of those is a fact about a password that would then live in a file, and none of them is needed
 * to check one.
 */
const VerifierDocumentSchema = z.strictObject({ argon2id: z.string().min(1) });

/**
 * The operator password, held as a verifier and never as a password.
 *
 * ## USE, NEVER READ
 *
 * There is no getter, and that is the feature rather than an omission. This class can answer "does a
 * verifier exist" and "does this candidate match", and it can replace or remove the verifier. It
 * cannot hand anything back, so no route, log line, report or error above it can leak a password —
 * not because callers are careful, but because they are never given one. Adding a reader here would
 * delete that property for the whole product, exactly as it would in the secret store.
 *
 * ## A PRESENT BUT UNREADABLE VERIFIER RAISES
 *
 * A truncated or corrupted file is NOT treated as "no password set". Reading damage as absence would
 * silently disarm the security layer on the one machine whose state is already known to be damaged —
 * and the operator would never be told. It throws, `refresh` turns that into undetermined grants, and
 * every governed capability closes until a human looks at it.
 */
export class FileOperatorPassword implements OperatorPasswordPort {
  constructor(
    private readonly path: string,
    private readonly files: FileSystemPort,
    private readonly hash: (password: string) => Promise<string> = async password =>
      await Bun.password.hash(password, ARGON2),
    private readonly check: (password: string, digest: string) => Promise<boolean> = async (password, digest) =>
      await Bun.password.verify(password, digest),
  ) {}

  async isSet(): Promise<boolean> {
    return (await this.read()) !== undefined;
  }

  async set(password: string): Promise<void> {
    const document = { argon2id: await this.hash(password) };
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`);
    await this.files.setMode(this.path, SECRET_MODE);
  }

  /**
   * Removing the verifier turns the security layer off for this machine.
   *
   * It writes an ABSENT verifier rather than deleting the file, so the act leaves a trace on disk
   * that a person can see; a file that simply vanished is indistinguishable from one that was never
   * created, and those are very different histories for a machine that gates remote configuration.
   */
  async clear(): Promise<void> {
    await this.files.writeTextAtomic(this.path, '{}\n');
    await this.files.setMode(this.path, SECRET_MODE);
  }

  /**
   * Whether a candidate matches.
   *
   * A MACHINE WITH NO VERIFIER ANSWERS `false`, never `true`. "There is nothing to check" must never
   * become "so everything passes": the caller above decides what an absent password means, and it
   * decides it in one place rather than having this port quietly answer yes.
   */
  async verify(password: string): Promise<boolean> {
    const digest = await this.read();
    if (digest === undefined) return false;
    return await this.check(password, digest);
  }

  private async read(): Promise<string | undefined> {
    const text = (await this.files.readText(this.path))?.trim();
    if (text === undefined || text === '') return undefined;
    const parsed: unknown = JSON.parse(text);
    // `{}` is the cleared state and means "no password", which is different from a file whose
    // contents are wrong — the first is a decision an operator made, the second is damage.
    if (typeof parsed === 'object' && parsed !== null && !('argon2id' in parsed)) return undefined;
    return VerifierDocumentSchema.parse(parsed).argon2id;
  }
}
