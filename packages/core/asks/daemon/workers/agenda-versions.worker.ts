import { type AgendaVersionsScope, serveAgendaVersions } from '../adapters/agenda/agenda-versions-program.ts';

declare const self: AgendaVersionsScope;

serveAgendaVersions(self);
