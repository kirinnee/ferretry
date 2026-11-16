import type { RootsPort } from '@ferretry/kernel/contract';

/** `~/.claude.json` is a few KiB; a larger one is not read at all. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * The organisation type the person's own Claude account file records (`oauthAccount.organizationType`), for a login kept by
 * the host (`store: host`), whose file is `~/.claude.json` and which Logins' own store cannot reach. The ONE non-secret
 * field read: the rest of the document is parsed only to find it and dropped, no token is looked at, and nothing is kept.
 * An absent, unreadable, oversized or malformed file, or a field that is not a non-empty string, is `undefined`.
 */
export async function hostOrganizationType(
  roots: Pick<RootsPort, 'root'>,
  userHome: string,
): Promise<string | undefined> {
  try {
    const home = roots.root('harness-home', { subfolder: userHome });
    const placed = home.resolve('.claude.json');
    if (!placed.ok) return undefined;
    const info = await home.stat(placed.value);
    if (info === undefined || info.kind !== 'file' || info.size > MAX_BYTES) return undefined;
    const document: unknown = JSON.parse(await home.readText(placed.value, MAX_BYTES));
    const account = (document as { oauthAccount?: unknown } | null)?.oauthAccount;
    const type = (account as { organizationType?: unknown } | null | undefined)?.organizationType;
    return typeof type === 'string' && type !== '' ? type : undefined;
  } catch {
    return undefined;
  }
}
