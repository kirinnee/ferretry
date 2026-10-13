/**
 * The host facts the credentials surface reads, and the one child its sign-out runs
 * (docs/design/account-model.md §3.2, §8.1.1, §8.2.3, §9.4).
 *
 * Everything here is a READ of a file the harness or Ferretry already wrote, except
 * {@link runCredentialHarness}, which the sign-out executor alone calls on an applied change. Nothing
 * returns credential material: the email reader parses a Codex id token and keeps only its `email`
 * claim, and the document reader hands back the parsed configuration, which holds no secret value.
 */
import { type CredentialMaterial, type FleetDocument, readFleetDocument } from '@ferretry/fleet';
import type { RolloutFile } from '@ferretry/fleet/adapters';
import { mkdir, readFile, stat } from 'node:fs/promises';
import type { CredentialEmailSource, CredentialHarnessRun } from '../../lib/fleet/credentials-service.ts';

/** The machine's fleet document, or `undefined` when the file does not exist yet. */
export async function readFleetDocumentFile(path: string): Promise<FleetDocument | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return readFleetDocument(Bun.YAML.parse(text) ?? {});
}

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

/** The `email` claim of a Codex `auth.json`'s id token. The signature is not checked: display only. */
export function codexEmail(material: CredentialMaterial): string | undefined {
  if (material.outcome !== 'found') return undefined;
  try {
    const token = nonEmpty(asRecord(asRecord(JSON.parse(material.blob) as unknown)?.tokens)?.id_token);
    const payload = token?.split('.')[1];
    if (payload === undefined || payload.length === 0) return undefined;
    return nonEmpty(asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown)?.email);
  } catch {
    return undefined;
  }
}

/** The account Claude recorded in a config directory's `.claude.json`. */
async function claudeEmail(accountFile: string): Promise<string | undefined> {
  try {
    const root = asRecord(JSON.parse(await readFile(accountFile, 'utf8')) as unknown);
    return nonEmpty(asRecord(root?.oauthAccount)?.emailAddress);
  } catch {
    return undefined;
  }
}

export interface CredentialEmailReaderDeps {
  /** The Codex store's raw material (`PlatformFleetCredentialStore.storedMaterial`). Read and dropped. */
  storedMaterial(
    resolution: Extract<CredentialEmailSource, { harness: 'codex' }>['resolution'],
  ): Promise<CredentialMaterial>;
}

/** Reads the display email of one login. `undefined` when the harness recorded none. */
export class CredentialEmailReader {
  constructor(private readonly deps: CredentialEmailReaderDeps) {}

  async email(source: CredentialEmailSource): Promise<string | undefined> {
    if (source.harness === 'claude') return await claudeEmail(source.accountFile);
    return codexEmail(
      await this.deps.storedMaterial(source.resolution).catch((): CredentialMaterial => ({ outcome: 'absent' })),
    );
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
