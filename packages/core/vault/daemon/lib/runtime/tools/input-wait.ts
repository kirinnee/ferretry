import { ferretOf } from '@ferretry/core-gate/contract';
import type { ToolHandler, ToolResult } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { InputRequestError } from '../../inputs/errors.ts';
import type { InputRequestService } from '../../inputs/service.ts';
import { AgendaIdSchema, type InputAgentView } from '../../inputs/wire.ts';
import {
  PHONE_APPROVAL_ID_PATTERN,
  PHONE_APPROVAL_UNAVAILABLE,
  type PhoneApprovalAgentView,
  type PhoneApprovalProvider,
} from '../../../../contract/index.ts';

/** Today's agent-tool wait bounds (`AGENT_TOOL_DEFAULT_WAIT_MS`, `AGENT_TOOL_MAX_WAIT_MS`). */
const INPUT_WAIT_DEFAULT_MS = 10_000;
const INPUT_WAIT_MAX_MS = 25_000;

/**
 * Today's `input.wait` call, less the phone approval's `pa_` id (Accounts' now): the card raised by
 * `*.request_input`, written `!A7` or `A7`, and how long to wait in this call.
 */
const InputWaitInputSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .transform(value => value.replace(/^!/u, ''))
    .pipe(z.union([AgendaIdSchema, z.string().regex(PHONE_APPROVAL_ID_PATTERN)])),
  timeoutMs: z.number().int().min(100).max(INPUT_WAIT_MAX_MS).optional(),
});

/** Where a phone approval stands, in one sentence a ferret can act on: never its number (today's `approvalSummary`). */
function approvalSummary(view: PhoneApprovalAgentView): string {
  switch (view.state) {
    case 'waiting':
      return `${view.id} is still waiting for the owner to approve on their phone. Wait again with input_wait; do not act on that page or terminal meanwhile.`;
    case 'moved-on':
      return view.secondFactor === 'push'
        ? `${view.id}: the sign-in went through after a push. Read the page or terminal and carry on.`
        : `${view.id}: the sign-in moved on. Read the page or terminal to see where it is.`;
    case 'timed-out':
      return `${view.id} ran out of time without the sign-in moving on. Ask again only if the site sent a new push.`;
    case 'refused':
      return `${view.id}: the owner did not expect this sign-in and said "Not me". Stop signing in there and do not ask again.`;
    case 'gone':
      return `${view.id} ended: the page or terminal closed.`;
  }
}

/** Today's `inputSummary`, word for word: where the card stands, never the value. */
function inputSummary(view: InputAgentView): string {
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
export function inputTools(
  service: InputRequestService,
  phone: () => PhoneApprovalProvider | undefined = () => undefined,
): { readonly input_wait: ToolHandler } {
  return {
    input_wait: async (call, input) => {
      const ferret = ferretOf(call);
      if (ferret === undefined)
        return refusal('input_wait is a ferret’s own call: it waits on a card that ferret raised');
      const parsed = InputWaitInputSchema.safeParse(input);
      if (!parsed.success) return refusal('input_wait takes a card id like !A7 and an optional timeoutMs');
      const waitMs = parsed.data.timeoutMs ?? INPUT_WAIT_DEFAULT_MS;
      if (PHONE_APPROVAL_ID_PATTERN.test(parsed.data.id)) {
        // A phone approval is Accounts': its own service answers, and only for the ferret that raised it.
        const provider = phone();
        if (provider === undefined) return refusal(PHONE_APPROVAL_UNAVAILABLE);
        const waited = await provider.agentView(ferret, parsed.data.id, waitMs);
        if (!waited.ok) return refusal(waited.error);
        return { text: approvalSummary(waited.value), data: waited.value };
      }
      try {
        const view = await service.agentView(ferret, AgendaIdSchema.parse(parsed.data.id), waitMs);
        const { observed: _unbound, ...unbound } = view;
        return { text: inputSummary(view), data: unbound };
      } catch (error) {
        if (error instanceof InputRequestError) return refusal(error.message);
        throw error;
      }
    },
  };
}
