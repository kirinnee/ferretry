import { ferretOf } from '@ferretry/core-gate/contract';
import type { PageCaller, PageInputAction, PageInputOutcome, PageToolHost, ResolvedPage } from '../target/index.ts';
import type { BrowserTools } from './service.ts';
import type { ResolvedSurface, ToolCaller } from './types.ts';

/**
 * THE PAGE TOOLS' HOST: the agent browser as `browser_type`, `browser_fill_form`, `browser_request_input` and
 * `browser_ask_owner` (`../target/tools`) need it, over {@link BrowserTools} — so those four tools resolve a page,
 * clear it for the caller, act in its queue and hand it over with exactly the checks the other browser tools make,
 * and nothing is checked twice or in a second copy.
 *
 * The caller is derived from the kernel-stamped standing only: an MCP tool call is a ferret's own, and a call with no
 * ferret is refused (a person drives a ferret's pages through the owner's tools route, which names the ferret).
 */
export function pageToolHost(tools: BrowserTools): PageToolHost {
  /** The surface each resolved page came from, so the act and the hand-over use what `resolve` cleared. */
  const surfaces = new WeakMap<ResolvedPage, ResolvedSurface>();

  const toolCaller = (caller: PageCaller): ToolCaller =>
    caller.kind === 'agent'
      ? { kind: 'agent', sessionId: caller.ferret, ...(caller.name === undefined ? {} : { name: caller.name }) }
      : { kind: 'person', sessionId: caller.ferret };

  /** The surface behind a page, cleared again when it did not come from `resolve` (the act is checked either way). */
  const surfaceOf = async (caller: PageCaller, page: ResolvedPage): Promise<ResolvedSurface> =>
    surfaces.get(page) ?? (await tools.pageFor(toolCaller(caller), page.id));

  return {
    caller: call => {
      const ferret = ferretOf(call);
      return ferret === undefined ? undefined : { kind: 'agent', ferret };
    },
    resolve: async (caller, key) => {
      const surface = await tools.pageFor(toolCaller(caller), key);
      const page: ResolvedPage = { id: surface.id, ...(surface.name === undefined ? {} : { name: surface.name }) };
      surfaces.set(page, surface);
      return page;
    },
    act: async (caller, page, action: PageInputAction): Promise<PageInputOutcome> =>
      await tools.inputOn(toolCaller(caller), await surfaceOf(caller, page), action),
    askOwner: async (caller, page, message) =>
      await tools.askOwner(toolCaller(caller), await surfaceOf(caller, page), message),
    drove: async (caller, page) => await tools.droveOn(toolCaller(caller), await surfaceOf(caller, page)),
  };
}
