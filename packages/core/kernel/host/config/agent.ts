/**
 * The agent's door to the configuration files (docs/config-files.md): `config_read`, `config_validate`, `config_write`
 * and the route `POST /v1/agent/config` that carries the same three calls. Today's `agentCall` / `agentTool`, onto the
 * kernel's config writer.
 *
 * - WHO is calling comes from the standing admission put on the call (the session credential names the ferret); no body
 *   field names one, and a caller that is not a ferret is refused.
 * - The owner's "What agents may control › Ferretry settings" switch is asked of the Ferrets-provided
 *   {@link AgentControlReader}; unbound, throwing, or off, the call is refused `403 agent_control_off`: it fails CLOSED.
 * - A write passes `confirmedLoosening: false`, no judge and `byAgent`: an edit that loosens is written and HELD for the
 *   owner, the tighter version in effect, and so is one that adds a `${secret:NAME}` reference (NN2: an agent is no more
 *   trusted than a plugin's own write). There is no confirm and no discard here: an agent never confirms its own edit.
 * - The files the door NAMES are today's reach and no more (`agent-reach.ts`): a person-only file (`gate.yaml`,
 *   `plugins.yaml`) or anything outside the list is refused on read, validate AND write, with today's words.
 * - A raw secret is refused by the writer like a file that does not parse, and no issue repeats the value; one in a
 *   YAML comment or tag counts (the check scans the raw text too). A read never returns the text of a file that holds
 *   one, parsed or not.
 */
import type { AgentConfigAnswer, AgentConfigCall } from '../../contract/agent-config.ts';
import { type AgentControlReader, agentControlRefusal } from '../../contract/bound.ts';
import { ApiError, type ApiResponse, errorResponse } from '../../contract/http.ts';
import type { FerretId } from '../../contract/ids.ts';
import type { ConfigFileIssue, ConfigFilesWriter, ConfigTarget } from '../../contract/ports.ts';
import { AGENT_REACH_WORDS, agentMayName } from './agent-reach.ts';
import { checkConfigText, countProblems, MAX_CONFIG_ISSUES, moreIssues } from './check.ts';
import { type ConfigDeclaration, targetOfPath } from './claims.ts';
import { rawTextHoldsSecret } from './secrets.ts';
import { schemaFileName, schemaModeline } from './schemas.ts';
import { configTextTooLarge } from './yaml-text.ts';
import type { ConfigStatus } from './service.ts';

/** What the agent's door reads. */
export interface AgentConfigSources {
  /** The writer over every declared file; absent: no config call can act. */
  writer(): ConfigFilesWriter | undefined;
  /** Ferrets' reader of the owner's switches, read live. Absent (unbound or failed): every call is refused. */
  control(): AgentControlReader | undefined;
  /** What every declared file stands at; absent: none can be listed. */
  status(): ConfigStatus | undefined;
  /** The home, absolute: the config directory is `<home>/config`. */
  readonly home: string;
  /** The binary's name, for the sentences that name a command. */
  readonly binary: string;
  /** An instant as an ISO string. */
  now(): string;
}

const NOT_A_FILE =
  'not a Ferretry configuration file — name a file a plugin declares under config/ (fy config check lists them)';

const SESSION_CREDENTIAL_WORDS =
  'the config tools need the session credential Ferretry gives each agent session; run this from inside an agent session';

/**
 * Gate's refusal of a call to `POST /v1/agent/config`, in today's words where today's differed (round-2 m-c). Today's
 * door answered a call with NO credential `401 missing_capability` and the session-credential sentence; Gate answers
 * that `401 unauthorized`. Same status, same order: only the code and the words are today's again. Every other refusal
 * (a session mismatch, an unknown credential's 403, a carrier that is not privileged) is Gate's, unchanged.
 */
export function agentDoorRefusal(response: ApiResponse): ApiResponse {
  if (response.status !== 401) return response;
  let code: unknown;
  try {
    code = (JSON.parse(response.body) as { readonly code?: unknown } | null)?.code;
  } catch {
    return response;
  }
  return code === 'unauthorized' ? errorResponse(401, SESSION_CREDENTIAL_WORDS, 'missing_capability') : response;
}

/**
 * The ferret a call's standing names, or `undefined`. Read structurally because the kernel is a leaf: Gate's
 * `credential` is on the standing, and only a ferret's own token class names a ferret (the admin token with an actor
 * header does not: today's door took the session credential alone).
 */
export function ferretOfStanding(standing: object | undefined): FerretId | undefined {
  const credential = (
    standing as { readonly credential?: { readonly tokenClass?: unknown; readonly ferret?: unknown } }
  )?.credential;
  if (credential?.tokenClass !== 'ferret') return undefined;
  return typeof credential.ferret === 'string' && credential.ferret !== ''
    ? (credential.ferret as FerretId)
    : undefined;
}

const issuesOf = (issues: readonly ConfigFileIssue[]): NonNullable<AgentConfigAnswer['issues']> =>
  issues.map(issue => ({ ...issue }));

const plural = (count: number): string => `${String(count)} ${count === 1 ? 'problem' : 'problems'}`;

export interface AgentConfig {
  /** Refuses (throws) unless this call's ferret may use the config tools right now; answers the ferret. */
  authorize(standing: object | undefined): Promise<FerretId>;
  /** One call of a ferret already authorized. Refusals of the FILE are answers. */
  act(call: AgentConfigCall): Promise<AgentConfigAnswer>;
  /** {@link AgentConfig.authorize}, then {@link AgentConfig.act}: refusals of the CALLER are errors, of the FILE answers. */
  run(call: AgentConfigCall, standing: object | undefined): Promise<AgentConfigAnswer>;
}

export function agentConfig(sources: AgentConfigSources): AgentConfig {
  const writerOrFail = (): ConfigFilesWriter => {
    const writer = sources.writer();
    if (writer === undefined)
      throw new ApiError(
        503,
        'this daemon has no configuration writer, so no file can be read or changed',
        'unavailable',
      );
    return writer;
  };

  const resolve = (path: string): (ConfigTarget & { readonly path: string }) | undefined => {
    const declarations = sources.writer()?.declarations() as readonly ConfigDeclaration[] | undefined;
    const found = declarations === undefined ? undefined : targetOfPath(declarations, path);
    return found === undefined ? undefined : { ...found, path };
  };
  /** Whether this agent may name `path` at all: today's reach, and never a person-only file. */
  const reachable = (path: string): boolean => agentMayName(path) && resolve(path)?.def.personOnly !== true;
  const target = (path: string): ConfigTarget & { readonly path: string } => {
    // Today's refusal for a path outside the reach: the body schema's `400 invalid_request`, in today's words.
    if (!reachable(path))
      throw new ApiError(400, `the request body is invalid — path: ${AGENT_REACH_WORDS}`, 'invalid_request');
    return (
      resolve(path) ??
      ((): never => {
        throw new ApiError(400, `${NOT_A_FILE}: ${path}`, 'bad_request');
      })()
    );
  };

  const authorize: AgentConfig['authorize'] = async standing => {
    const ferret = ferretOfStanding(standing);
    if (ferret === undefined) throw new ApiError(403, SESSION_CREDENTIAL_WORDS, 'forbidden');
    let allowed = false;
    try {
      allowed = (await sources.control()?.allows(ferret, 'settings')) === true;
    } catch {
      // Nobody can say what the owner allows, so nothing is allowed.
    }
    if (!allowed) throw new ApiError(403, agentControlRefusal('settings'), 'agent_control_off');
    return ferret;
  };

  const listing = (): AgentConfigAnswer => {
    // Only the files this agent may name: the listing never shows a file the calls would refuse.
    const view = configStatusView(sources);
    const files = view.files.filter(file => reachable(file.path));
    const issues = view.issues.filter(issue => reachable(issue.path));
    const pending = view.pending.filter(held => reachable(held.path));
    const errors = countProblems(issues.filter(issue => issue.severity === 'error'));
    // Each file's problems are capped by its check; many files' together are capped here, the rest counted (a file's
    // own counting sentence among them) at the path of the first one left out, where `config_read` with it lists them.
    const left = issues.slice(MAX_CONFIG_ISSUES);
    const shown =
      left.length === 0
        ? issues
        : [...issues.slice(0, MAX_CONFIG_ISSUES), moreIssues(left[0]?.path ?? '', countProblems(left))];
    return {
      summary: `${String(files.length)} configuration files in ${view.directory}; ${String(errors)} with errors; ${String(pending.length)} waiting for the owner's confirmation.`,
      files,
      issues: shown,
    };
  };

  const read = async (path: string): Promise<AgentConfigAnswer> => {
    const found = target(path);
    const file = await writerOrFail().read(found);
    if (file === undefined) throw new ApiError(400, `${NOT_A_FILE}: ${path}`, 'bad_request');
    const state = file.status.state === 'invalid' ? 'invalid' : file.status.state === 'held' ? 'pending' : 'ok';
    // A text over the cap is neither checked nor scanned nor shown: nothing could vouch that it holds no secret.
    const tooLarge = file.text !== undefined && configTextTooLarge(file.text);
    // A file somebody hand-wrote a raw secret into is shown by its located issue, never by its text.
    const checked =
      file.text === undefined || tooLarge ? undefined : checkConfigText(found.def, path, file.text, sources.binary);
    // A file that does not even parse was never scanned by the check, so its raw text is: a key pasted mid-edit counts.
    const holdsSecret =
      checked !== undefined &&
      !checked.ok &&
      (checked.reason === 'raw_secret' || (checked.reason === 'yaml' && rawTextHoldsSecret(file.text ?? '')));
    const withheld = holdsSecret
      ? '; its text is not shown because it holds a raw secret, which the owner must move into the secret store'
      : tooLarge
        ? '; its text is not shown because it is larger than a configuration file may be'
        : '';
    return {
      summary: file.exists
        ? `${file.path} (${state})${withheld}.`
        : `${file.path} does not exist yet; this is the starter a new one begins with.`,
      text: holdsSecret || tooLarge ? '' : (file.text ?? `${schemaModeline(found.def, file.path)}\n`),
      etag: file.etag,
      issues: issuesOf(file.issues ?? []),
    };
  };

  const validate = (path: string, text: string): AgentConfigAnswer => {
    const found = target(path);
    const checked = checkConfigText(found.def, path, text, sources.binary);
    if (checked.ok) return { summary: `${path} checks.`, issues: [] };
    // The issues list at most MAX_CONFIG_ISSUES and one sentence counting the rest: the count said is every one.
    const errors = countProblems(checked.issues.filter(issue => issue.severity === 'error'));
    return {
      summary: `${path} does not check: ${plural(errors)}. Fix each and validate again.`,
      issues: issuesOf(checked.issues),
    };
  };

  const write = async (path: string, text: string, etag: string | undefined): Promise<AgentConfigAnswer> => {
    const found = target(path);
    const outcome = await writerOrFail().write(found, text, {
      // The agent never confirms: a loosening is written and HELD for the owner, and no judge is asked to claim a proof.
      // `byAgent`: a `${secret:NAME}` it adds is held too, and nothing can confirm that (NN2).
      confirmedLoosening: false,
      byAgent: true,
      ...(etag === undefined ? {} : { ifMatch: etag }),
    });
    switch (outcome.kind) {
      case 'written':
        return { summary: `Wrote ${path}; it is in effect.`, etag: outcome.etag };
      case 'held':
        return {
          summary: `Wrote ${path}, but it loosens what this machine allows (${outcome.sentences.join('; ')}), so it waits for the owner to confirm it; the earlier version stays in effect until then. Tell the owner with a card whose Allow confirms it: ${sources.binary} agenda add "<the ask>" --title "<title>" --context "<the facts around it>" --confirms ${path}.`,
          etag: outcome.etag,
        };
      case 'conflict':
        return { summary: `Nothing was written: ${path} changed since it was read; read it again and redo the edit.` };
      case 'refused': {
        if (outcome.reason === 'not_declared' || outcome.reason === 'bad_name')
          throw new ApiError(400, `${NOT_A_FILE}: ${path}`, 'bad_request');
        return {
          summary: `Nothing was written: ${path} does not check. Fix each issue and try again.`,
          issues: outcome.issues.map(issue => ({
            path: issue.path,
            ...(issue.line === undefined ? {} : { line: issue.line }),
            ...(issue.column === undefined ? {} : { column: issue.column }),
            severity: 'error' as const,
            message: issue.message,
            fix: issue.fix ?? 'fix the problem and save again',
          })),
        };
      }
    }
  };

  const act: AgentConfig['act'] = async call => {
    switch (call.tool) {
      case 'config.read':
        return call.path === undefined ? listing() : await read(call.path);
      case 'config.validate':
        return validate(call.path, call.text);
      case 'config.write':
        return await write(call.path, call.text, call.etag);
    }
  };

  return {
    authorize,
    act,
    run: async (call, standing) => {
      await authorize(standing);
      return await act(call);
    },
  };
}

/** `GET /v1/config/status`: what is in effect and what is wrong, for every declared file (today's `ConfigStatusView`). */
export function configStatusView(sources: AgentConfigSources): {
  readonly directory: string;
  readonly files: NonNullable<AgentConfigAnswer['files']>;
  readonly issues: NonNullable<AgentConfigAnswer['issues']>;
  readonly pending: readonly { readonly path: string; readonly etag: string; readonly changes: readonly string[] }[];
  readonly checkedAt: string;
} {
  const status = sources.status();
  if (status === undefined)
    throw new ApiError(503, 'this daemon cannot list the configuration files right now', 'unavailable');
  const declarations = sources.writer()?.declarations() as readonly ConfigDeclaration[] | undefined;
  const files = status.files.flatMap(file => {
    const found = declarations === undefined ? undefined : targetOfPath(declarations, file.path);
    return found === undefined || file.state === 'absent'
      ? []
      : [{ path: file.path, kind: file.plugin, schema: schemaFileName(found.def), state: file.state }];
  });
  return {
    directory: `${sources.home}/config`,
    files,
    issues: issuesOf(status.issues),
    pending: status.held.map(held => ({ path: held.path, etag: held.etag, changes: held.sentences })),
    checkedAt: sources.now(),
  };
}
