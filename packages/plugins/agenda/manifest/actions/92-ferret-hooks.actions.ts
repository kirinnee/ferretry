/** The hooks other plugins offer that Agenda takes: the composer's `!` menu, the session archive's keep rule, and the launch parts. */
import { manifestFragment } from '@ferretry/kernel/manifest';
import { ASK_REFERENCE_SIGIL } from '@ferretry/core-asks/contract';
import { ArchiveKeeps, LaunchParts } from '@ferretry/core-ferrets/contract';
import { ReferenceCatalog } from '@ferretry/plugin-conversation/contract';

export default manifestFragment({
  hooks: {
    takes: [
      // The composer's `!` menu is this plugin's: the ferret's open asks (reference.catalog).
      { hook: ReferenceCatalog, key: ASK_REFERENCE_SIGIL },
      // The session archive's keep rule (Ferrets' `session.archive-keeps`): a ferret whose board holds an open item stays live.
      { hook: ArchiveKeeps },
      { hook: LaunchParts },
    ],
  },
});
