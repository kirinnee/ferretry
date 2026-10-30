import { type InputRequest, inputValueProblem, padInputValue } from '@ferretry/protocol';
import { parseAgendaReference } from '../agenda/reference.ts';
import type { InputPorts } from './ports.ts';
import { describeInputReason, inputTargetReference, renderInputFacts, renderInputList } from './render.ts';

/** Options every input command accepts. */
export interface InputCommandOptions {
  /** The session whose requests these are. An owner's shell has none of its own, so it is required. */
  readonly session?: string | undefined;
  readonly json?: boolean | undefined;
}

/** Flags on `fy input answer`. There is deliberately no flag that carries a value. */
export interface InputAnswerOptions extends InputCommandOptions {
  /** `--no-enter` is `false`; `--enter` (browser targets) is `true`. */
  readonly enter?: boolean | undefined;
  /** The owner ticked "I trust this program" for a program not known to ask for secrets. */
  readonly trustProgram?: boolean | undefined;
}

/** Said when a ferret reaches for the owner's command. */
export const FERRET_REFUSAL = "this is the owner's command; a ferret cannot answer an input request";

function target(options: InputCommandOptions): string {
  const session = options.session?.trim() ?? '';
  if (session === '') throw new Error('name the session with --session <id>: an input request belongs to one session');
  return session;
}

/** Whether pressing Enter after typing is on: the owner's flag wins, then the request's own mode, then the default. */
function submitAfter(request: InputRequest, options: InputAnswerOptions): boolean {
  if (request.submit === 'agent') return false;
  if (options.enter !== undefined) return options.enter;
  return request.target.kind === 'terminal';
}

/**
 * Drives `fy input ls|answer|cancel`.
 *
 * OWNER-ONLY, IN THE CLI TOO. A ferret runs this binary in its own pane with `FY_SESSION_ID` and its
 * credential in the environment; either one refuses the command before it reads or sends anything. The
 * daemon refuses again, because this check is the courteous one and a hostile caller does not run it.
 *
 * THE VALUE TRAVELS ONE WAY: read hidden from the person's terminal, padded, sent, and dropped. It is
 * never printed, never logged, never in an error and never in the output of a later command.
 */
export class InputController {
  constructor(private readonly ports: InputPorts) {}

  async list(options: InputCommandOptions): Promise<void> {
    this.#refuseFerret();
    const list = await this.ports.gateway.list(target(options));
    this.ports.out.success(
      options.json === true ? JSON.stringify(list, null, 2) : renderInputList(list, this.ports.now()),
    );
  }

  async answer(reference: string, options: InputAnswerOptions): Promise<void> {
    this.#refuseFerret();
    if (!this.ports.interactive) {
      throw new Error('typing a value needs a terminal you are sitting at: run this where you can type, not in a pipe');
    }
    const sessionId = target(options);
    const request = await this.#find(sessionId, reference);
    if (request.state !== 'pending')
      throw new Error(`!${request.agendaItemId} is ${request.state}, not waiting for a value`);
    if (request.observed === undefined || request.observedDigest === undefined) {
      throw new Error(`!${request.agendaItemId} is still being re-checked after a restart: try again in a moment`);
    }
    for (const line of renderInputFacts(request)) this.ports.out.diagnostic(line);
    if (
      request.sensitivity === 'secret' &&
      request.observed.kind === 'terminal' &&
      !request.observed.recognisedConsumer &&
      options.trustProgram !== true
    ) {
      throw new Error(
        `${request.observed.foreground.comm} is not a program known to ask for secrets; if you trust it, run again with --trust-program`,
      );
    }
    const value = await this.ports.prompt.askHidden(`value for !${request.agendaItemId} (hidden): `);
    const problem = inputValueProblem(value, request.sensitivity);
    if (problem !== undefined) throw new Error(problem);
    const submit = submitAfter(request, options);
    const result = await this.ports.gateway.deliver(sessionId, request.id, {
      deliveryId: this.ports.newDeliveryId(),
      observedDigest: request.observedDigest,
      padded: padInputValue(value),
      submit,
      ...(options.trustProgram === true ? { trustProgram: true as const } : {}),
    });
    if (options.json === true) {
      this.ports.out.success(JSON.stringify(result, null, 2));
      return;
    }
    const where = inputTargetReference(request);
    this.ports.out.success(
      result.state === 'delivered'
        ? `Sent to ${where}${result.submitted ? ' and pressed Enter' : ''}.`
        : `Not sent: ${result.reason === undefined ? result.state : describeInputReason(result.reason)}.`,
    );
  }

  async cancel(reference: string, options: InputCommandOptions): Promise<void> {
    this.#refuseFerret();
    const sessionId = target(options);
    const request = await this.#find(sessionId, reference);
    const cancelled = await this.ports.gateway.cancel(sessionId, request.id);
    this.ports.out.success(
      options.json === true ? JSON.stringify(cancelled, null, 2) : `Declined !${request.agendaItemId}.`,
    );
  }

  async #find(sessionId: string, reference: string): Promise<InputRequest> {
    const id = parseAgendaReference(reference);
    const { requests } = await this.ports.gateway.list(sessionId);
    const found = requests.find(request => request.agendaItemId === id);
    if (found === undefined) throw new Error(`no input request !${id} in ${sessionId} (see \`input ls\`)`);
    return found;
  }

  #refuseFerret(): void {
    const credential = this.ports.agentCredential?.trim() ?? '';
    const own = this.ports.ownSessionId?.trim() ?? '';
    if (own !== '' || credential !== '') throw new Error(FERRET_REFUSAL);
  }
}
