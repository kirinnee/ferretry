import { type InputSensitivity } from '../../../contract/index.ts';
import type { InputPorts } from './ports.ts';
import {
  describeInputReason,
  inputTargetReference,
  renderInputFacts,
  renderInputList,
  showUntrusted,
} from './render.ts';
import {
  ACCOUNT_HANDLE,
  ACCOUNT_LABEL_MAX_LENGTH,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  type InputDeliverBodyView,
  type InputRequestView,
  inputValueProblem,
  padInputValue,
} from './wire.ts';

/** What the prompt says beside "hidden" about who may see the value: nothing for a secret or a private value. */
const FLAGS: Readonly<Record<InputSensitivity, string>> = {
  secret: '',
  private: '',
  code: ', a one-time code: the ferret can see it',
  plain: ', not secret: the ferret can see it',
};

/** Said, whatever the verb, when `fy input` runs inside a ferret's pane or with an agent's credential. */
export const INPUT_OWNER_REFUSAL = "this is the owner's command; a ferret's pane can't run it";

/** Options every input command accepts. */
export interface InputCommandOptions {
  /** The session whose requests these are. An owner's shell has none of its own, so it is required. */
  readonly session?: string | undefined;
  readonly json?: boolean | undefined;
}

/** Flags on `fy input answer`. There is deliberately no flag that carries a value: only an account's NAME. */
export interface InputAnswerOptions extends InputCommandOptions {
  /** `--no-enter` is `false`; `--enter` (page targets) is `true`. */
  readonly enter?: boolean | undefined;
  /** `--account NAME`: type this account's field instead of reading a value. */
  readonly account?: string | undefined;
  /** `--save-as NAME`: keep the typed value in this account. */
  readonly saveAs?: string | undefined;
  /** `--label TEXT`: the label a new account gets. */
  readonly label?: string | undefined;
}

function handle(value: string, flag: string): string {
  const parsed = ACCOUNT_HANDLE.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(`${flag} "${value}" is not an account's handle: uppercase letters, digits and underscores`);
  return parsed.data;
}

/** The label a save carries: the owner's own, else the one the card suggests or the entry already has, else the handle. */
function saveLabel(request: InputRequestView, id: string, given: string | undefined): string {
  const label = (
    given ??
    (request.saved?.suggest?.id === id ? request.saved.suggest.label : undefined) ??
    request.saved?.offers.find(offer => offer.id === id)?.label ??
    id
  ).trim();
  if (label === '' || label.length > ACCOUNT_LABEL_MAX_LENGTH || /[\p{Cc}\p{Cf}]/u.test(label))
    throw new Error(`--label must be one line of 1 to ${ACCOUNT_LABEL_MAX_LENGTH} characters`);
  return label;
}

function target(options: InputCommandOptions): string {
  const session = options.session?.trim() ?? '';
  if (session === '') throw new Error('name the session with --session <id>: an input request belongs to one session');
  return session;
}

/** Whether pressing Enter after typing is on: the owner's flag wins, then the request's own mode, then the default. */
function submitAfter(request: InputRequestView, options: InputAnswerOptions): boolean {
  if (request.submit === 'agent') return false;
  if (options.enter !== undefined) return options.enter;
  return request.target.kind === 'terminal';
}

const SIGILS = /^[?!]/u;
const AGENDA_ID = /^A[1-9][0-9]*$/u;

/** `!A3`, `?A3` and `A3` all name the same card. */
function parseAgendaReference(value: string): string {
  const candidate = value.trim().replace(SIGILS, '');
  if (!AGENDA_ID.test(candidate))
    throw new Error(`"${value.trim()}" is not an agenda reference — they look like !A3 (see \`agenda ls\`)`);
  return candidate;
}

/**
 * Drives `fy input ls|answer|cancel`.
 *
 * OWNER-ONLY, IN THE CLI TOO. A ferret runs this binary in its own pane with `FY_SESSION_ID` in the environment, which
 * refuses the command before it reads or sends anything (the shell's client also refuses a person's route when it holds
 * a ferret's credential). The daemon refuses again, because this check is the courteous one and a hostile caller does
 * not run it.
 *
 * THE VALUE TRAVELS ONE WAY: read hidden from the person's terminal, padded, sent, and dropped. It is never printed,
 * never logged, never in an error and never in the output of a later command.
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
    const named = options.account === undefined ? undefined : handle(options.account, '--account');
    const saveAs = options.saveAs === undefined ? undefined : handle(options.saveAs, '--save-as');
    if (named !== undefined && (saveAs !== undefined || options.label !== undefined))
      throw new Error('--save-as keeps a value you type; it cannot be combined with --account');
    if (saveAs === undefined && options.label !== undefined) throw new Error('--label goes with --save-as');
    const sessionId = target(options);
    const request = await this.#find(sessionId, reference);
    const pasting = request.source !== undefined;
    if (pasting && (named !== undefined || saveAs !== undefined))
      throw new Error(`!${request.agendaItemId} pastes a secure copy: there is nothing to type, choose or save`);
    if (!pasting && named === undefined && !this.ports.interactive)
      throw new Error('typing a value needs a terminal you are sitting at: run this where you can type, not in a pipe');
    if (request.state !== 'pending')
      throw new Error(`!${request.agendaItemId} is ${request.state}, not waiting for a value`);
    if (request.observed === undefined || request.observedDigest === undefined)
      throw new Error(`!${request.agendaItemId} is still being re-checked after a restart: try again in a moment`);
    if (saveAs !== undefined && request.saved?.saves === undefined)
      throw new Error(`!${request.agendaItemId} cannot be saved: this kind of value is never kept in an account`);
    for (const line of renderInputFacts(request)) this.ports.out.diagnostic(line);
    const base = {
      deliveryId: this.ports.newDeliveryId(),
      observedDigest: request.observedDigest,
      submit: submitAfter(request, options),
    };
    let body: InputDeliverBodyView;
    if (request.source !== undefined) {
      this.ports.out.diagnostic(`allowing the paste of sealed:${request.source.name}`);
      body = { ...base, sealed: true };
    } else if (named !== undefined) {
      this.ports.out.diagnostic(`using the account ${named}`);
      body = { ...base, entry: named };
    } else if (request.fields.length > 1) {
      const fields: { field: string; padded: string }[] = [];
      for (const field of request.fields) {
        const value = await this.ports.prompt.askHidden(
          `${showUntrusted(field.label)} for !${request.agendaItemId} (hidden${FLAGS[field.sensitivity]}): `,
        );
        const problem = inputValueProblem(value, field.sensitivity);
        if (problem !== undefined) throw new Error(`${field.id}: ${problem}`);
        if (saveAs !== undefined && field.sensitivity === 'secret' && value.length < ACCOUNT_PASSWORD_MIN_LENGTH)
          throw new Error(
            `${field.id} is shorter than the ${ACCOUNT_PASSWORD_MIN_LENGTH} characters a saved password needs, so the card cannot be saved: nothing was sent, run this again without --save-as to send it unsaved`,
          );
        fields.push({ field: field.id, padded: padInputValue(value) });
      }
      // Save as keeps the card's username and password together, as one saved login.
      body = {
        ...base,
        fields,
        ...(saveAs === undefined ? {} : { save: { entry: saveAs, label: saveLabel(request, saveAs, options.label) } }),
      };
    } else {
      const value = await this.ports.prompt.askHidden(
        `value for !${request.agendaItemId} (hidden${FLAGS[request.sensitivity]}): `,
      );
      const problem = inputValueProblem(value, request.sensitivity);
      if (problem !== undefined) throw new Error(problem);
      if (saveAs !== undefined && request.saved?.saves === 'password' && value.length < ACCOUNT_PASSWORD_MIN_LENGTH)
        throw new Error(
          `that value is shorter than the ${ACCOUNT_PASSWORD_MIN_LENGTH} characters a saved password needs, so it cannot be saved: nothing was sent, run this again without --save-as to send it unsaved`,
        );
      body = {
        ...base,
        padded: padInputValue(value),
        ...(saveAs === undefined ? {} : { save: { entry: saveAs, label: saveLabel(request, saveAs, options.label) } }),
      };
    }
    const result = await this.ports.gateway.deliver(sessionId, request.id, body);
    if (options.json === true) {
      this.ports.out.success(JSON.stringify(result, null, 2));
      return;
    }
    const where = inputTargetReference(request);
    this.ports.out.success(
      result.state === 'delivered'
        ? `${pasting ? 'Pasted into' : 'Sent to'} ${where}${result.submitted ? ' and pressed Enter' : ''}.`
        : `Not sent: ${result.reason === undefined ? result.state : describeInputReason(result.reason)}.`,
    );
    if (result.saved !== undefined)
      this.ports.out.success(
        result.saved.ok
          ? `Saved as ${result.saved.entry}.`
          : `Not saved as ${result.saved.entry}: ${result.saved.problem ?? 'no reason was given'}. It was typed all the same; add it under \`account\` instead.`,
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

  async #find(sessionId: string, reference: string): Promise<InputRequestView> {
    const id = parseAgendaReference(reference);
    const { requests } = await this.ports.gateway.list(sessionId);
    const found = requests.find(request => request.agendaItemId === id);
    if (found === undefined) throw new Error(`no input request !${id} in ${sessionId} (see \`input ls\`)`);
    return found;
  }

  #refuseFerret(): void {
    if ((this.ports.ownSessionId?.trim() ?? '') !== '') throw new Error(INPUT_OWNER_REFUSAL);
  }
}
