import { describe, expect, it } from 'bun:test';
import { AskOnScreenSchema } from '@ferretry/core-asks/contract';
import type { ReactElement } from 'react';
import { askFormFor, askRendererFor } from '../../../app/features/agenda/ask-renderers.tsx';
import type { AgendaInbox } from '../../../app/hooks/use-agenda-inbox.ts';
import { inboxCard } from '../../support/app/agenda-inbox.tsx';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const from = { ferret: 'sess-1', ferretName: 'judson', projectId: 'p-9' } as const;

describe('what an owner’s ask renderer receives', () => {
  it('names the ferret, its spoken name and its project beside the ref and the words', () => {
    const item = agendaItem('A1', { copyPlan: { planId: 'pl-1' } } as never);
    const owned = askRendererFor(item, from);
    expect(owned?.key).toBe('ask:sign-in-approval');
    expect(owned?.value).toMatchObject({
      ref: { kind: 'copy-plan', planId: 'pl-1' },
      ferret: 'sess-1',
      ferretName: 'judson',
      projectId: 'p-9',
    });
    expect(AskOnScreenSchema.safeParse(owned?.value).success).toBe(true);
  });

  it('leaves the project out when the ferret has none', () => {
    const item = agendaItem('A2', { phoneApproval: { id: 'ap-1' } } as never);
    const owned = askRendererFor(item, { ferret: 'sess-2', ferretName: 'zoe' });
    expect(owned?.value).not.toHaveProperty('projectId');
    expect(owned?.value.ferretName).toBe('zoe');
  });

  it('reads an item’s own plan before a rule suggestion, a paste plan, an approval or a seed', () => {
    const item = agendaItem('A3', {
      taskPlan: { planId: 't-1' },
      copyPlan: { planId: 'c-1' },
      phoneApproval: { id: 'ap-1' },
    } as never);
    expect(askRendererFor(item, from)?.value.ref.kind).toBe('task-plan');
  });

  it('sends a ferret’s rule suggestion as Accounts’ kind `rule-suggestion`, the name its renderer draws', () => {
    const item = agendaItem('A4', { signInRuleSuggestion: { suggestion: 'srg_dddddddddddddddd' } } as never);
    const owned = askRendererFor(item, from);
    expect(owned?.key).toBe('ask:sign-in-approval');
    expect(owned?.value.ref).toEqual({ kind: 'rule-suggestion', suggestion: 'srg_dddddddddddddddd' });
  });

  it('draws a recipe proposal from the ref the daemon kept on the item, and only for an ask Accounts raised', () => {
    const ref = { kind: 'recipe-proposal', signIn: 'si_0000000000000001', proposal: 'rp_0123456789abcdef' };
    const raised = agendaItem('A8', { sourceRef: 'ask:sign-in-approval:rp_0123456789abcdef', askRef: ref } as never);
    const owned = askRendererFor(raised, from);
    expect(owned?.key).toBe('ask:sign-in-approval');
    expect(owned?.value.ref).toEqual(ref);
    expect(AskOnScreenSchema.safeParse(owned?.value).success).toBe(true);
    // The Inbox draws the same form from the same item: the renderer key and the value it names.
    const inbox = { connectionFor: () => ({ daemonId: 'workshop' }) } as unknown as AgendaInbox;
    const { planForm } = askFormFor(inbox, inboxCard(raised), () => undefined);
    const props = (planForm as ReactElement<{ rendererKey: string; value: { ref: unknown } }>).props;
    expect(props.rendererKey).toBe('ask:sign-in-approval');
    expect(props.value.ref).toEqual(ref);
    // A ref on an ask another source raised is that source's to draw, not Accounts'.
    const other = agendaItem('A9', { sourceRef: 'ask:card:rp_0123456789abcdef', askRef: ref } as never);
    expect(askRendererFor(other, from)).toBeUndefined();
    // No ref kept (an ask from before the Asks port carried it): nothing is drawn and the card keeps its own words.
    const bare = agendaItem('A10', { sourceRef: 'ask:sign-in-approval:rp_0123456789abcdef' } as never);
    expect(askRendererFor(bare, from)).toBeUndefined();
  });

  it('hands the input renderer the request the card was raised for, from its input or its obligation', () => {
    const id = 'ab'.repeat(16);
    const own = agendaItem('A5', { kind: 'input', input: { requestId: id } } as never);
    expect(askRendererFor(own, from)?.value.ref).toEqual({ kind: 'input', request: id });
    const raised = agendaItem('A6', { kind: 'input', sourceRef: `ask:input:${id}` } as never);
    const owned = askRendererFor(raised, from);
    expect(owned?.key).toBe('ask:input');
    expect(owned?.value.ref).toEqual({ kind: 'input', request: id });
  });

  it('hands the input renderer no request for an input card that names none', () => {
    const bare = agendaItem('A7', { kind: 'input', sourceRef: 'ask:input:not-an-id' } as never);
    expect(askRendererFor(bare, from)?.value.ref).toEqual({ kind: 'input' });
  });
});
