import { randomBytes } from 'node:crypto';
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
import { parseStartBody, parseRenameBody } from './lib/ferrets/wire.ts';
import { DEFAULT_CALLSIGN_POOL, suggestCallsigns } from './lib/names/index.ts';
import { ambiguousAgentAddressMessage, resolveAgentAddress } from './lib/protocol/agent-address.ts';
import { FerretRegistry } from './lib/registry/registry.ts';
import { isDeniedPath, normalizeRelativePath } from './lib/session/filesystem/path-policy.ts';
import { FerretTokenDirectory, type TokenEntry } from './lib/tokens/tokens.ts';
import { RegistryWorkFolders } from './lib/work-folders/work-folders.ts';

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
    }
    const held = await kernel.state.read(FerretTokensFile);
    if (held.ok && held.value !== undefined)
      for (const entry of held.value.tokens) tokens.add(entry as TokenEntry);
  })();
  const ready = async (): Promise<void> => {
    await loaded;
  };

  const service = new FerretsService(registry, tokens, {
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
    vault: needs.vault,
    asks: needs.asks,
  });

  /** The ferret a path names: an exact id, or a name (a live holder wins; two on one footing are refused). */
  const pathFerret = async (call: CallContext): Promise<FerretId> => {
    await ready();
    const raw = decodeParameter(call.params.get('sessionId') ?? '');
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

  const body = async (call: CallContext): Promise<unknown> => {
    const text = await call.request.text();
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(400, 'the request body is not JSON', 'invalid_json');
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
      'GET /v1/ferrets': async call => {
        await ready();
        return fleetList.answer(registry.list(), headerValue(call.request, 'if-none-match'));
      },
      'GET /v1/ferrets/:sessionId': async call => {
        const id = await pathFerret(call);
        return jsonResponse(registry.summary(id));
      },
      'POST /v1/ferrets': async call => {
        await ready();
        const parsed = parseStartBody(await body(call));
        const own = callerFerret(call);
        const started = await service.start({
          ...parsed,
          // A ferret's start is its helper: the parent is the caller, never a value from the request.
          ...(own === undefined ? {} : { parent: own }),
          by: own === undefined ? 'owner' : 'ferret',
        });
        if (!started.ok) return startFailure(started.error);
        return jsonResponse({ id: started.value }, 201);
      },
      'POST /v1/ferrets/:sessionId/stop': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const how = queryValue(call.request, 'how') === 'now' ? 'now' : 'polite';
        await service.stop(id, how);
        return jsonResponse({ id, state: registry.get(id)?.state });
      },
      'POST /v1/ferrets/:sessionId/resume': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const resumed = await service.resume(id);
        if (!resumed.ok) return startFailure(resumed.error);
        return jsonResponse({ id: resumed.value });
      },
      'POST /v1/ferrets/:sessionId/rename': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const renamed = await service.rename(id, parseRenameBody(await body(call)).name);
        if (!renamed.ok) throw new ApiError(409, renamed.error, 'name_taken');
        return jsonResponse(renamed.value);
      },
      'POST /v1/ferrets/:sessionId/revoke-credential': async call => {
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
      'GET /v1/ferrets/:sessionId/fs/file': async call => {
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
