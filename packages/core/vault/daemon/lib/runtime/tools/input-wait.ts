import { ferretOf } from '@ferretry/core-gate/contract';
import type { ToolHandler, ToolResult } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { InputRequestError } from '../../inputs/errors.ts';
import type { InputRequestService } from '../../inputs/service.ts';
import { AgendaIdSchema, type InputAgentView } from '../../inputs/wire.ts';

/** Today's agent-tool wait bounds (`AGENT_TOOL_DEFAULT_WAIT_MS`, `AGENT_TOOL_MAX_WAIT_MS`). */
export const INPUT_WAIT_DEFAULT_MS = 10_000;
export const INPUT_WAIT_MAX_MS = 25_000;

/**
 * Today's `input.wait` call, less the phone approval's `pa_` id (Accounts' now): the card raised by
 * `*.request_input`, written `!A7` or `A7`, and how long to wait in this call.
 */
export const InputWaitInputSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .transform(value => value.replace(/^!/u, ''))
    .pipe(AgendaIdSchema),
  timeoutMs: z.number().int().min(100).max(INPUT_WAIT_MAX_MS).optional(),
});

/** Today's `inputSummary`, word for word: where the card stands, never the value. */
export function inputSummary(view: InputAgentView): string {
  const card = `!${view.id}`;
  switch (view.state) {
    case 'pending':
      return `${card} is still waiting for the owner. Wait again with input.wait; do not type there yourself.`;
    case 'delivering':
      return `${card}: the owner's value is being typed now. Wait again with input.wait.`;
    case 'delivered':
      if (view.source === 'sealed')
        return `${card}: the secure copy was pasted${view.submitted === true ? ' and Enter pressed' : ''}. Read the terminal once its quarantine allows.`;
      return `${card}: the owner typed the value${view.submitted === true ? ' and pressed Enter' : ''}. Read the terminal to see what happened.`;
    case 'refused':
      return `${card} was refused${view.reason === undefined ? '' : ` (${view.reason})`}: the value was not typed. Look at the terminal, then raise a new request if it is still needed.`;
    case 'expired':
      return `${card} expired without an answer.`;
    case 'cancelled':
      return `${card} was cancelled${view.reason === undefined ? '' : ` (${view.reason})`}.`;
  }
}

const refusal = (text: string): ToolResult => ({ text, isError: true });

/**
 * `input_wait`: the ferret waits for the owner to answer its own card. Today's handler kept `observed` only when it
 * could also name the pane; Vault cannot name a Terminals pane, so `observed` is always left out, as today's
 * unbound branch did.
 */
export function inputTools(service: InputRequestService): { readonly input_wait: ToolHandler } {
  return {
    input_wait: async (call, input) => {
      const ferret = ferretOf(call);
      if (ferret === undefined)
        return refusal('input_wait is a ferret’s own call: it waits on a card that ferret raised');
      const parsed = InputWaitInputSchema.safeParse(input);
      if (!parsed.success) return refusal('input_wait takes a card id like !A7 and an optional timeoutMs');
      try {
        const view = await service.agentView(ferret, parsed.data.id, parsed.data.timeoutMs ?? INPUT_WAIT_DEFAULT_MS);
        const { observed: _unbound, ...unbound } = view;
        return { text: inputSummary(view), data: unbound };
      } catch (error) {
        if (error instanceof InputRequestError) return refusal(error.message);
        throw error;
      }
    },
  };
}
