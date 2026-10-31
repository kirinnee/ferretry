import type { InputTarget, InputTargetFacts, SecretName } from '@ferretry/protocol';
import type { InputFieldValue, InputTargetPort, ObserveResult, TypeResult } from './ports.ts';

/** The secret store as a paste needs it: which names it holds, and replacing one. Never a value back. */
export interface SecretStoreDirectory {
  list(): Promise<readonly { readonly name: string }[]>;
  put(name: SecretName, value: string): Promise<unknown>;
}

/**
 * THE SECRET STORE AS AN INPUT TARGET (docs/secure-copy.md): the destination of a secure copy pasted "as the
 * secret NAME". What the daemon observes is whether NAME already holds a value, so the owner's card says whether
 * the paste adds a secret or replaces one. The one write puts the value in the vault, and only if that is still
 * true: a name that gained or lost a value since the card was drawn types nothing (`target_changed`), so a paste
 * the owner allowed as "new" can never overwrite a secret created meanwhile. Writes take turns, so two sessions
 * pasting into one new name cannot both find it empty: the second is refused.
 */
export class SecretStoreTarget implements InputTargetPort {
  /** The write in progress: each check-then-put waits for the one before it. */
  private turn: Promise<unknown> = Promise.resolve();

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
    const write = this.turn.then(async () => await this.write(target.key, only.text, expected.exists));
    this.turn = write;
    return await write;
  }

  private async write(name: SecretName, value: string, expected: boolean): Promise<TypeResult> {
    const exists = await this.holds(name);
    if (exists === undefined) return 'target_gone';
    if (exists !== expected) return 'target_changed';
    try {
      await this.directory.put(name, value);
      return 'typed';
    } catch {
      return 'uncertain';
    }
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
