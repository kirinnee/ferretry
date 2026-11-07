import { describe, expect, it } from 'bun:test';
import { AskOnScreenSchema } from '../../../contract/wire.ts';
import { askRendererFor } from '../../../app/features/agenda/ask-renderers.tsx';
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
});
