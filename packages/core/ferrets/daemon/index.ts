import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BearerDigest } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  decodeParameter,
  type FencedPath,
  headerValue,
  jsonResponse,
  queryValue,
} from '@ferretry/kernel/contract';
import { type DaemonContext, type DaemonHalf, implementDaemon } from '@ferretry/kernel/manifest';
import { err, ok } from '@ferretry/std';
import {
  type FerretId,
  FerretChanged,
  FerretFiles,
  FerretHistoryFiles,
  type FerretRecord,
  FerretsChanged,
  FerretTokensFile,
  type HarnessKey,
  Harnesses,
  LaunchParts,
  Runners,
  SitrepLines,
  StartDecide,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { ConditionalFleetList } from './lib/fleet-list/conditional.ts';
import { FerretsService } from './lib/ferrets/service.ts';
import { parseRenameBody, parseResumeBody, parseStartBody, parseStopBody } from './lib/ferrets/wire.ts';
import { createSessionEvent, encodeSessionEvent, parseSessionEvent } from './lib/storage/journal.ts';
import type { SessionId } from './lib/session-id.ts';
import { DEFAULT_CALLSIGN_POOL, suggestCallsigns } from './lib/names/index.ts';
import { ambiguousAgentAddressMessage, resolveAgentAddress } from './lib/protocol/agent-address.ts';
import { FerretRegistry } from './lib/registry/registry.ts';
import { isDeniedPath, normalizeRelativePath } from './lib/session/filesystem/path-policy.ts';
import { FerretTokenDirectory, type TokenEntry } from './lib/tokens/tokens.ts';
import { RegistryWorkFolders } from './lib/work-folders/work-folders.ts';
import { buildWorktrees } from './modules/worktrees.ts';
import { FY_REQUEST_ID_HEADER } from './lib/protocol/headers.ts';
import { lookupStartRequest, StartRequestsFile, withStartRequest } from './lib/ferrets/start-requests.ts';
import { sessionFilesystemRoutes } from './lib/runtime/mounts/session-filesystem.ts';
import { StateAgentPinRepository } from './adapters/agent-pins/index.ts';
import { RegistryPinSessionDirectory, StatePinRepository } from './adapters/pins/index.ts';
import { KeyedSerialExecutor } from './adapters/storage/keyed-serial-executor.ts';
import { AgentPinService, AgentPinSubsystem, withPinned } from './lib/agent-pins/index.ts';
import { PinService } from './lib/pins/index.ts';
import { pinRoutes } from './lib/runtime/mounts/pins.ts';
import { sessionPinRoutes } from './lib/runtime/mounts/session-pin.ts';
import { type SessionArchiveSubsystem, sessionArchiveRoutes } from './lib/runtime/mounts/session-archive.ts';
import { type SessionRestartSubsystem, sessionRestartRoutes } from './lib/runtime/mounts/session-restart.ts';
import { type SessionSignalSubsystem, sessionSignalRoutes } from './lib/runtime/mounts/session-signal.ts';
import { AgentPinsFile, FerretDetailsFiles, FerretPinFiles } from './lib/state.ts';

/** The code an agent asking for a ferret that is not its own, or its helper's, is refused with (today's). */
export const NOT_OWN_FERRET_CODE = 'not_own_session';

/** The ferret a ferret token names, from Gate's standing; `undefined` for a person or another agent. */
export function callerFerret(call: CallContext): FerretId | undefined {
  return call.credential?.tokenClass === 'ferret' ? call.credential.ferret : undefined;
}

/** Whether the caller is an agent (a ferret's token, the warden, or the admin token with a ferret behind it). */
function callerIsAgent(call: CallContext): boolean {
  const credential = call.credential;
  if (credential === undefined) return false;
  if (credential.tokenClass === 'ferret' || credential.tokenClass === 'warden') return true;
  if (credential.tokenClass === 'device') return false;
  return call.actor !== 'admin-ui' && call.actor !== 'admin-cli';
}

/** A random ferret id: base-36 time + 8 hex characters (today's `TimeSessionIdFactory`). */
const mintId = (nowMs: number): FerretId =>
  `${nowMs.toString(36)}-${randomBytes(4).toString('hex')}` as FerretId;

function build(ctx: DaemonContext<typeof manifest>): DaemonHalf<typeof manifest> {
  const { kernel, hooks, needs } = ctx;
  const log = kernel.log.child('ferrets');
  const registry = new FerretRegistry();
  const tokens = new FerretTokenDirectory();
  const workFolders = new RegistryWorkFolders(registry);
  const fleetList = new ConditionalFleetList();
  let generation = 0;

  // Load what is held. Sync answers (`mayTouch`, `bearers:ferret`, `WorkFolders`) see nothing until this lands,
  // which fails closed: an unknown ferret is refused, an unknown digest is no ferret.
  const loaded = (async () => {
    for (const name of await kernel.state.list(FerretFiles)) {
      const read = await kernel.state.read(FerretFiles, name);
      if (read.ok && read.value !== undefined) registry.put(read.value);
      else if (!read.ok) log.warn('a ferret record could not be read', { file: read.error.file });
      if (!read.ok || read.value === undefined) continue;
      // Its start options and title, kept beside the record so a list or a read stays memory-only.
      const details = await kernel.state.read(FerretDetailsFiles, name);
      if (details.ok && details.value !== undefined) registry.putDetails(read.value.id, details.value);
      else if (!details.ok) log.warn('a ferret details file could not be read', { file: details.error.file });
    }
    const held = await kernel.state.read(FerretTokensFile);
    if (held.ok && held.value !== undefined)
      for (const entry of held.value.tokens) tokens.add(entry as TokenEntry);
  })();
  const ready = async (): Promise<void> => {
    await loaded;
  };

  // The owner's sidebar pins (agent-pins.json): the service marks `pinnedAt` on each summary from them.
  const pinClock = { now: () => kernel.clock.now() };
  const agentPins = new AgentPinService(
    new StateAgentPinRepository(kernel.state, AgentPinsFile),
    pinClock,
    new KeyedSerialExecutor(),
  );

  /**
   * Today's journal append (`storage/session-storage.ts` `append`) without its index: the next sequence after the
   * last readable event. One chain per ferret; a journal that cannot be read to its end is not appended to.
   */
  const historyQueue = new KeyedSerialExecutor();
  const appendHistory = async (ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>) =>
    await historyQueue
      .run(ferret, async () => {
        let last = 0;
        for await (const line of kernel.state.lines(FerretHistoryFiles, ferret)) {
          const event = parseSessionEvent(line, ferret as unknown as SessionId);
          if (event !== undefined) last = Math.max(last, event.sequence);
        }
        const event = createSessionEvent(ferret as unknown as SessionId, last, kernel.clock.now(), type, data);
        await kernel.state.append(FerretHistoryFiles, encodeSessionEvent(event), ferret);
      })
      .catch((error: unknown) =>
        log.warn('a ferret history event could not be recorded', {
          ferret,
          type,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

  const service = new FerretsService(registry, tokens, {
    ready,
    now: () => kernel.clock.now(),
    newId: () => mintId(kernel.clock.nowMs()),
    newName: taken =>
      DEFAULT_CALLSIGN_POOL.find(candidate => !taken(candidate)) ?? `ferret-${randomBytes(3).toString('hex')}`,
    save: async (record: FerretRecord) => await kernel.state.write(FerretFiles, record, record.id),
    saveTokens: async entries =>
      await kernel.state.write(FerretTokensFile, {
        format: 1,
        tokens: entries.map(entry => ({ ...entry })) as never,
      }),
    harness: key => {
      const found = hooks.provider(Harnesses, key);
      return found === 'unavailable' ? undefined : found;
    },
    harnessKeys: () => [...hooks.providers(Harnesses).keys()] as HarnessKey[],
    runner: () => {
      const found = hooks.provider(Runners, 'tmux');
      return found === 'unavailable' ? undefined : found;
    },
    decide: async input => await hooks.decide(StartDecide, input),
    launchParts: () => hooks.contributions(LaunchParts).map(contribution => contribution.item),
    sitrepSources: () => hooks.contributions(SitrepLines).map(contribution => contribution.item),
    instructions: () => kernel.snapshot.current().instructions,
    home: ferret => {
      const home = kernel.roots.root('agent-homes', { ferret }).resolve('.');
      return home.ok ? home.value : ('' as FencedPath);
    },
    folder: path => {
      if (!path.startsWith('/')) return err('the folder must be an absolute path');
      return ok(path as FencedPath);
    },
    changed: payload => {
      generation += 1;
      hooks.observe(FerretChanged, payload);
      kernel.events.publish(FerretsChanged, { ferret: payload.ferret, generation });
    },
    saveDetails: async (ferret, details) => await kernel.state.write(FerretDetailsFiles, details, ferret),
    history: appendHistory,
    pinnedAt: async () => await agentPins.pinnedAt(),
    // Binds to the `work` root's `RootHandle.realPath` when kernel item N reaches the base; until then no work folder
    // is answered (fails closed: Accounts gets no folder default).
    realPath: async () => undefined,
    vault: needs.vault,
    asks: needs.asks,
  });

  // Managed worktrees (today's worktrees module). The Git/disk IO is the kernel's spawn and root additions on
  // rebuild/port-kernel; until the host has them there is no managed root and every route says so.
  const worktrees = buildWorktrees({
    state: kernel.state,
    clock: kernel.clock,
    sessions: async () => {
      await ready();
      // A ferret standing in a folder, as today's session directory reported it: stopped ferrets are finished.
      return registry.list().map(ferret => ({
        id: ferret.id,
        cwd: ferret.folder,
        status: ferret.state === 'stopped' ? ('stopped' as const) : ('running' as const),
        ...(ferret.state === 'stopped' ? { finishedAt: ferret.stateAt } : {}),
      }));
    },
    terminalRoots: async () => undefined,
    newId: () => randomUUID(),
  });

  /** The ferret a path names: an exact id, or a name (a live holder wins; two on one footing are refused). */
  const pathFerret = async (call: CallContext): Promise<FerretId> => {
    await ready();
    const raw = decodeParameter(call.params.get('ferretId') ?? '');
    if (raw === undefined || raw === '')
      throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_session_id');
    const resolution = resolveAgentAddress(
      raw,
      registry.list().map(ferret => ({ id: ferret.id, name: ferret.name, status: ferret.state })),
    );
    if (resolution.kind === 'session') return resolution.id as FerretId;
    if (resolution.kind === 'ambiguous')
      throw new ApiError(409, ambiguousAgentAddressMessage(resolution.name, resolution.candidates), 'ambiguous_name');
    throw new ApiError(404, `no ferret ${raw}`, 'not-found');
  };

  /** S47: an agent reaches only its own ferret and its helpers'; a person is unaffected. */
  const agentMayReach = (call: CallContext, target: FerretId): void => {
    if (!callerIsAgent(call)) return;
    const own = callerFerret(call);
    if (own === undefined)
      throw new ApiError(
        403,
        'an agent reads only its own ferret’s files, and this request names no ferret of its own',
        NOT_OWN_FERRET_CODE,
      );
    if (!registry.mayTouch(own, target))
      throw new ApiError(
        403,
        `an agent reads only its own ferret’s files and its helpers’, and ${target} is neither`,
        NOT_OWN_FERRET_CODE,
      );
  };

  /** A ferret may stop, resume or rename itself and its helpers; a person any ferret. */
  const mayAct = (call: CallContext, target: FerretId): void => {
    const own = callerFerret(call);
    if (own !== undefined && !registry.mayTouch(own, target))
      throw new ApiError(403, `a ferret acts only on itself and its helpers, and ${target} is neither`, 'forbidden');
  };

  // The file browser's listing, index, changes and diff (today's session-filesystem mount). The service runs on the
  // kernel's identity-returning root walk, which is not bound yet, so these answer 503 until it is.
  const fileBrowser = sessionFilesystemRoutes({
    filesystem: undefined,
    reach: async call => {
      const id = await pathFerret(call);
      agentMayReach(call, id);
      const folder = registry.get(id)?.folder;
      if (folder === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      // An agent's read sits behind the state-home fence, which the host resolves; with none resolved an agent is
      // refused, exactly as today's daemon refused it when it could not resolve its own home.
      if (callerIsAgent(call))
        throw new ApiError(
          503,
          'this daemon cannot resolve its own state home, so it does nothing for an agent that could reach it',
          'state_home_unresolved',
        );
      return { id, cwd: folder };
    },
  });

  const parseJson = (text: string): unknown => {
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(400, 'the request body is not JSON', 'invalid_json');
    }
  };
  const body = async (call: CallContext): Promise<unknown> => parseJson(await call.request.text());

  /**
   * A session service whose ports (terminals, harness, runtimes) are not bound in this build yet: every call answers
   * the spine's 503 skeleton (D10) instead of a route that is missing. Signal, restarts and the archive list.
   */
  const notBuilt = <T extends object>(what: string): T =>
    new Proxy({} as T, {
      get: () => () => {
        throw new ApiError(503, `${what} is not built yet in this version of Ferretry.`, 'plugin_unavailable');
      },
    });
  const signals = sessionSignalRoutes(notBuilt<SessionSignalSubsystem>('The ferret lifecycle signal'));
  const restarts = sessionRestartRoutes(notBuilt<SessionRestartSubsystem>('Restarting ferrets'));
  const archived = sessionArchiveRoutes(notBuilt<SessionArchiveSubsystem>('The archived ferret list'));

  // Pins (a3's handlers): the owner's sidebar pins (agent-pins.json) and each ferret's note board (<ferret>/pins.json).
  const pinnedReader = withPinned(
    {
      list: async () => {
        await ready();
        return registry.list().map(ferret => registry.summary(ferret.id)).filter(summary => summary !== undefined);
      },
      get: async reference => {
        await ready();
        const resolution = resolveAgentAddress(
          reference,
          registry.list().map(ferret => ({ id: ferret.id, name: ferret.name, status: ferret.state })),
        );
        return resolution.kind === 'session' ? registry.summary(resolution.id as FerretId) : undefined;
      },
    },
    agentPins,
  );
  const sidebarPins = sessionPinRoutes(new AgentPinSubsystem(pinnedReader, agentPins));
  const noteBoard = pinRoutes({
    pins: new PinService(
      new RegistryPinSessionDirectory(ferret => registry.get(ferret as FerretId) !== undefined),
      new StatePinRepository(kernel.state, FerretPinFiles, pinClock),
      pinClock,
      { next: () => randomUUID() },
    ),
    ferretOf: pathFerret,
    callerOf: call => {
      const own = callerFerret(call);
      return { isAgent: callerIsAgent(call), ...(own === undefined ? {} : { ferret: own }) };
    },
  });

  /** SHA-256 hex of the exact body text, matching the digest the protocol client computes (today's `payloadDigests`). */
  const payloadDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
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
    const status = failure.code === 'refused' ? 409 : failure.code === 'folder' ? 400 : 503;
    throw new ApiError(status, failure.reason, failure.code);
  };

  return {
    provides: { ferrets: service, workFolders },
    hooks: {
      'bearers:ferret': {
        ferretFor: (digest: BearerDigest) => tokens.ferretFor(digest),
        generation: () => tokens.generation(),
      },
    },
    routes: {
      ...worktrees.routes,
      ...fileBrowser,
      ...signals,
      ...restarts,
      ...archived,
      'POST /v1/ferrets/:ferretId/pin': sidebarPins.pin,
      'POST /v1/ferrets/:ferretId/unpin': sidebarPins.unpin,
      'GET /v1/ferrets/:ferretId/pins': noteBoard.list,
      'POST /v1/ferrets/:ferretId/pins': noteBoard.apply,
      'GET /v1/ferrets': async call => {
        await ready();
        return fleetList.answer(await service.list(), headerValue(call.request, 'if-none-match'));
      },
      'GET /v1/ferrets/:ferretId': async call => {
        const id = await pathFerret(call);
        return jsonResponse(await service.get(id));
      },
      'POST /v1/ferrets': async call => {
        await ready();
        const text = await call.request.text();
        const parsed = parseStartBody(parseJson(text));
        const own = callerFerret(call);
        let startedFerret: FerretId | undefined;
        const start = async (): Promise<ApiResponse> => {
          const started = await service.start({
            ...parsed,
            // A ferret's start is its helper: the parent is the caller, never a value from the request.
            ...(own === undefined ? {} : { parent: own }),
            by: own === undefined ? 'owner' : 'ferret',
          });
          if (!started.ok) return startFailure(started.error);
          startedFerret = started.value;
          return jsonResponse({ id: started.value }, 201);
        };
        // A start is IDEMPOTENT on its request id (today's retry contract): the same id and body answer the ferret it
        // already started; the same id with another body is a conflict, never a second ferret.
        const requestId = headerValue(call.request, FY_REQUEST_ID_HEADER)?.trim();
        if (requestId === undefined || requestId === '') return await start();
        const digest = payloadDigest(text);
        return await oneAtATime(requestId, async () => {
          const held = await kernel.state.read(StartRequestsFile);
          const seen = lookupStartRequest(held.ok ? held.value : undefined, requestId, digest);
          if (seen.kind === 'same') return jsonResponse({ id: seen.ferret });
          if (seen.kind === 'conflict')
            throw new ApiError(409, `request id ${JSON.stringify(requestId)} already started a different ferret`, 'request_id_reused');
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
        const resumed = await service.resume(id, message);
        if (!resumed.ok) return startFailure(resumed.error);
        return jsonResponse({ id: resumed.value });
      },
      'POST /v1/ferrets/:ferretId/rename': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const renamed = await service.rename(id, parseRenameBody(await body(call)));
        if (!renamed.ok) throw new ApiError(409, renamed.error, 'name_taken');
        return jsonResponse(renamed.value);
      },
      'POST /v1/ferrets/:ferretId/revoke-credential': async call => {
        const id = await pathFerret(call);
        return jsonResponse({ id, revoked: await service.revokeToken(id) });
      },
      'GET /v1/names': async call => {
        await ready();
        const raw = queryValue(call.request, 'count');
        const count = raw === undefined ? 1 : Number(raw);
        if (!Number.isInteger(count) || count < 1)
          throw new ApiError(400, 'count must be a whole number of at least one', 'invalid_count');
        const nowMs = kernel.clock.nowMs();
        const claims = registry
          .list()
          .filter(ferret => ferret.state !== 'stopped')
          .map(ferret => ({ callsign: ferret.name, ownerId: ferret.id, claimedAtMs: 0, expiresAtMs: nowMs + 1 }));
        const start = Math.floor(nowMs / 1000) % DEFAULT_CALLSIGN_POOL.length;
        return jsonResponse([...suggestCallsigns(DEFAULT_CALLSIGN_POOL, claims, nowMs, count, start)]);
      },
      'GET /v1/ferrets/:ferretId/fs/file': async call => {
        const id = await pathFerret(call);
        agentMayReach(call, id);
        const relative = normalizeRelativePath(queryValue(call.request, 'path'));
        if (relative === '') throw new ApiError(400, 'query parameter "path" is required', 'invalid_path');
        if (isDeniedPath(relative)) throw new ApiError(403, `${relative} is never served`, 'denied');
        const folder = workFolders.check(id, relative);
        if (!folder.ok) throw new ApiError(403, `${relative} is outside the ferret's folder`, 'escapes_root');
        const root = kernel.roots.root('work', { ferret: id });
        const resolved = root.resolve(relative);
        if (!resolved.ok)
          throw new ApiError(403, `${relative} may not be read (${resolved.error})`, 'escapes_root');
        const stat = await root.stat(resolved.value);
        if (stat === undefined) throw new ApiError(404, `${relative} does not exist`, 'not_found');
        if (stat.kind !== 'file') throw new ApiError(400, `${relative} is not a file`, 'not_a_file');
        const text = await root.readText(resolved.value, 1024 * 1024);
        return await kernel.redaction.read(
          (scope): ApiResponse => jsonResponse({ path: relative, size: stat.size, content: scope.text(text) }),
        );
      },
    },
  };
}

/** Ferrets' daemon half (§2.2). `buildMoves(ctx, deps)` (ferrets-c: fork, handover, move) joins `build` here. */
export default implementDaemon(manifest, { build });
