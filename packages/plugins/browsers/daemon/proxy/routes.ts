import { isFerretCall, STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  type BrowserStateView,
  BrowserProxyTestRequestSchema,
  CONFIGURE,
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
 * Today's `ownerOnly` (`mounts/daemon-update.ts`): a ferret is refused outright, and a governed device is asked for a
 * fresh passkey before the act.
 */
function ownerOnly(call: CallContext, act: string): ApiResponse | undefined {
  if (isFerretCall(call)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
  if (call.governance?.governed !== true || call.presentation?.freshStepUp === true) return undefined;
  return jsonResponse(
    {
      error: `to ${act} from this device, confirm with a passkey`,
      code: STEP_UP_REQUIRED_CODE,
      demand: CONFIGURE.browser,
    } satisfies StepUpRequiredBody,
    403,
  );
}

/**
 * "Test proxy" (docs/browser-proxy.md) and the machine-wide browser state beside it (today's
 * `runtime/mounts/browser-proxy.ts`).
 *
 * THE TEST IS THE OWNER'S, NOT A `use` OF THE BROWSER. A test signs in to the proxy it is given with the secrets that
 * setting names, so an agent that could run one against an address of its choosing could send a stored secret to a
 * host it controls. `ownerOnly` refuses a ferret outright, and asks a governed device for a fresh passkey.
 */
export function proxyRoutes(subsystem: BrowserProxySubsystem) {
  return {
    'GET /v1/browser/state': (async () => {
      const firewall = await subsystem.firewall?.().catch(() => undefined);
      return jsonResponse(firewall === undefined ? subsystem.state() : { ...subsystem.state(), firewall });
    }) satisfies RouteHandler,
    'POST /v1/browser/proxy/test': (async call => {
      const request = await parseBody(call.request, BrowserProxyTestRequestSchema);
      const refused = ownerOnly(call, 'test the browser proxy');
      if (refused !== undefined) return refused;
      const result = await subsystem.tester.test(request);
      if (call.governance?.governed === true) call.spendFreshStepUp?.();
      return jsonResponse(result);
    }) satisfies RouteHandler,
  } as const;
}
