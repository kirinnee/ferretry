import type { InputTarget, InputTargetFacts } from '@ferretry/protocol';
import type {
  InputFieldValue,
  InputTargetField,
  InputTargetPort,
  ObserveResult,
  TerminalInputTargetPort,
  TypeResult,
} from './ports.ts';

/**
 * Sends each request to the adapter for its kind of surface: a terminal's (one value, one write) or a page's.
 * A page target with no browser adapter wired cannot take a request, and says so as `unsupported`.
 */
export class InputTargetRouter implements InputTargetPort {
  constructor(
    private readonly terminal: TerminalInputTargetPort,
    private readonly browser?: InputTargetPort,
  ) {}

  async observe(sessionId: string, target: InputTarget, fields: readonly InputTargetField[]): Promise<ObserveResult> {
    if (target.kind === 'browser') {
      return this.browser === undefined
        ? { ok: false, reason: 'unsupported' }
        : await this.browser.observe(sessionId, target, fields);
    }
    return fields.length === 1 ? await this.terminal.observe(sessionId, target) : { ok: false, reason: 'unsupported' };
  }

  async type(
    sessionId: string,
    target: InputTarget,
    values: readonly InputFieldValue[],
    submit: boolean,
    expected: InputTargetFacts,
  ): Promise<TypeResult> {
    if (target.kind === 'browser')
      return this.browser === undefined
        ? 'target_gone'
        : await this.browser.type(sessionId, target, values, submit, expected);
    const [only, ...rest] = values;
    // A terminal shows one prompt at a time: anything but exactly one value is refused with nothing typed.
    if (only === undefined || rest.length > 0) return 'target_changed';
    return await this.terminal.type(sessionId, target, only.text, submit, expected);
  }
}
