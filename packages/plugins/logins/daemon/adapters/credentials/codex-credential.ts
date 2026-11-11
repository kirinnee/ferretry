/**
 * What `logins:openai`'s `credential()` asks of the machine (never of a harness): whether this login's Codex sign-in is a
 * file Ferretry owns and holds tokens, and the kernel's shared credential for that file.
 *
 * It reads FACTS ONLY (`OwnedLoginStore.local`: the closed-set state of the file, never a token) and it never renews: a
 * Codex refresh spends a single-use token, and Codex renews its own file in place through the link the kernel makes.
 * The file itself reaches Codex through the kernel (`RootsPort.shareCredential` -> `RootHandle.linkCredential`), so this
 * half hands out nothing but that opaque object.
 */
import { basename, dirname } from 'node:path';
import type { RootsPort, SharedCredential } from '@ferretry/kernel/contract';
import type { FleetCredentialCatalog } from '../../lib/credentials/credentials-service.ts';
import { notPlainFileSentence } from '../../lib/kinds.ts';
import type { OwnedLoginStore } from './owned-store.ts';

/** The one file a Codex sign-in is, and the plugin that links it into its ferret homes. */
const CODEX_CREDENTIAL_FILE = 'auth.json';
const CODEX_PLUGIN = 'codex';

/** The kernel's closed refusal word on an error it threw (`SharedTreeError.refusal`), never its message. */
function refusalOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('refusal' in error)) return undefined;
  return typeof error.refusal === 'string' ? error.refusal : undefined;
}

export interface CodexCredentialSource {
  /** Why this login's sign-in file cannot be used, in one sentence naming the login; `undefined` when it holds a sign-in. */
  problem(login: string): Promise<string | undefined>;
  /**
   * The kernel's shared credential for this login's file; `'not_own'` when the kernel refused it because the file is not a
   * plain file with a single name (a hard link to it, or a link in its place), which an owner can fix; `undefined` when
   * it would not share it for any other reason.
   */
  share(login: string): Promise<SharedCredential | 'not_own' | undefined>;
}

export function codexCredentialSource(deps: {
  readonly catalog: Pick<FleetCredentialCatalog, 'entry'>;
  readonly store: Pick<OwnedLoginStore, 'local'>;
  readonly roots: Pick<RootsPort, 'shareCredential'>;
}): CodexCredentialSource {
  const resolve = async (login: string) => (await deps.catalog.entry(login)).resolution;
  const source: CodexCredentialSource = {
    async problem(login) {
      const resolution = await resolve(login).catch(() => undefined);
      if (resolution === undefined) return `the login ${login} is not known on this machine`;
      if (resolution.store === 'environment') return `the login ${login} is not a sign-in`;
      if ('unavailable' in resolution) return `the login ${login} cannot be used: ${resolution.unavailable}`;
      if (resolution.store !== 'ferretry')
        return `the login ${login} cannot be used: this build can only read owned login stores`;
      if (resolution.harness !== 'codex' || !('canonicalFile' in resolution))
        return `the login ${login} is not a Codex sign-in`;
      const facts = await deps.store.local(resolution).catch(() => undefined);
      // A ChatGPT sign-in (`tokens`) or a key Codex was signed in with (`api_key`, a non-empty OPENAI_API_KEY): both are
      // the file Codex reads. An empty file, one without either, or one that cannot be read is not a sign-in.
      if (facts?.codex?.state !== 'tokens' && facts?.codex?.state !== 'api_key') {
        // A file with a second name (or a link in its place) cannot be read either, and would read as "not signed in": ask
        // the kernel whether that is why (a probe mint, never handed on), so the owner is told what to remove instead.
        if ((await source.share(login)) === 'not_own') return notPlainFileSentence(login);
        return `the login ${login} is not signed in; sign it in from Logins and start the ferret again`;
      }
      return undefined;
    },
    async share(login) {
      const resolution = await resolve(login).catch(() => undefined);
      if (resolution === undefined || resolution.store !== 'ferretry' || !('canonicalFile' in resolution))
        return undefined;
      return await deps.roots
        .shareCredential({
          folder: basename(dirname(resolution.canonicalFile)),
          file: CODEX_CREDENTIAL_FILE,
          receiver: CODEX_PLUGIN,
        })
        .catch((error: unknown) => (refusalOf(error) === 'not_own' ? ('not_own' as const) : undefined));
    },
  };
  return source;
}
