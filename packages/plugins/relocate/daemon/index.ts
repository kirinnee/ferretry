import {
  ApiError,
  bytesResponse,
  decodeParameter,
  jsonResponse,
  type CallContext,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { CAPABILITIES } from '@ferretry/core-gate/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { WebCryptoCloneCrypto } from '@ferretry/std/sealing';
import { CompleteRequestSchema, ExportRequestSchema, MOVED_STATE, PreflightRequestSchema } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { kernelWorkingTree } from './lib/git-bundle.ts';
import { type MovedLedger, Relocation, RelocateRefused } from './lib/relocation.ts';

/** The request body as JSON, or `undefined` when it is missing or is not JSON (the route then answers 400). */
async function readJson(call: CallContext): Promise<unknown> {
  try {
    return JSON.parse(await call.request.text());
  } catch {
    return undefined;
  }
}

/**
 * Relocate (C-45), daemon half, the SOURCE end: four person's routes. It holds no secret and no credential: what it
 * seals is the closed set `contract/wire.ts` lists, to a key the other machine's offer carries, and the app that carries
 * the ciphertext between the two machines can open none of it.
 */
export default implementDaemon(manifest, {
  build({ kernel, needs }) {
    const moved: MovedLedger = {
      get: async ferret => {
        const read = await kernel.state.read(MOVED_STATE);
        return read.ok ? read.value?.moved[ferret] : undefined;
      },
      record: async (ferret, entry) => {
        await kernel.state.update(MOVED_STATE, current => ({ moved: { ...(current?.moved ?? {}), [ferret]: entry } }));
      },
    };
    const relocation = new Relocation({
      crypto: new WebCryptoCloneCrypto(),
      ferrets: needs.ferrets,
      treeOf: folder => kernelWorkingTree(kernel, folder),
      daemonId: kernel.identity.daemonId,
      clock: kernel.clock,
      moved,
      log: kernel.log.child('relocate'),
    });

    const refused = (error: unknown): never => {
      if (error instanceof RelocateRefused) throw new ApiError(error.status, error.message, error.code);
      throw error;
    };
    /** A move reads a working tree, so it also needs `filesystem.use` where grants govern the caller. */
    const mayReadTree = (call: CallContext): void => {
      const governance = call.governance;
      if (governance?.governed !== true) return;
      const decision = governance.decide({ capability: CAPABILITIES.filesystem, axis: 'use' });
      if (!decision.allowed)
        throw new ApiError(403, 'this device may not read a working tree, so it may not move a ferret', 'forbidden');
    };
    const param = (call: CallContext, name: string): string => {
      const raw = call.params.get(name);
      const value = raw === undefined ? undefined : decodeParameter(raw);
      if (value === undefined || value === '') throw new ApiError(400, `${name} is missing`, 'bad_request');
      return value;
    };

    const routes = {
      'POST /v1/relocate/:ferretId/preflight': async (call: CallContext) => {
        mayReadTree(call);
        const body = PreflightRequestSchema.safeParse(await readJson(call));
        if (!body.success) throw new ApiError(400, 'preflight takes the daemon id of the other machine', 'bad_request');
        return jsonResponse(await relocation.preflight(param(call, 'ferretId'), body.data.to).catch(refused));
      },
      'POST /v1/relocate/:ferretId/export': async (call: CallContext) => {
        mayReadTree(call);
        const body = ExportRequestSchema.safeParse(await readJson(call));
        if (!body.success) throw new ApiError(400, 'export takes the other machine’s signed offer', 'bad_request');
        return jsonResponse(await relocation.export(param(call, 'ferretId'), body.data.offer).catch(refused));
      },
      'GET /v1/relocate/exports/:exportId/chunks/:index': async (call: CallContext) => {
        const index = Number(param(call, 'index'));
        if (!Number.isSafeInteger(index) || index < 0)
          throw new ApiError(400, 'a chunk index is a whole number', 'bad_request');
        try {
          return bytesResponse(relocation.chunk(param(call, 'exportId'), index), 'application/octet-stream');
        } catch (error) {
          return refused(error);
        }
      },
      'POST /v1/relocate/exports/:exportId/complete': async (call: CallContext) => {
        const body = CompleteRequestSchema.safeParse(await readJson(call));
        if (!body.success) throw new ApiError(400, 'complete takes where the ferret went', 'bad_request');
        return jsonResponse(await relocation.complete(param(call, 'exportId'), body.data).catch(refused));
      },
    } satisfies Record<string, RouteHandler>;

    return { routes };
  },
});
