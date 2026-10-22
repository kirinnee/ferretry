/**
 * The host facts the credentials surface reads, and the one child its sign-out runs
 * (docs/design/account-model.md §3.2, §8.1.1, §8.2.3, §9.4).
 *
 * Everything here is a READ of a file the harness or Ferretry already wrote, except
 * {@link runCredentialHarness}, which the sign-out executor alone calls on an applied change. Nothing
 * returns credential material: a Codex email comes from the store's kept facts, which carry its id
 * token's `email` claim and no token.
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import type { CodexStoreResolution, LocalCredentialFacts } from '@ferretry/fleet';
import type { RolloutFile } from '@ferretry/fleet/adapters';
import type { CredentialEmailSource, CredentialHarnessRun } from '../../lib/fleet/credentials-service.ts';

/** Creates a directory a sign-in writes into, readable by this user only. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

/** The account Claude recorded in a config directory's `.claude.json`. */
async function claudeEmail(accountFile: string): Promise<string | undefined> {
  try {
    const root = asRecord(JSON.parse(await readFile(accountFile, 'utf8')) as unknown);
    return nonEmpty(asRecord(root?.oauthAccount)?.emailAddress);
  } catch {
    return undefined;
  }
}

/** A Claude account file's email, and the file stamp it was read under. */
interface KeptClaudeEmail {
  readonly stamp: string;
  readonly email: string | undefined;
}

export interface CredentialEmailReaderDeps {
  /**
   * A Codex store's facts (`CachedCredentialReads.local`), which carry its id token's `email` claim — so
   * listing logins reads no `auth.json` the usage pass has already read, and holds no token.
   */
  codexFacts(resolution: CodexStoreResolution): Promise<LocalCredentialFacts>;
  /** A file's stamp (`credentialFileStamp`): a `.claude.json` is parsed again only once it changed. */
  stamp(path: string): Promise<string | undefined>;
  /** Claude emails by account file. A host `~/.claude.json` is large and rewritten by every running Claude. */
  readonly kept: Map<string, KeptClaudeEmail>;
}

/** Reads the display email of one login. `undefined` when the harness recorded none. */
export class CredentialEmailReader {
  constructor(private readonly deps: CredentialEmailReaderDeps) {}

  async email(source: CredentialEmailSource): Promise<string | undefined> {
    if (source.harness === 'claude') return await this.#claude(source.accountFile);
    const facts = await this.deps.codexFacts(source.resolution).catch(() => undefined);
    return facts?.codex?.state === 'tokens' ? facts.codex.email : undefined;
  }

  async #claude(accountFile: string): Promise<string | undefined> {
    const stamp = await this.deps.stamp(accountFile);
    const kept = this.deps.kept.get(accountFile);
    if (stamp !== undefined && kept?.stamp === stamp) return kept.email;
    const email = await claudeEmail(accountFile);
    if (stamp !== undefined) this.deps.kept.set(accountFile, { stamp, email });
    return email;
  }
}

const ROLLOUT_NAME = /\.jsonl(?:\.zst)?$/u;

/**
 * The rollout files a session's transcript records, with their modification times. A file that is
 * gone or is not a rollout is skipped.
 */
export async function rolloutFiles(paths: readonly string[]): Promise<readonly RolloutFile[]> {
  const files: RolloutFile[] = [];
  for (const path of new Set(paths)) {
    if (!ROLLOUT_NAME.test(path)) continue;
    try {
      const facts = await stat(path);
      if (facts.isFile()) files.push({ path, modifiedAt: Math.trunc(facts.mtimeMs) });
    } catch {
      // Gone since the session recorded it: nothing to read.
    }
  }
  return files;
}

/** How long a sign-out child may run. The harness's own logout is one local write and one revoke. */
const CREDENTIAL_HARNESS_TIMEOUT_MS = 60_000;

/**
 * Runs one harness child to completion with no stdio, and its exit code. A child that outlives the
 * timeout is killed and answers `-1`, so a hung logout cannot hold the change that started it.
 */
export async function runCredentialHarness(
  spec: CredentialHarnessRun,
  timeoutMs = CREDENTIAL_HARNESS_TIMEOUT_MS,
): Promise<number> {
  const child = Bun.spawn({
    cmd: [...spec.command],
    env: spec.environment,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const code = await child.exited;
    return timedOut ? -1 : code;
  } finally {
    clearTimeout(timer);
  }
}
