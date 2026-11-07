import { claimOwnerOnly } from '@ferretry/core-gate/contract';
import { jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  type BrowserStateView,
  BrowserProxyTestRequestSchema,
  type LoopbackFirewallStateSchema,
} from '../../contract/index.ts';
import { parseBody } from '../pages/body.ts';
import type { BrowserProxyTester } from './proxy-test.ts';
import type { z } from 'zod';

export interface BrowserProxySubsystem {
  readonly tester: BrowserProxyTester;
  /** Whether the machine's one agent browser runs and which proxy it started with. */
  readonly state: () => BrowserStateView;
  /** Whether the loopback firewall fences this daemon's fixed browser ports; `undefined` while they are random. A reading, never a gate. */
  readonly firewall?: () => Promise<z.infer<typeof LoopbackFirewallStateSchema> | undefined>;
}

/**
 * "Test proxy" (docs/browser-proxy.md) and the machine-wide browser state beside it (today's
 * `runtime/mounts/browser-proxy.ts`).
 *
 * THE TEST IS THE OWNER'S, NOT A `use` OF THE BROWSER. A test signs in to the proxy it is given with the secrets that
 * setting names, so an agent that could run one against an address of its choosing could send a stored secret to a
 * host it controls. Gate's `claimOwnerOnly` (today's shared `ownerOnly`, demand `fleet.configure`) refuses a ferret
 * outright, and asks a governed device for a fresh passkey that it CLAIMS before the test runs: one proof admits one
 * act, there is no restore, and a test that then fails has used the proof up.
 */
export function proxyRoutes(subsystem: BrowserProxySubsystem) {
  return {
    'GET /v1/browser/state': (async () => {
      const firewall = await subsystem.firewall?.().catch(() => undefined);
      return jsonResponse(firewall === undefined ? subsystem.state() : { ...subsystem.state(), firewall });
    }) satisfies RouteHandler,
    'POST /v1/browser/proxy/test': (async call => {
      const request = await parseBody(call.request, BrowserProxyTestRequestSchema);
      const refused = claimOwnerOnly(call, 'test the browser proxy');
      if (refused !== undefined) return refused;
      const result = await subsystem.tester.test(request);
      return jsonResponse(result);
    }) satisfies RouteHandler,
  } as const;
}
