import type { InputTargetAdapter } from '@ferretry/core-vault/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import type { BrowserSubsystem } from '../pages/service.ts';
import { toolHandler } from '../tools/index.ts';
import type { BrowserTools } from '../tools/service.ts';

/**
 * STUB (part a): the `page` input target, page holds and challenges are part b's (`rebuild/port-browsers-b`), which
 * replaces this file. Until then the four tools that type into a page or raise a card for one run the plain
 * part-a path (`browser_type`, `browser_fill_form` through the act runner, whose `InputHolds` still decides every
 * act), `browser_ask_owner` hands the page over, `browser_request_input` refuses, and the target refuses every
 * observe and write, so no card can type into a page until part b lands.
 */
export interface PageTargetDeps {
  readonly kernel: KernelPorts;
  readonly pages: BrowserSubsystem;
  readonly tools: BrowserTools;
}

export interface PageTargetHalf {
  readonly tools: {
    readonly browser_type: ToolHandler;
    readonly browser_fill_form: ToolHandler;
    readonly browser_ask_owner: ToolHandler;
    readonly browser_request_input: ToolHandler;
  };
  readonly target: InputTargetAdapter;
}

export function pageTargetHalf(deps: PageTargetDeps): PageTargetHalf {
  return {
    tools: {
      browser_type: toolHandler(deps.tools, 'browser_type'),
      browser_fill_form: toolHandler(deps.tools, 'browser_fill_form'),
      browser_ask_owner: toolHandler(deps.tools, 'browser_ask_owner'),
      browser_request_input: async () => ({
        text: 'Asking the owner to type into a page is not built yet in this version of Ferretry.',
        isError: true,
      }),
    },
    target: {
      masking: 'text',
      observe: async () => ({ ok: false, reason: 'unsupported' }),
      type: async () => 'guard_refused',
    },
  };
}
