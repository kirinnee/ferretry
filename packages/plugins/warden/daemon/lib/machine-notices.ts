/**
 * The owner-facing notice the warden keeps ONE of per cause (today's machine agenda): "these cards have no ferret",
 * "these ferrets are stuck on an unsent message". The lists in this directory only know this port; `build` binds it to
 * Asks (a notice per cause, replaced when its members change, closed when the cause clears).
 */

/** What a list asks the notice to say. Plain text only: Asks carries no card rows, so a list names its members. */
export interface MachineRaise {
  readonly title?: string;
  readonly subject: string;
  readonly why: string;
  readonly premise?: string;
  readonly context?: string;
  readonly howToResolve: string;
  readonly waitingSince?: string;
  readonly notice?: true;
  readonly ping?: true;
  readonly offerClose?: true;
  readonly cards?: readonly { readonly task: { readonly id: string }; readonly title?: string }[];
  readonly [key: string]: unknown;
}

/** The members each cause listed the last time it was raised, so a new one can be told from one the owner saw. */
export interface MachineMembersStore {
  read(): Promise<Readonly<Record<string, readonly string[]>>>;
  write(members: Readonly<Record<string, readonly string[]>>): Promise<void>;
}

/** Raise or refresh the notice for one cause; close it when the cause clears. */
export interface MachineAgendaPort {
  raiseOrUpdate(ref: string, request: MachineRaise, members?: readonly string[]): Promise<unknown>;
  resolve(ref: string, note?: string): Promise<unknown>;
}
