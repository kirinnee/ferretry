import { milliseconds } from '@ferretry/std';
import {
  ApiError,
  bytesResponse,
  decodeParameter,
  jsonResponse,
  type CallContext,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { CAPABILITIES } from '@ferretry/core-gate/contract';
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { fromBase64Url, WebCryptoCloneCrypto } from '@ferretry/std/sealing';
import {
  ChunkUploadSchema,
  CompleteRequestSchema,
  ExportRequestSchema,
  ImportRequestSchema,
  MOVED_STATE,
  PreflightRequestSchema,
  RECEIVED_STATE,
  RELOCATE_MAX_CHUNK_TEXT,
  TargetPreflightRequestSchema,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { kernelCheckout } from './lib/checkout.ts';
import { kernelWorkingTree } from './lib/git-bundle.ts';
import { Importer } from './lib/import.ts';
import { OfferBook, OfferError } from './lib/offer.ts';
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
 * Relocate (C-45), daemon half, SOURCE and TARGET routes. It holds no secret and no credential: what it
 * seals is the closed set `contract/wire.ts` lists, to a key the other machine's offer carries, and the app that carries
 * the ciphertext between the two machines can open none of it.
 */
export default implementDaemon(manifest, {
  build({ kernel, needs, uses }) {
    const moved: MovedLedger = {
      get: async ferret => {
        const read = await kernel.state.read(MOVED_STATE);
        if (!read.ok) throw new Error('the moved ledger could not be read');
        return read.value?.moved[ferret];
      },
      record: async (ferret, entry) => {
        const saved = await kernel.state.update(MOVED_STATE, current => ({
          moved: { ...(current?.moved ?? {}), [ferret]: entry },
        }));
        if (!saved.ok) throw new Error('the move could not be durably recorded');
      },
    };
    const crypto = new WebCryptoCloneCrypto();
    const relocation = new Relocation({
      profileSecrets: async runtime => {
        const runtimes = uses.runtimes.current();
        if (runtimes === undefined)
          throw new RelocateRefused(
            409,
            'Runtimes is off, so the launch secret names cannot be checked',
            'move_refused',
          );
        const home = (await runtimes.homes()).find(home => home.runtimes.includes(runtime as never));
        if (home === undefined)
          throw new RelocateRefused(
            409,
            'the runtime profile is unavailable, so its secret names cannot be checked',
            'move_refused',
          );
        return [...new Set(Object.values(home.secretEnv ?? {}).flatMap(value => secretReferencesIn(value)))];
      },
      signer: kernel.signer,
      redaction: kernel.redaction,
      crypto,
      ferrets: needs.ferrets,
      protect: async (ferret, to) => {
        if (needs.ferrets.relocationProtect === undefined)
          throw new RelocateRefused(409, 'this daemon cannot protect a moved-away stub', 'move_refused');
        await needs.ferrets.relocationProtect(ferret, to);
      },
      treeOf: folder => kernelWorkingTree(kernel, folder),
      daemonId: kernel.identity.daemonId,
      clock: kernel.clock,
      moved,
      log: kernel.log.child('relocate'),
    });

    const offers = new OfferBook({ crypto, signer: kernel.signer, clock: kernel.clock });
    const importer = new Importer({
      crypto,
      ownDaemonId: kernel.identity.daemonId,
      clock: kernel.clock,
      offers,
      ferrets: needs.ferrets,
      projects: () => uses.projects.current(),
      gitAccounts: () => uses.gitAccounts.current(),
      runtimes: () => uses.runtimes.current(),
      vault: () => uses.vault.current(),
      checkout: kernelCheckout(kernel),
      received: {
        record: async (ferret, entry) => {
          const saved = await kernel.state.update(RECEIVED_STATE, current => ({
            received: { ...(current?.received ?? {}), [ferret]: entry },
          }));
          if (!saved.ok) throw new Error('the received ledger could not be written');
        },
      },
      log: kernel.log.child('relocate'),
    });

    const cancelExpiry = kernel.clock.every(milliseconds(1_000), () => {
      void relocation.expire();
      offers.expire();
    });
    kernel.lifecycle.onStop(cancelExpiry);

    const refused = (error: unknown): never => {
      if (error instanceof RelocateRefused || error instanceof OfferError)
        throw new ApiError(error.status, error.message, error.code);
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
      'GET /v1/relocate/moved': async () => {
        const read = await kernel.state.read(MOVED_STATE);
        if (!read.ok) throw new ApiError(500, 'the moved ledger could not be read', 'moved_unreadable');
        return jsonResponse(read.value ?? { moved: {} });
      },
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
        mayReadTree(call);
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
        mayReadTree(call);
        const body = CompleteRequestSchema.safeParse(await readJson(call));
        if (!body.success) throw new ApiError(400, 'complete takes where the ferret went', 'bad_request');
        return jsonResponse(await relocation.complete(param(call, 'exportId'), body.data).catch(refused));
      },
      'POST /v1/relocate/offers': async (call: CallContext) => {
        mayReadTree(call);
        return jsonResponse(await offers.open().catch(refused));
      },
      'POST /v1/relocate/offers/:offerId/preflight': async (call: CallContext) => {
        mayReadTree(call);
        const body = TargetPreflightRequestSchema.safeParse(await readJson(call));
        if (!body.success) throw new ApiError(400, 'preflight takes what the ferret needs', 'bad_request');
        return jsonResponse(await importer.preflight(param(call, 'offerId'), body.data).catch(refused));
      },
      'PUT /v1/relocate/offers/:offerId/chunks/:index': async (call: CallContext) => {
        mayReadTree(call);
        const index = Number(param(call, 'index'));
        if (!Number.isSafeInteger(index) || index < 0)
          throw new ApiError(400, 'a chunk index is a whole number', 'bad_request');
        let text: string;
        try {
          text = await call.request.text(RELOCATE_MAX_CHUNK_TEXT + 64);
        } catch {
          throw new ApiError(413, "a chunk is larger than a move's chunk size", 'body_too_large');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        const body = ChunkUploadSchema.safeParse(parsed);
        const bytes = body.success ? fromBase64Url(body.data.chunk) : null;
        if (bytes === null) throw new ApiError(400, 'a chunk is base64url ciphertext', 'bad_request');
        try {
          importer.receive(param(call, 'offerId'), index, bytes);
        } catch (error) {
          return refused(error);
        }
        return jsonResponse({ index });
      },
      'POST /v1/relocate/offers/:offerId/import': async (call: CallContext) => {
        mayReadTree(call);
        const body = ImportRequestSchema.safeParse(await readJson(call));
        if (!body.success) throw new ApiError(400, 'import takes the header the source sealed with', 'bad_request');
        return jsonResponse(await importer.import(param(call, 'offerId'), body.data).catch(refused));
      },
    } satisfies Record<string, RouteHandler>;

    return { routes };
  },
});
