import { type FerretId, type FerretsApi, type StartFailure } from '@ferretry/core-ferrets/contract';
import type { WardenWorkFolders } from './adapters/index.ts';
import { WARDEN_SWEEP_ORIGIN } from './lib/remedy.ts';
import { WardenCallsignTakenError, type WardenSpawner } from './lib/sweep.ts';
import { WARDEN_LABEL } from './lib/types.ts';

const HARNESS_OF: Readonly<Record<string, 'claude' | 'codex'>> = { 'claude-code': 'claude', codex: 'codex' };

/** A refused start says a name is held in these words (`FerretsService.takeName`); the sweep then takes the next name. */
const NAME_HELD = /\bis held by\b|\bis already (?:in use|claimed|taken)\b|\bcallsign_taken\b/iu;

const sentence = (failure: StartFailure): string => `${failure.code}: ${failure.reason}`;

/**
 * Puts an investigator on the machine as an ordinary ferret, started through Ferrets and nothing else.
 *
 * It is started AS THE WARDEN (`by: 'warden'`, the Warden's own label, which keeps the lineage shield and the
 * supervision exemptions) under an agent origin, so it is fenced out of the Ferretry home. It works in a folder of its
 * own that the Warden made outside the home ({@link WardenWorkFolders}); it hands its report back with `signal done`,
 * which Ferrets keeps as its summary and `FileWardenArtifacts` files as the report. The account the sweep chose is the
 * runtime it runs on: Ferrets refuses an unknown or signed-out one, and the sweep strikes that account and moves on.
 */
export function ferretsWardenSpawner(ports: {
  readonly ferrets: FerretsApi;
  readonly folders: WardenWorkFolders;
}): WardenSpawner {
  return {
    spawn: async request => {
      const folder = await ports.folders.folderFor(request.teammate ?? 'investigator');
      const started = await ports.ferrets.start(
        {
          ...(request.teammate === undefined ? {} : { name: request.teammate }),
          runtime: request.agent,
          folder,
          workFolder: folder,
          prompt: request.prompt,
          by: 'warden',
          options: {
            title: request.name,
            label: WARDEN_LABEL,
            mode: 'auto',
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.effort === undefined ? {} : { effort: request.effort }),
          },
        },
        WARDEN_SWEEP_ORIGIN,
      );
      if (!started.ok) {
        if (started.error.code === 'refused' && NAME_HELD.test(started.error.reason))
          throw new WardenCallsignTakenError(request.teammate ?? '');
        throw new Error(`the investigator could not be started (${sentence(started.error)})`);
      }
      const id: FerretId = started.value;
      const ferret = await ports.ferrets.get(id);
      if (ferret === undefined) throw new Error('the investigator started but cannot be read back');
      return {
        sessionId: id,
        createdAt: ferret.createdAt,
        agent: ferret.runtime ?? request.agent,
        harness: HARNESS_OF[ferret.harness] ?? 'claude',
        // What ran, never what was asked for: provenance records the ferret's own model.
        model: ferret.model ?? request.model ?? 'default',
        modelSource: ferret.model === undefined ? 'configured' : 'agent',
      };
    },
  };
}
