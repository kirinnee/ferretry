import {
  AgendaSnapshotSchema,
  ResolvedAgendaItemSchema,
  type AgendaSnapshot,
  type ResolvedAgendaItem,
} from '../../src/lib/agenda.ts';

const AGENDA_PROJECTION_AT = '2026-10-26T09:00:00.000Z';

/** Synthetic documents only: repeated revision, tab and conversation text models a long-lived agenda. */
export const projectionRecord = (id = 'A1'): ResolvedAgendaItem =>
  ResolvedAgendaItemSchema.parse({
    id,
    title: 'Release the relay fix',
    kind: 'info',
    subject: 'The relay fix is ready',
    source: 'agent-raised',
    sourceRef: null,
    why: 'The build passed.',
    howToResolve: 'Read the result.',
    waitingSince: AGENDA_PROJECTION_AT,
    raisedBy: 'agent',
    raisedBySession: 'session',
    raisedByName: 'Morgan',
    body: 'The full picture. '.repeat(400),
    tabs: [{ id: 'notes', name: 'Notes', body: 'Fixture notes. '.repeat(400) }],
    revisions: [
      { at: AGENDA_PROJECTION_AT, by: 'agent', changed: ['body'], previous: { body: 'Earlier facts. '.repeat(400) } },
    ],
    history: [{ kind: 'needs-info', at: AGENDA_PROJECTION_AT, note: 'Please explain.' }],
    conversation: [
      { at: AGENDA_PROJECTION_AT, by: 'ferret', via: 'chat-log', text: 'We checked the release. '.repeat(40) },
    ],
    conversationCount: 1,
    resolvedAt: AGENDA_PROJECTION_AT,
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: 'Checked on the phone.',
    disposition: 'done',
  });

export const projectionSnapshot = (active = 9, resolved = 100): AgendaSnapshot => {
  const {
    resolvedAt: _at,
    resolvedBy: _by,
    resolvedBySession: _session,
    resolvedByName: _name,
    resolutionNote: _note,
    disposition: _disposition,
    ...item
  } = projectionRecord();
  return AgendaSnapshotSchema.parse({
    v: 1,
    sessionId: 'session',
    items: Array.from({ length: active }, (_, index) => ({
      ...item,
      id: `A${index + 1}`,
      body: 'Active facts. '.repeat(200),
      tabs: undefined,
      revisions: undefined,
      conversation: undefined,
      conversationCount: 0,
      history: undefined,
    })),
    resolved: Array.from({ length: resolved }, (_, index) => projectionRecord(`A${active + index + 1}`)),
    count: active,
    parseErrors: 0,
    updatedAt: AGENDA_PROJECTION_AT,
  });
};
