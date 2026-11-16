import type { FerretId } from '@ferretry/kernel/contract';
import type { FerretView } from '../view/ferret-view.ts';
import type { RuntimeControlRequest, RuntimeModelCatalog } from '../view/runtime-control.ts';

/**
 * Changing what a RUNNING ferret is running, and reading what it may be changed to. Runtimes mounts both as
 * `GET /v1/ferrets/:id/runtime-models` and `POST /v1/ferrets/:id/runtime`; Ferrets serves them over the harness plugin's
 * own part (`Harness.runtimeSwitch`), so a harness without one answers `unsupported`.
 *
 * AUTHORIZATION, enforced here and not by the route so every transport gets it: with no `caller` (a person: the admin
 * token with no ferret behind it, or a device) any ferret may be switched; with a `caller` (a ferret acting) only that
 * ferret and its helpers (its descendants) may be, NEVER its lead (the same `mayTouch` rule as stop, resume and the harness seam). Anyone else is
 * refused with an `ApiError` 403 `forbidden`, as `harness` refuses. Every other refusal is a {@link RuntimeControlError}.
 */
export interface RuntimeControlApi {
  runtimeControl?: {
    /** What this ferret may be switched to, as its own account advertises it, read live. */
    models(caller: FerretId | undefined, target: string): Promise<RuntimeModelCatalog>;
    /**
     * Applies one control and answers with the ferret as it stands afterwards. IDEMPOTENT ON `requestId`: a retried
     * request is answered from the durable ledger and never types a second time; the same id carrying a DIFFERENT
     * control is a `conflict`.
     */
    control(
      caller: FerretId | undefined,
      target: string,
      request: RuntimeControlRequest,
      requestId: string,
    ): Promise<FerretView>;
  };
}
