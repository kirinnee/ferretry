import type { InputShot, InputTarget, InputTargetFacts } from '@ferretry/protocol';
import type {
  InputFieldValue,
  InputTargetField,
  InputTargetPort,
  ObserveResult,
  TerminalInputTargetPort,
  TypeResult,
} from './ports.ts';

/**
 * Sends each request to the adapter for its kind of target: a terminal's (one value, one write), a page's, or the
 * secret store's (a paste saved as a secret).
 * A page target with no browser adapter wired cannot take a request, and says so as `unsupported`.
 */
export class InputTargetRouter implements InputTargetPort {
  constructor(
    private readonly terminal: TerminalInputTargetPort,
    private readonly browser?: InputTargetPort,
    /** The secret store, for a paste saved as a secret (docs/secure-copy.md). */
    private readonly store?: InputTargetPort,
  ) {}

  async observe(sessionId: string, target: InputTarget, fields: readonly InputTargetField[]): Promise<ObserveResult> {
    if (target.kind === 'secret')
      return this.store === undefined
        ? { ok: false, reason: 'unsupported' }
        : await this.store.observe(sessionId, target, fields);
    if (target.kind === 'browser') {
      return this.browser === undefined
        ? { ok: false, reason: 'unsupported' }
        : await this.browser.observe(sessionId, target, fields);
    }
    return fields.length === 1 ? await this.terminal.observe(sessionId, target) : { ok: false, reason: 'unsupported' };
  }

  async refind(
    sessionId: string,
    target: InputTarget,
    fields: readonly InputTargetField[],
    expected: InputTargetFacts,
  ): Promise<ObserveResult> {
    if (target.kind === 'browser')
      return this.browser?.refind === undefined
        ? { ok: false, reason: 'unsupported' }
        : await this.browser.refind(sessionId, target, fields, expected);
    // A terminal is one pane and the secret store one name: finding them again is looking again.
    return await this.observe(sessionId, target, fields);
  }

  async type(
    sessionId: string,
    target: InputTarget,
    values: readonly InputFieldValue[],
    submit: boolean,
    expected: InputTargetFacts,
  ): Promise<TypeResult> {
    if (target.kind === 'secret')
      return this.store === undefined
        ? 'target_gone'
        : await this.store.type(sessionId, target, values, submit, expected);
    if (target.kind === 'browser')
      return this.browser === undefined
        ? 'target_gone'
        : await this.browser.type(sessionId, target, values, submit, expected);
    const [only, ...rest] = values;
    // A terminal shows one prompt at a time: anything but exactly one value is refused with nothing typed.
    if (only === undefined || rest.length > 0) return 'target_changed';
    return await this.terminal.type(sessionId, target, only.text, submit, expected);
  }

  async document(sessionId: string, key: string): Promise<string | undefined> {
    return await this.browser?.document?.(sessionId, key);
  }

  /** Only a page is ever probed: a terminal's program could count a wrong password, so it is never typed at for a test. */
  async probe(
    sessionId: string,
    target: InputTarget,
    facts: InputTargetFacts,
    fieldIds: readonly string[],
  ): Promise<'hidden' | 'shown' | 'aborted'> {
    if (target.kind !== 'browser' || this.browser?.probe === undefined) return 'aborted';
    return await this.browser.probe(sessionId, target, facts, fieldIds);
  }

  async shoot(sessionId: string, target: InputTarget, facts: InputTargetFacts): Promise<InputShot | undefined> {
    // A terminal's card draws its own text; only a page is pictured.
    return target.kind === 'browser' ? await this.browser?.shoot?.(sessionId, target, facts) : undefined;
  }
}
