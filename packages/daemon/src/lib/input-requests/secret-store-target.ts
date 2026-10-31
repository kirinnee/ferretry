import type { InputTarget, InputTargetFacts, SecretName } from '@ferretry/protocol';
import type { InputFieldValue, InputTargetPort, ObserveResult, TypeResult } from './ports.ts';

/** The secret store as a paste needs it: which names it holds, and storing one if it is still as seen. Never a value back. */
export interface SecretStoreDirectory {
  list(): Promise<readonly { readonly name: string }[]>;
  /** Checked and written in the store's own turn, against every other writer; see `SecretDirectory.putIf`. */
  putIf(name: SecretName, value: string, exists: boolean): Promise<'stored' | 'changed' | 'full' | 'unreadable'>;
}

/**
 * THE SECRET STORE AS AN INPUT TARGET (docs/secure-copy.md): the destination of a secure copy pasted "as the
 * secret NAME". What the daemon observes is whether NAME already holds a value, so the owner's card says whether
 * the paste adds a secret or replaces one. The one write puts the value in the vault, and only if that is still
 * true: a name that gained or lost a value since the card was drawn types nothing (`target_changed`), so a paste
 * the owner allowed as "new" can never overwrite a secret created meanwhile. The check and the write are one
 * turn of the store's own, shared with every other writer (the routes, an import, an MCP sign-in refresh), so
 * nothing lands between them and two pastes into one new name cannot both find it empty.
 */
export class SecretStoreTarget implements InputTargetPort {
  constructor(private readonly directory: SecretStoreDirectory) {}

  async observe(_sessionId: string, target: InputTarget): Promise<ObserveResult> {
    if (target.kind !== 'secret') return { ok: false, reason: 'unsupported' };
    const exists = await this.holds(target.key);
    return exists === undefined
      ? { ok: false, reason: 'unsupported' }
      : { ok: true, facts: { kind: 'secret', name: target.key, exists } };
  }

  async type(
    _sessionId: string,
    target: InputTarget,
    values: readonly InputFieldValue[],
    _submit: boolean,
    expected: InputTargetFacts,
  ): Promise<TypeResult> {
    const [only, ...rest] = values;
    if (target.kind !== 'secret' || expected.kind !== 'secret' || only === undefined || rest.length > 0)
      return 'target_changed';
    let outcome: Awaited<ReturnType<SecretStoreDirectory['putIf']>>;
    try {
      outcome = await this.directory.putIf(target.key, only.text, expected.exists);
    } catch {
      // It failed while writing: the value may or may not be there.
      return 'uncertain';
    }
    // A full or unreadable store refused before writing anything: nothing is there, so nothing is uncertain.
    return outcome === 'stored' ? 'typed' : outcome === 'changed' ? 'target_changed' : 'target_gone';
  }

  /** Whether the store holds the name; nothing when the store cannot say (it is never read as "it does not"). */
  private async holds(name: string): Promise<boolean | undefined> {
    try {
      return (await this.directory.list()).some(summary => summary.name === name);
    } catch {
      return undefined;
    }
  }
}
