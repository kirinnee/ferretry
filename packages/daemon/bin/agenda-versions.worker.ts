import { type AgendaVersionsScope, serveAgendaVersions } from '../src/adapters/agenda/agenda-versions-program.ts';

declare const self: AgendaVersionsScope;

serveAgendaVersions(self);
