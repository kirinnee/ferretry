import type { Result } from '@ferretry/std';
import type { Actor, CellGrid, HoldDecision, Op, RevealGrant, TargetRef } from './act.ts';
import { defineBoundPort } from './define.ts';
import type { ApiRequest, ApiResponse, RouteParameters } from './http.ts';
import type { FerretId } from './ids.ts';
import type { CallStanding, MemberRouteDescriptor, MemberStanding, ScopedRoute } from './route.ts';

/**
 * The kernel-bound ports (§7.4): provided only by the named core piece, bound by the kernel after build and before it
 * listens. Each has exactly one provider; a missing or failing one fails closed for what it guards. The interfaces
 * live here because the kernel calls them and imports no core contract; each core contract re-exports its own.
 */

// ─── Admission (Gate) ─────────────────────────────────────────────────────────────────────────────────────────────

/** Which table a call came through. Member routes are their own table (§7.1). */
export type AdmissionTable = 'route' | 'socket' | 'tool' | 'member';

export type AdmissionInput =
  | {
      readonly table: 'route' | 'socket' | 'tool';
      readonly descriptor: ScopedRoute;
      readonly request: ApiRequest;
      readonly params: RouteParameters;
    }
  | {
      readonly table: 'member';
      readonly descriptor: MemberRouteDescriptor;
      readonly request: ApiRequest;
      readonly params: RouteParameters;
    };

export type AdmissionDecision<Standing extends object = CallStanding> =
  | { readonly outcome: 'admitted'; readonly standing: Standing }
  | { readonly outcome: 'refused'; readonly response: ApiResponse };

/**
 * Called by the dispatcher, the socket upgrade and the agent-tool runner BEFORE a handler, synchronously, with the
 * descriptor and the arrival (§7.1). If it throws or answers nothing, every call except `minimum: 'none'` routes
 * without a remedy is refused.
 */
export interface Admission<Standing extends object = CallStanding, Member extends object = MemberStanding> {
  admit(input: AdmissionInput & { readonly table: 'route' | 'socket' | 'tool' }): AdmissionDecision<Standing>;
  admitMember(input: AdmissionInput & { readonly table: 'member' }): AdmissionDecision<Member>;
  /** Re-admits an open stream after a provider's `generation()` moved; false closes it (`4401`). */
  readmit(request: ApiRequest, descriptor: ScopedRoute): boolean;
}

export const AdmissionPort = defineBoundPort<Admission>('admission', 'gate');

// ─── Output guard (Vault) ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Non-secret state the final check reads (§7.3): the hold registry and a permit generation per target, refreshed on
 * the same serialization chain as every hold change. `late` and `permit` decide from it with no await and no vault.
 */
export interface OutputGuard {
  /** Taken when a guarded body is built. */
  stamp(targets?: readonly TargetRef[]): GuardStamp;
  /** False if a hold began or a generation moved since the stamp. Synchronous; throws are read as false. */
  stillShowable(stamp: GuardStamp): boolean;
}

export interface GuardStamp {
  readonly generation: number;
  readonly targets: readonly TargetRef[];
}

export const OutputGuardPort = defineBoundPort<OutputGuard>('output-guard', 'vault');

/** The fixed withheld sentence `late` chooses when a hold began after the body was built. */
export const WITHHELD_SENTENCE = 'This was withheld because a private value was typed while it was being prepared.';

// ─── Input holds (Vault) ──────────────────────────────────────────────────────────────────────────────────────────

/** Asked by `kernel.act` inside the target's queue immediately before every act (§4.7). Synchronous. */
export interface InputHolds {
  decide(target: TargetRef, op: Op, actor: Actor, reveal?: RevealGrant): HoldDecision;
}

export const InputHoldsPort = defineBoundPort<InputHolds>('input-holds', 'vault');

// ─── Redaction (Vault) ────────────────────────────────────────────────────────────────────────────────────────────

/** The composed redactor for one read (§7.3). */
export interface RedactionScope {
  text(s: string): string;
  /** Same-width `*` over exactly the matched cells. */
  cells(grid: CellGrid): CellGrid;
  /** A value wrapped across rows is masked in each row. */
  lines(lines: readonly string[]): readonly string[];
}

/**
 * Read-scoped redaction: opens the vault's values for this read only and drops them when it returns (S20); nothing
 * is cached. A failing redactor fails closed: the read refuses, a stream closes.
 */
export interface Redaction {
  read<T>(fn: (scope: RedactionScope) => T | Promise<T>): Promise<T>;
}

export const RedactionPort = defineBoundPort<Redaction>('redaction', 'vault');

// ─── Work folders (Ferrets) ───────────────────────────────────────────────────────────────────────────────────────

declare const fencedBrand: unique symbol;
/** An absolute, symlink-resolved path a fence check accepted. Only a root handle or `WorkFolders` mints one. */
export type FencedPath = string & { readonly [fencedBrand]: true };

export type FolderRefusal = 'outside' | 'fenced' | 'unknown_ferret' | 'link_escape' | 'device_file';

/** Which folder a ferret may work in: the one it was started in, checked against the fence (§7.7). */
export interface WorkFolders {
  folderOf(ferret: FerretId): FencedPath | undefined;
  check(ferret: FerretId, path: string): Result<FencedPath, FolderRefusal>;
}

export const WorkFoldersPort = defineBoundPort<WorkFolders>('work-folders', 'ferrets');

export const KERNEL_BOUND_PORTS = [
  AdmissionPort,
  OutputGuardPort,
  InputHoldsPort,
  RedactionPort,
  WorkFoldersPort,
] as const;
