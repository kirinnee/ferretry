/**
 * The configuration files over HTTP (docs/config-files.md): one file (`GET /v1/config/file`), an edit
 * (`PUT /v1/config/file`), a removal (`DELETE /v1/config/file`, kernel batch #11) and the owner's confirmation of an edit that loosens (`POST /v1/config/confirm`). Today's
 * `mounts/config-files.ts`, with the per-file knowledge taken out: the kernel resolves a path to the file a plugin
 * declared and runs the one config writer; WHO may read, write or confirm which file is Gate's answer
 * (`Admission.judgeConfigAccess`), asked per file before the act.
 *
 * A loosening is put into effect at once only when Gate says this call may (`mayLoosen`: somebody at this machine, or
 * a device with a fresh passkey proof that already existed when the request was admitted); anyone else's is written and HELD, the tighter version in effect. No
 * raw secret is accepted: the writer refuses it like a file that does not parse, and no issue repeats the value.
 *
 * `noStore` on all four: every answer is a statement about now.
 */
import { z } from 'zod';
import type { Admission, ConfigAct, ConfigAccessVerdict } from '../../contract/bound.ts';
import { parseBody } from '../../contract/body.ts';
import { ApiError, errorResponse, headerValue, jsonResponse, queryValue } from '../../contract/http.ts';
import type { ConfigFileIssue, ConfigFilesWriter, ConfigTarget } from '../../contract/ports.ts';
import type { RouteHandler } from '../../contract/route.ts';
import { currentActor, currentStanding } from '../call-scope.ts';
import { countProblems } from './check.ts';
import { type ConfigDeclaration, targetOfPath } from './claims.ts';
import { schemaFileName, schemaModeline } from './schemas.ts';
import { shownConfigText } from './shown-text.ts';

/** The largest configuration file read or written over the wire (today's `CONFIG_FILE_MAX_BYTES`). */
const FILE_MAX_BYTES = 256 * 1024;

/** The header `PUT /v1/config/file` reads the etag the edit was made against from (today's). */
const IF_MATCH = 'if-match';

/** The code of a file that does not check; the body carries the located issues (today's). */
const CONFIG_INVALID_CODE = 'config_invalid';

const NOT_A_FILE =
  'not a Ferretry configuration file — name a file a plugin declares under config/ (fy config check lists them)';

export interface ConfigRouteSources {
  /** The writer over every declared file; absent: no config routes can act. */
  writer(): ConfigFilesWriter | undefined;
  /** Gate's admission, read live. */
  admission(): Admission | undefined;
  /** The home, absolute: a file's `absolutePath` is `<home>/config/<path>`. */
  readonly home: string;
  /** The binary's name, for the sentences that name a command. */
  readonly binary: string;
}

const PathSchema = z.string().min(1);
const TextSchema = z.string().refine(text => new TextEncoder().encode(text).length <= FILE_MAX_BYTES, {
  message: `a configuration file is at most ${String(FILE_MAX_BYTES / 1024)} KiB`,
});

/** The body of `PUT /v1/config/file`: the etag may come in the body as well as `If-Match` (the shell sends no headers). */
const PutBodySchema = z.strictObject({ path: PathSchema, text: TextSchema, etag: z.string().min(1).optional() });
const ConfirmBodySchema = z.strictObject({ path: PathSchema, etag: z.string().min(1) });

type Resolved = ConfigTarget & { readonly path: string };

/** The four handlers, keyed as the kernel's manifest declares them. */
export function configRoutes(sources: ConfigRouteSources): Readonly<{
  'GET /v1/config/file': RouteHandler;
  'PUT /v1/config/file': RouteHandler;
  'DELETE /v1/config/file': RouteHandler;
  'POST /v1/config/confirm': RouteHandler;
}> {
  const resolve = (path: string): Resolved | undefined => {
    const declarations = sources.writer()?.declarations() as readonly ConfigDeclaration[] | undefined;
    const found = declarations === undefined ? undefined : targetOfPath(declarations, path);
    return found === undefined ? undefined : { ...found, path };
  };

  /** Gate's verdict for this call on this file. An absent judge, or one that throws, refuses. */
  const judge = (target: Resolved, act: ConfigAct): ConfigAccessVerdict => {
    try {
      const verdict = sources.admission()?.judgeConfigAccess?.({
        plugin: target.plugin,
        path: target.path,
        act,
        actor: currentActor(),
        standing: currentStanding(),
      });
      if (verdict !== undefined) return verdict;
    } catch {
      // fall through: nobody can say who may do this, so nobody does
    }
    return {
      allowed: false,
      response: errorResponse(
        403,
        `this daemon could not check what this caller may do with ${target.path}, so nothing was changed`,
        'forbidden',
      ),
    };
  };

  const missingWriter = (): never => {
    throw new ApiError(
      503,
      'this daemon has no configuration writer, so no file can be read or changed',
      'unavailable',
    );
  };
  const writerOrFail = (): ConfigFilesWriter => sources.writer() ?? missingWriter();

  const issuesOf = (
    issues: readonly {
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
      readonly message: string;
      readonly fix?: string;
    }[],
  ): readonly ConfigFileIssue[] =>
    issues.map(issue => ({
      path: issue.path,
      ...(issue.line === undefined ? {} : { line: issue.line }),
      ...(issue.column === undefined ? {} : { column: issue.column }),
      severity: 'error' as const,
      message: issue.message,
      fix: issue.fix ?? 'fix the problem and save again',
    }));

  const unresolved = (path: string, code: string): never => {
    throw new ApiError(400, `${NOT_A_FILE}: ${path}`, code);
  };

  return {
    'GET /v1/config/file': async call => {
      const path = PathSchema.safeParse(queryValue(call.request, 'path') ?? '');
      if (!path.success) throw new ApiError(400, 'no file named', 'bad_request');
      const target = resolve(path.data) ?? unresolved(path.data, 'bad_request');
      const verdict = judge(target, 'read');
      if (!verdict.allowed) return verdict.response;
      const read = await writerOrFail().read(target);
      if (read === undefined) return unresolved(path.data, 'bad_request');
      const state = read.status.state === 'invalid' ? 'invalid' : read.status.state === 'held' ? 'pending' : 'ok';
      const shown =
        read.text === undefined ? undefined : shownConfigText(target.def, read.path, read.text, sources.binary);
      return jsonResponse({
        path: read.path,
        absolutePath: `${sources.home}/config/${read.path}`,
        kind: target.plugin,
        schema: schemaFileName(target.def),
        exists: read.exists,
        // A file that is not there yet begins as its schema's modeline, so an editor offers the schema's help.
        text: shown?.kind === 'shown' ? shown.text : (read.text ?? `${schemaModeline(target.def, read.path)}\n`),
        etag: read.etag,
        state,
        issues: read.issues ?? [],
      });
    },

    'PUT /v1/config/file': async call => {
      const request = await parseBody(call.request, PutBodySchema, { maxBytes: FILE_MAX_BYTES * 2 });
      const target = resolve(request.path) ?? unresolved(request.path, 'invalid_request');
      const verdict = judge(target, 'write');
      if (!verdict.allowed) return verdict.response;
      const ifMatch = headerValue(call.request, IF_MATCH) ?? request.etag;
      const claim = verdict.claimLoosening;
      const outcome = await writerOrFail().write(target, request.text, {
        confirmedLoosening: verdict.mayLoosen === true,
        // A passkey proof is taken only by an edit that really loosens, atomically (one proof, one loosening).
        ...(claim === undefined ? {} : { judge: () => claim() }),
        ...(ifMatch === undefined ? {} : { ifMatch }),
      });
      switch (outcome.kind) {
        case 'written':
          return jsonResponse({ path: request.path, etag: outcome.etag, outcome: 'applied' });
        case 'held':
          return jsonResponse({
            path: request.path,
            etag: outcome.etag,
            outcome: 'pending',
            pending: { path: request.path, etag: outcome.etag, changes: [...outcome.sentences] },
          });
        case 'conflict':
          throw new ApiError(
            409,
            `${request.path} changed since it was read; read it again and redo the edit`,
            'config_conflict',
          );
        case 'refused': {
          if (outcome.reason === 'not_declared' || outcome.reason === 'bad_name')
            return unresolved(request.path, 'invalid_request');
          const issues = issuesOf(outcome.issues);
          // At most MAX_CONFIG_ISSUES are listed, and one more sentence counts the rest: the count said is every one.
          const count = countProblems(issues);
          return jsonResponse(
            {
              error: `the file does not check (${String(count)} ${count === 1 ? 'problem' : 'problems'}); nothing was written`,
              code: CONFIG_INVALID_CODE,
              issues,
            },
            422,
          );
        }
      }
    },

    /**
     * Removes one declared file (a collection item: one CLI `rm` verb). Bounded exactly as `PUT`: the path resolves only
     * to a declared file (`targetOfPath`), Gate admits the call per file with the act `write`, and the removal is the
     * writer's own `remove`, which judges it: a removal that loosens (a budget, a rule) is HELD unless Gate says this
     * call may put a loosening into effect, the file staying in effect. The etag it was read at is REQUIRED (`If-Match`,
     * or `?etag=` for a caller that sends no headers): a removal never lands on a file nobody looked at. No text is
     * returned. GAP(kernel): `ConfigFilesWriter.remove` takes no Gate claim, so a governed device's passkey proof is
     * never spent on a removal: its loosening removal is held, as an agent's is (it fails closed).
     */
    'DELETE /v1/config/file': async call => {
      const path = PathSchema.safeParse(queryValue(call.request, 'path') ?? '');
      if (!path.success) throw new ApiError(400, 'no file named', 'bad_request');
      const target = resolve(path.data) ?? unresolved(path.data, 'bad_request');
      const ifMatch = headerValue(call.request, IF_MATCH) ?? queryValue(call.request, 'etag');
      if (ifMatch === undefined || ifMatch === '')
        throw new ApiError(
          428,
          `removing ${path.data} needs the etag it was read at (If-Match), so a file nobody looked at is never removed`,
          'precondition_required',
        );
      const verdict = judge(target, 'write');
      if (!verdict.allowed) return verdict.response;
      const outcome = await writerOrFail().remove(target, { confirmedLoosening: verdict.mayLoosen === true, ifMatch });
      switch (outcome.kind) {
        case 'written':
          return jsonResponse({ path: path.data, etag: outcome.etag, outcome: 'removed' });
        case 'held':
          return jsonResponse({
            path: path.data,
            etag: outcome.etag,
            outcome: 'pending',
            pending: { path: path.data, etag: outcome.etag, changes: [...outcome.sentences] },
          });
        case 'conflict':
          throw new ApiError(
            409,
            `${path.data} changed since it was read; read it again and decide again whether to remove it`,
            'config_conflict',
          );
        case 'refused':
          if (outcome.reason === 'not_declared' || outcome.reason === 'bad_name')
            return unresolved(path.data, 'bad_request');
          return jsonResponse(
            {
              error: `${path.data} was not removed (${outcome.reason})`,
              code: CONFIG_INVALID_CODE,
              issues: issuesOf(outcome.issues),
            },
            422,
          );
      }
    },

    'POST /v1/config/confirm': async call => {
      const request = await parseBody(call.request, ConfirmBodySchema);
      const target = resolve(request.path) ?? unresolved(request.path, 'invalid_request');
      const verdict = judge(target, 'confirm');
      if (!verdict.allowed) return verdict.response;
      const writer = writerOrFail();
      // Named by its path AND the etag that was reviewed. The id carries that FULL etag and the writer matches it
      // against the disk inside its write queue, so an edit nobody saw is never put into effect.
      const held = writer.held().find(item => item.path === request.path && item.etag === request.etag);
      const confirmed = held !== undefined && (await writer.confirm(held.id));
      return jsonResponse({ path: request.path, confirmed });
    },
  };
}
