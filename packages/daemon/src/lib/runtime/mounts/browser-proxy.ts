import { BrowserProxyTestRequestSchema, type BrowserStateView, type LoopbackFirewallState } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { BrowserProxyTester } from '../../browser/proxy/index.ts';
import { ownerOnly } from './daemon-update.ts';

export interface BrowserProxySubsystem {
  readonly tester: BrowserProxyTester;
  /** Whether the machine's one agent browser runs and which proxy it started with. */
  readonly state: () => BrowserStateView;
  /** Whether the loopback firewall fences this daemon's fixed browser ports; `undefined` while they are random. A reading, never a gate. */
  readonly firewall?: () => Promise<LoopbackFirewallState | undefined>;
}

/**
 * "Test proxy" (docs/browser-proxy.md) and the machine-wide browser state that sits beside it.
 *
 * THE TEST IS THE OWNER'S, NOT A `use` OF THE BROWSER. A test signs in to the proxy it is given with the secrets
 * that setting names, so an agent that could run one against an address of its choosing could send a stored secret
 * to a host it controls. The same rule that keeps an agent from changing the proxy therefore keeps it from testing
 * one: `ownerOnly` refuses an agent or a Warden outright, and asks a governed device for a fresh passkey. The
 * token class check on the route (`operator`) already keeps Warden-class tokens out; the agent refusal is the part
 * the credential class cannot say.
 */
export function browserProxyRoutes(subsystem: BrowserProxySubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/browser/state',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'use' },
      noStore: true,
      handle: async () => {
        const firewall = await subsystem.firewall?.().catch(() => undefined);
        return jsonResponse(firewall === undefined ? subsystem.state() : { ...subsystem.state(), firewall });
      },
    },
    {
      method: 'POST',
      path: '/v1/browser/proxy/test',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, BrowserProxyTestRequestSchema);
        const refused = ownerOnly(context, 'test the browser proxy');
        if (refused !== undefined) return refused;
        const result = await subsystem.tester.test(request);
        if (context.governance?.governed === true) context.spendFreshStepUp?.();
        return jsonResponse(result);
      },
    },
  ];
}
