import { describe, it } from 'bun:test';
import * as agendaMode from '../../src/lib/agenda-mode.ts';
import { sessionView } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const cases: readonly SchemaCase[] = [
  { name: 'agenda mode switch', schema: agendaMode.SessionAgendaModePatchSchema, value: { enabled: true } },
  {
    name: 'agenda mode reading',
    schema: agendaMode.SessionAgendaModeSchema,
    value: { enabled: false, restartRequired: false, note: 'Agenda mode is off.' },
  },
  {
    name: 'agenda mode switch result',
    schema: agendaMode.SessionAgendaModePatchResultSchema,
    value: { view: sessionView, restartRequired: true, note: 'Agenda mode is on from the next launch.' },
  },
];

describe('agenda mode schemas', () => {
  it('should round-trip every agenda mode schema', () => {
    // Arrange + Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(agendaMode, cases);
  });

  it('should refuse a switch without its answer, and a result without the view', () => {
    // Arrange + Act + Assert
    assertRejects([
      { name: 'a switch with no answer', schema: agendaMode.SessionAgendaModePatchSchema, value: {} },
      {
        name: 'a result with no view',
        schema: agendaMode.SessionAgendaModePatchResultSchema,
        value: { restartRequired: true, note: 'x' },
      },
    ]);
  });
});
