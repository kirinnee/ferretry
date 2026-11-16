import { ApiError, headerValue, jsonResponse } from '@ferretry/kernel/contract';
import { FerretLiveReadSchema, SubtreeViewSchema } from '../../contract/index.ts';
import { ConditionalFleetList } from '../lib/fleet-list/conditional.ts';
import { liveRead } from '../lib/protocol/session-subtree.ts';
import { SubtreeService } from '../lib/session/pack/subtree.ts';
import { hiddenFromLiveList } from '../modules/archive.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, registry, service, ready, storeLoaded, pathFerret, mayAct, isArchived } = f;
  const { outdated, displayModelOf, ingestEvidenceOf } = f;
  const outdatedMarks = outdated.marks;
  const fleetList = new ConditionalFleetList();
  // G24: the same bounded read as today's subtree API, masked whole before excerpts are cut.
  const subtree = new SubtreeService(registry, {
    nowMs: () => kernel.clock.nowMs(),
    model: displayModelOf,
    lines: async ferret => (await service.sitrep(ferret))?.lines ?? [],
    redact: texts => kernel.redaction.read(scope => texts.map(text => scope.text(text))),
  });

  return {
    routes: {
      // The LIVE list: a ferret the archive took out of the live set is left out (nothing is deleted: its record, its
      // documents and `GET /v1/ferrets/:id` stay, and a write brings it back); `GET /v1/archived-sessions` lists it.
      'GET /v1/ferrets': async call => {
        await ready();
        await storeLoaded.catch(() => undefined);
        // Hidden only while ARCHIVED AND STOPPED: a ferret the record holds in any other state is live whatever the archive
        // flag says (an adopted live pane writes only the record, and a revival's document write may still be on its way).
        const live = (await service.list()).filter(
          summary => !hiddenFromLiveList(summary.state, isArchived(summary.id)),
        );
        return fleetList.answer(await outdatedMarks.list(live), headerValue(call.request, 'if-none-match'));
      },
      'GET /v1/ferrets/:ferretId/subtree': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const view = await subtree.view(id);
        if (view === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
        return jsonResponse(SubtreeViewSchema.parse(view));
      },
      'GET /v1/ferrets/:ferretId': async call => {
        const id = await pathFerret(call);
        const summary = await service.get(id);
        // `pathFerret` already refused an id the registry does not hold; a ferret gone in between is still a 404 with a
        // sentence, never a 200 with no body.
        if (summary === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
        return jsonResponse(await outdatedMarks.one(summary));
      },
      'GET /v1/ferrets/:ferretId/live': async call =>
        jsonResponse(FerretLiveReadSchema.parse(liveRead(await ingestEvidenceOf(await pathFerret(call))))),
    },
  };
}

export default { id: 'fleet-reads', register } satisfies FerretsFeature;
