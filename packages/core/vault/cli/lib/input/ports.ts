import type {
  IFyApiClient,
  InputDeliverBody,
  InputDeliverResult,
  InputRequest,
  InputRequestList,
} from '@ferretry/protocol';

/** Presentation port for `fy input`: the narrowest slice of the shipped console adapter. */
export interface IInputOutput {
  success(message: string): void;
  /** A line for stderr: said to whoever runs the command, never mixed into its output. */
  diagnostic(message: string): void;
}

/**
 * The one way a value enters this command: a hidden read from a terminal a person is sitting at.
 * `IPrompt` (the inquirer adapter) satisfies it structurally. There is deliberately no flag, argument,
 * environment variable or pipe that supplies a value instead.
 */
export interface IHiddenValuePrompt {
  /** Reads one line with nothing echoed to the screen. */
  askHidden(message: string): Promise<string>;
}

/** The daemon calls `fy input` needs; the controller never sees a URL or a status code. */
export interface IInputGateway {
  /** The requests still open on one session, as the owner's card reads them. */
  list(sessionId: string): Promise<InputRequestList>;
  /** Send a padded value to a request. The answer carries the outcome, never a value. */
  deliver(sessionId: string, requestId: string, body: InputDeliverBody): Promise<InputDeliverResult>;
  /** Decline a request. */
  cancel(sessionId: string, requestId: string): Promise<InputRequest>;
}

/** The only client capability the input gateway consumes. */
export type InputApiClient = Pick<IFyApiClient, 'request'>;

/** Everything an `fy input` run needs besides its words and flags. */
export interface InputPorts {
  readonly gateway: IInputGateway;
  readonly out: IInputOutput;
  readonly prompt: IHiddenValuePrompt;
  /** Whether stdin and stdout are a terminal a person is typing at. */
  readonly interactive: boolean;
  /** `FY_SESSION_ID`: set when this CLI runs inside a ferret's pane. */
  readonly ownSessionId: string | undefined;
  /** `FY_SESSION_BOARD_CAPABILITY`: set when this CLI runs with an agent's credential. */
  readonly agentCredential: string | undefined;
  readonly now: () => number;
  readonly newDeliveryId: () => string;
}
