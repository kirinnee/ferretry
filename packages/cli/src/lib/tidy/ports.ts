import type {
  AgendaActionRequest,
  AgendaListSnapshot,
  BoardTaskActionRequestInput,
  TidyPlan,
} from '@ferretry/protocol';

/** The one new daemon call: the plan for the calling session. */
export interface ITidyPlanGateway {
  /** `undefined` when the daemon has no tidy route yet (it answers 404), so the CLI can say to update it. */
  plan(as: string | undefined): Promise<TidyPlan | undefined>;
}

/** The card drop the ferret could have typed itself; the board gateway satisfies this structurally. */
export interface ITidyCards {
  act(as: string | undefined, id: string, request: BoardTaskActionRequestInput): Promise<unknown>;
}

/** The agenda "done" the ferret could have typed itself; the agenda gateway satisfies this structurally. */
export interface ITidyAgenda {
  apply(sessionId: string, request: AgendaActionRequest): Promise<AgendaListSnapshot>;
}

/** `ConsoleIo` satisfies this structurally; stdout stays the answer. */
export interface ITidyOutput {
  success(message: string): void;
  diagnostic(message: string): void;
}
