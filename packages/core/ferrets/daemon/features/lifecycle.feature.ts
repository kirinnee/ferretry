import { createHash } from 'node:crypto';
import {
  ApiError,
  type ApiResponse,
  decodeParameter,
  headerValue,
  jsonResponse,
  queryValue,
} from '@ferretry/kernel/contract';
import {
  type FerretId,
  lookupStartRequest,
  StartRequestsFile,
  startFingerprintText,
  withStartRequest,
} from '../../contract/index.ts';
import { confirmRestore } from '../lib/route-security/restore.ts';
import { terminalLaunchRefusal } from '../lib/route-security/launch.ts';
import { stateHomeLaunchRefusal } from '../lib/route-security/state-home.ts';
import { callerIsAgent, launchOriginOf } from '../lib/ferrets/launch-origin.ts';
import { FY_REQUEST_ID_HEADER } from '../lib/protocol/headers.ts';
import { WARDEN_LABEL } from '../lib/session/peers/warden-lifecycle.ts';
import { RENAME_HTTP } from '../lib/ferrets/service.ts';
import { parseRenameBody, parseResumeBody, parseStartBody, parseStopBody } from '../lib/ferrets/wire.ts';
import { callerFerret, resumeActorOf } from './caller.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, registry, service, ready, pathFerret, mayAct, body, parseJson, stateHomeReach, knownLaunchRoots } = f;

  /** SHA-256 hex of the exact body text, matching the digest the protocol client computes (today's `payloadDigests`). */
  const payloadDigest = (text: string): string =>
    createHash('sha256').update(startFingerprintText(text), 'utf8').digest('hex');
  /** Starts under one request id run one at a time, so a retry racing its original cannot start a second ferret. */
  const startsInFlight = new Map<string, Promise<unknown>>();
  const oneAtATime = async <T>(requestId: string, work: () => Promise<T>): Promise<T> => {
    const before = startsInFlight.get(requestId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.catch(() => undefined);
    startsInFlight.set(requestId, settled);
    try {
      return await run;
    } finally {
      if (startsInFlight.get(requestId) === settled) startsInFlight.delete(requestId);
    }
  };

  const startFailure = (failure: { readonly code: string; readonly reason: string }): never => {
    const status =
      failure.code === 'refused' || failure.code === 'unservable_model'
        ? 409
        : failure.code === 'folder'
          ? 400
          : failure.code === 'harness_not_installed'
            ? 422
            : failure.code === 'state_home'
              ? 403
              : 503;
    throw new ApiError(status, failure.reason, failure.code);
  };

  return {
    routes: {
      'POST /v1/ferrets': async call => {
        await ready();
        const text = await call.request.text();
        const parsed = parseStartBody(parseJson(text));
        const own = callerFerret(call);
        // Today's `lineageOf` (G12): a ferret starts only its own helpers. Naming any other parent is refused; naming
        // none is filled from its token below, so a ferret never starts a parent-less ferret. The owner (no ferret on the
        // call) may start under any parent, which must exist, or none.
        if (own !== undefined && parsed.parent !== undefined && parsed.parent !== own)
          throw new ApiError(
            403,
            'a ferret starts sessions only as its own children; leave the parent out, the daemon reads it from your session',
            'parent_mismatch',
          );
        if (own === undefined && parsed.parent !== undefined && registry.get(parsed.parent) === undefined)
          throw new ApiError(404, `there is no ferret ${parsed.parent} to start a helper of`, 'unknown_parent');
        // The Warden's own label marks the Warden's tree (exempt from the helper limits and supervision); only the Warden
        // starts under it, so an agent asking for it is refused, as today.
        if (parsed.options?.label?.trim() === WARDEN_LABEL && callerIsAgent(call))
          throw new ApiError(
            403,
            'only the Warden starts a ferret under its own label; leave --label out',
            'owner_only',
          );
        // An agent never starts inside the state home (the kernel's name-and-link fence AND its bound-directory identity):
        // 403 there, 503 where the kernel cannot tell. A person is unaffected.
        await stateHomeLaunchRefusal(callerIsAgent(call), stateHomeReach, parsed.folder);
        // What counts as a known project: Projects' registered folders plus the managed worktree root. Read at each start;
        // a throw from Projects answers 503 `launch_roots_unavailable` (it cannot classify), never "outside".
        await terminalLaunchRefusal(call, parsed, knownLaunchRoots);
        let startedFerret: FerretId | undefined;
        const start = async (): Promise<ApiResponse> => {
          const started = await service.start(
            {
              ...parsed,
              // A ferret's start is its helper: the parent is the caller, never a value from the request.
              ...(own === undefined ? {} : { parent: own }),
              by: own === undefined ? 'owner' : 'ferret',
            },
            // Who the start is FOR is the admitted credential's, as the state-home check above judged it.
            launchOriginOf(call),
          );
          if (!started.ok) return startFailure(started.error);
          startedFerret = started.value;
          return jsonResponse({ id: started.value }, 201);
        };
        // A start is IDEMPOTENT on its request id (today's retry contract): the same id and body answer the ferret it
        // already started; the same id with another body is a conflict, never a second ferret.
        const requestId = headerValue(call.request, FY_REQUEST_ID_HEADER)?.trim();
        if (requestId === undefined || requestId === '')
          throw new ApiError(
            400,
            `a start must carry ${FY_REQUEST_ID_HEADER}: without it a retried request starts a second session`,
            'missing_request_id',
          );
        const digest = payloadDigest(text);
        return await oneAtATime(requestId, async () => {
          const held = await kernel.state.read(StartRequestsFile);
          const seen = lookupStartRequest(held.ok ? held.value : undefined, requestId, digest);
          if (seen.kind === 'same') return jsonResponse({ id: seen.ferret });
          if (seen.kind === 'conflict')
            throw new ApiError(
              409,
              `request id ${JSON.stringify(requestId)} already started a different ferret`,
              'request_id_reused',
            );
          const answer = await start();
          const ferret = startedFerret;
          if (ferret !== undefined) {
            await kernel.state.update(StartRequestsFile, current =>
              withStartRequest(current, { requestId, digest, ferret, at: kernel.clock.now() }),
            );
          }
          return answer;
        });
      },
      // Four segments deep with a literal third, so `by-request` can never be mistaken for a ferret id (R-0187).
      'GET /v1/ferrets/by-request/:requestId': async call => {
        await ready();
        const id = decodeParameter(call.params.get('requestId') ?? '');
        if (id === undefined || id === '')
          throw new ApiError(400, 'the request id in the path is not usable', 'invalid_request_id');
        const digest = call.request.query.get('payload')?.[0]?.trim() ?? '';
        if (digest === '')
          throw new ApiError(
            400,
            'a recovery read must carry ?payload=<sha-256 of the start body>: without it any caller could ask which session a request id produced',
            'missing_payload_digest',
          );
        const held = await kernel.state.read(StartRequestsFile);
        const seen = lookupStartRequest(held.ok ? held.value : undefined, id, digest);
        if (seen.kind === 'conflict')
          throw new ApiError(409, `request id ${JSON.stringify(id)} started a different ferret`, 'request_id_reused');
        const summary = seen.kind === 'same' ? await service.get(seen.ferret) : undefined;
        if (summary === undefined)
          throw new ApiError(404, `no start by this daemon carries request id ${JSON.stringify(id)}`, 'not-found');
        return jsonResponse(summary);
      },
      'POST /v1/ferrets/:ferretId/stop': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const how = queryValue(call.request, 'how') === 'now' ? 'now' : 'polite';
        const { reason } = parseStopBody(await body(call));
        await service.stop(id, how, reason);
        return jsonResponse({ id, state: registry.get(id)?.state });
      },
      'POST /v1/ferrets/:ferretId/resume': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const { message } = parseResumeBody(await body(call));
        const resumed = await service.resume(id, message, {
          confirmRestore: confirmRestore(call, callerIsAgent(call)),
          actor: resumeActorOf(call),
          origin: launchOriginOf(call),
        });
        if (!resumed.ok) return startFailure(resumed.error);
        return jsonResponse({ id: resumed.value });
      },
      'POST /v1/ferrets/:ferretId/rename': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const renamed = await service.rename(id, parseRenameBody(await body(call)));
        if (!renamed.ok) {
          const refusal = RENAME_HTTP[renamed.error.failure];
          throw new ApiError(refusal.status, renamed.error.message, refusal.code);
        }
        return jsonResponse(renamed.value);
      },
      'POST /v1/ferrets/:ferretId/revoke-credential': async call => {
        const id = await pathFerret(call);
        return jsonResponse({ id, revoked: await service.revokeToken(id) });
      },
    },
  };
}

export default { id: 'lifecycle', register } satisfies FerretsFeature;
