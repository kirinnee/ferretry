import { type AgendaVersionsScope, serveAgendaVersions } from '../../../src/adapters/agenda/agenda-versions-program.ts';
import { SqliteAgendaVersionStore } from '../../../src/adapters/agenda/sqlite-agenda-versions.ts';
import { SlowCommitDatabase } from './slow-sqlite.ts';

declare const self: AgendaVersionsScope;

serveAgendaVersions(
  self,
  directory =>
    new SqliteAgendaVersionStore(
      () => directory,
      file => new SlowCommitDatabase(file, 1_500),
    ),
);
