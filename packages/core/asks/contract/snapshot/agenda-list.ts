import { agendaTaskKind, agendaTitle } from './agenda-task.ts';
import { type AgendaListSnapshot, type AgendaSnapshot, ResolvedAgendaHeaderSchema } from './agenda.ts';

/** Active and parked items stay complete; every closed item is a header, with no recent-full exception. */
export const agendaListSnapshot = (snapshot: AgendaSnapshot): AgendaListSnapshot => ({
  ...snapshot,
  resolved: snapshot.resolved.map(item => {
    const earlier = [...(item.stages ?? [])].reverse().find(stage => stage.stage !== 'done');
    return ResolvedAgendaHeaderSchema.parse({
      ...item,
      title: agendaTitle(item),
      kind: agendaTaskKind(item),
      projection: 'header',
      lifecycle: 'addressed',
      conversationCount: item.conversationCount ?? item.conversation?.length ?? 0,
      stages: earlier === undefined ? undefined : [earlier],
    });
  }),
});
