/**
 * Where this host's fleet names a secret, so a credential or component that cannot resolve is a line
 * on a screen rather than a session that dies at start.
 *
 * The secret listing already shows every configured reference and whether the store holds it —
 * `config/daemon.json`'s recipes were the only source of one. The account model is now another: a
 * credential from the environment, or a settings or MCP component, binds a variable to
 * `${secret:NAME}`, so that secret is exactly as missing, and exactly as visible in advance, as any
 * recipe's.
 *
 * IT READS THE CONFIGURATION, NOT THE MANIFEST, and the launch path is the other way around on
 * purpose. A launch must not depend on a document parsing, so it reads the published manifest. This is
 * a management read, and the configuration is the only place that knows WHICH component set a variable
 * — which is the whole answer somebody is looking for when they ask why a runtime is reaching for a
 * secret they have never heard of. A configuration that will not parse therefore fails this read,
 * loudly, naming itself; a fleet nobody has configured simply contributes nothing.
 */

import { type AccountModel, accountSecretReferences } from '@ferretry/fleet';
import type { SecretName } from '@ferretry/protocol';
import type { SecretReferenceSource } from '../secrets/index.ts';

/**
 * The declared account model, or `undefined` on a host that has none.
 *
 * The two are different facts and the caller owns the difference: absent means nobody has configured
 * a fleet here, and anything else — unreadable, unparseable, the old account format — is a failure this
 * read must surface rather than report as an empty list.
 */
export type DeclaredFleetSource = () => Promise<AccountModel | undefined>;

/** Every secret this host's account model names, with the credential or component that names each one. */
export class FleetSecretReferences implements SecretReferenceSource {
  constructor(private readonly declared: DeclaredFleetSource) {}

  async references(): Promise<readonly { readonly name: SecretName; readonly origin: string }[]> {
    const model = await this.declared();
    if (model === undefined) return [];
    return accountSecretReferences(model).map(reference => ({ name: reference.name, origin: reference.origin }));
  }
}
