import type { InputDeliverAnswer, InputDeliverBodyView, InputRequestView, InputRequestListView } from './wire.ts';

/** Presentation port for `fy input`. */
interface InputOutput {
  success(message: string): void;
  /** A line for stderr: said to whoever runs the command, never mixed into its output. */
  diagnostic(message: string): void;
}

/**
 * The one way a value enters this command: a hidden read from a terminal a person is sitting at. There is deliberately
 * no flag, argument, environment variable or pipe that supplies a value instead.
 */
interface HiddenValuePrompt {
  /** Reads one line with nothing echoed to the screen. */
  askHidden(message: string): Promise<string>;
}

/** The daemon calls `fy input` needs; the controller never sees a route key or a status code. */
export interface InputGateway {
  /** The requests still open on one session, as the owner's terminal reads them. */
  list(sessionId: string): Promise<InputRequestListView>;
  /** Send a padded value to a request. The answer carries the outcome, never a value. */
  deliver(sessionId: string, requestId: string, body: InputDeliverBodyView): Promise<InputDeliverAnswer>;
  /** Decline a request. */
  cancel(sessionId: string, requestId: string): Promise<InputRequestView>;
}

/** Everything an `fy input` run needs besides its words and flags. */
export interface InputPorts {
  readonly gateway: InputGateway;
  readonly out: InputOutput;
  readonly prompt: HiddenValuePrompt;
  /** Whether stdin and stdout are a terminal a person is typing at. */
  readonly interactive: boolean;
  /** `FY_SESSION_ID`: set when this CLI runs inside a ferret's pane. */
  readonly ownSessionId: string | undefined;
  readonly now: () => number;
  readonly newDeliveryId: () => string;
}
