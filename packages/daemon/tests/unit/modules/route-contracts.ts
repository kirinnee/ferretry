/**
 * THE ROUTE CONTRACT, ONE FRAGMENT PER MODULE — and how to move your lines into yours.
 *
 * Two reviewed lists guard the mounted surface, and each is the concatenation of per-module fragments
 * `tests/unit/modules/<id>/route-contract.ts`, every one exporting `{ callers, notAudited }`:
 *
 * - `callers`: one line per route, `METHOD path minimum caller` (who may call it). Request/response routes and
 *   socket routes share the list; the surface tests tell the two tables apart by what is mounted.
 * - `notAudited`: `METHOD path` -> why the security log deliberately does not record it (mutating routes that
 *   no `contributes.audit` rule names, request and socket alike). THIS LIST ONLY SHRINKS.
 *
 * `surface.test.ts` concatenates the fragments and asserts that every mounted route is in exactly one fragment,
 * that every fragment line names a mounted route, and that every audit rule still names a mounted route.
 *
 * EXTRACTING A MODULE (the PR that gives a feature its own `DaemonModule`):
 *
 * 1. Create `tests/unit/modules/<id>/route-contract.ts` exporting `callers: readonly string[]` and
 *    `notAudited: Readonly<Record<string, string>>`, in the same shapes as `legacy`.
 * 2. MOVE (cut, do not copy) the lines of the routes your module now contributes from
 *    `tests/unit/modules/legacy/route-contract.ts` into it: each `callers` line and each `notAudited` entry.
 *    A line left in two fragments fails "exactly one fragment", and a line left behind in `legacy` fails
 *    the same way once the route is no longer a legacy route.
 * 3. Move the module's audit rules out of the `legacy` module's `contributes.audit` into the new module's
 *    `contributes.audit` (production code, never a test file); the union is unchanged.
 * 4. Add `<id>` to `FRAGMENTS` below. Nothing else in the tests changes.
 *
 * A fragment is a diff somebody reads, so a module's reviewed answers now change in the module's own file.
 */
import * as agentTools from './agent-tools/route-contract.ts';
import * as analytics from './analytics/route-contract.ts';
import * as cgroups from './cgroups/route-contract.ts';
import * as fleetLogin from './fleet-login/route-contract.ts';
import * as inputRequests from './input-requests/route-contract.ts';
import * as learning from './learning/route-contract.ts';
import * as legacy from './legacy/route-contract.ts';
import * as renders from './renders/route-contract.ts';
import * as update from './update/route-contract.ts';
import * as voice from './voice/route-contract.ts';
import * as workSearch from './work-search/route-contract.ts';
import * as worktrees from './worktrees/route-contract.ts';

/** One module's reviewed lines. */
interface RouteContractFragment {
  readonly callers: readonly string[];
  readonly notAudited: Readonly<Record<string, string>>;
}

/** Every module's fragment, in the order the modules are composed. */
export const FRAGMENTS: Readonly<Record<string, RouteContractFragment>> = {
  legacy,
  learning,
  cgroups,
  analytics,
  update,
  worktrees,
  renders,
  voice,
  workSearch,
  inputRequests,
  agentTools,
  fleetLogin,
};

/** The concatenation of every fragment's `callers`: one line per route, both tables. */
export const ROUTE_CALLERS: readonly string[] = Object.values(FRAGMENTS).flatMap(fragment => fragment.callers);

/** The concatenation of every fragment's `notAudited` (a key in two fragments is a defect the tests name). */
export const NOT_AUDITED: Readonly<Record<string, string>> = Object.assign(
  {},
  ...Object.values(FRAGMENTS).map(fragment => fragment.notAudited),
);

/**
 * Routes served by a table of their own rather than the mounted one: the direct carrier's public socket, which
 * the tunnel listener serves (`directCarrierSocketRoute`). Pinned in `tests/unit/relay/direct-carrier.test.ts`.
 */
export const OTHER_TABLE_CALLERS: readonly string[] = ['GET /v1/rendezvous/:daemonId/client none any'];
