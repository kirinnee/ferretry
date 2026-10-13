/**
 * Delivering one checked Codex callback address to Codex's own listener on this machine.
 *
 * This is the request the person's browser would have made if it had been running on this host: a GET
 * to `127.0.0.1:<port><path>?<query>`, where Codex's `codex login` is waiting. Codex redeems the code
 * with the PKCE verifier only it holds and writes its own login. This adapter redeems nothing.
 *
 * - **The host is fixed here.** The seam carries a port, a path and a query, never a host, so nothing a
 *   caller passes can point this anywhere but this machine's loopback address.
 * - **No redirect is followed.** Codex answers a good callback with a redirect to its own success page;
 *   following it would be a second request nobody asked for.
 * - **Nothing Codex answers is read or returned.** Its page is for a browser. Whether the sign-in worked
 *   is told by how the child exits, which the service already watches.
 * - **The address is not logged.** A failure is reported as a word, never with the URL it was sent to.
 */
import type { HarnessLoginCallbackDeliver } from '../../lib/fleet-login/ports.ts';

/** How long Codex may take to answer: it redeems the code with the provider before it replies. */
const DELIVERY_TIMEOUT_MS = 60_000;

/**
 * Codex's own answers that mean "not this one, still waiting" (measured at codex-cli 0.145.0): a
 * mismatched `state` is `400 State mismatch`, and an unknown path is `404`.
 */
const NOT_WAITING_FOR_THIS: ReadonlySet<number> = new Set([400, 404]);

export const deliverCodexCallback: HarnessLoginCallbackDeliver = async delivery => {
  try {
    const response = await fetch(`http://127.0.0.1:${delivery.port}${delivery.path}?${delivery.query}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return NOT_WAITING_FOR_THIS.has(response.status) ? 'refused' : 'delivered';
  } catch {
    // Nothing listening, or no answer in time: nobody can say whether the address arrived.
    return 'unreachable';
  }
};
