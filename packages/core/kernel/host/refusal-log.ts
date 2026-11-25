import type { ApiRequest, ApiResponse } from '../contract/http.ts';
import type { Log, LogFields } from '../contract/ports.ts';

/**
 * WHAT THE DAEMON SAYS ABOUT A CALL IT REFUSED.
 *
 * A caller refused at admission used to be told (`401`, `403`, `503`) and the daemon's own log said nothing, so an
 * owner whose device was refused had the app's "could not be read" and a silent log: nobody could say WHICH check
 * said no. Every refusal is now one `warn` line naming the route (its declared template, never the caller's path),
 * the status, the machine code and the sentence the caller was given, and WHO it was refused as: the proved device's
 * id (an id, not a name) or the kind of credential that was presented. It carries no token, no digest, no body and no
 * query: the sentence is the one the caller already received.
 */

/** One call the dispatcher refused, as it hands it over. */
export interface RefusalNote {
  readonly table: 'route' | 'socket' | 'tool' | 'member';
  readonly method: string;
  /** The declared template (`/v1/pair/devices/:deviceId`), or `undefined` for a path no route claims. */
  readonly route: string | undefined;
  readonly request: ApiRequest;
  readonly response: ApiResponse;
}

/** The longest sentence kept: a reason to read, not a body. */
const REASON_MAX = 240;

/**
 * The sentence with the caller's own path swapped for the route's declared template. An admission sentence may embed
 * `METHOD /the/raw/path` (the caller already has it), but the LOG names the route, never the path: the same pattern
 * must give the same line (so the dedupe holds) and no path a caller made up may reach the file. Total.
 */
function withoutCallerPath(reason: string, request: ApiRequest, route: string | undefined): string {
  const path = request.path;
  if (path.length <= 1) return reason;
  const template = route ?? '(no route)';
  return reason.split(`${request.method} ${path}`).join(`${request.method} ${template}`).split(path).join(template);
}

/** `{ error, code }` out of a refusal's JSON body, when it has that shape; anything else is no reason. Total. */
function readReason(response: ApiResponse): { readonly reason?: string; readonly code?: string } {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) return {};
  try {
    const parsed: unknown = JSON.parse(response.body);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { error, code } = parsed as { readonly error?: unknown; readonly code?: unknown };
    return {
      ...(typeof error === 'string' ? { reason: error.replace(/\s+/gu, ' ').trim().slice(0, REASON_MAX) } : {}),
      ...(typeof code === 'string' ? { code: code.slice(0, 64) } : {}),
    };
  } catch {
    return {};
  }
}

/** Who was refused, as a phrase that holds no credential: a proved holder's id, else what kind of bearer arrived. */
function whoOf(request: ApiRequest): string {
  if (request.arrival.kind === 'delegated') return 'connector';
  const principal = request.principal;
  if (principal !== undefined) return `${principal.kind} ${principal.holder}`;
  return request.headers.has('authorization') ? 'a bearer that matched no credential' : 'a caller with no credential';
}

function arrivalOf(request: ApiRequest): string {
  if (request.arrival.kind === 'delegated') return 'delegated:connector';
  return request.arrival.kind === 'carried' ? `carried:${request.arrival.carrier}` : request.arrival.kind;
}

/** The `warn` line and fields for one refusal. Pure and total. */
export function describeRefusal(note: RefusalNote): { readonly message: string; readonly fields: LogFields } {
  const read = readReason(note.response);
  const code = read.code;
  const reason = read.reason === undefined ? undefined : withoutCallerPath(read.reason, note.request, note.route);
  const where = `${note.method} ${note.route ?? '(no route)'}`;
  const status = `${note.response.status}${code === undefined ? '' : ` ${code}`}`;
  return {
    message: `refused ${where} (${status})${reason === undefined ? '' : `: ${reason}`}`,
    fields: {
      table: note.table,
      who: whoOf(note.request),
      arrival: arrivalOf(note.request),
      status: note.response.status,
      code,
    },
  };
}

/** The same identical refusal is said once a minute: a page that retries must not fill the log. */
export const REFUSAL_WINDOW_MS = 60_000;
/** The most distinct refusals remembered; past it the memory starts over (a flood of strangers cannot grow it). */
const REFUSAL_KEYS_MAX = 512;

/**
 * One line said at most once per `windowMs` per key, at `level`: the first occurrence at once, and the next one after
 * the window carrying how many were held back (`suppressed`). The caller picks the key, so a line whose text varies
 * (an error's message) can still be one identity. The memory is bounded: past {@link REFUSAL_KEYS_MAX} keys it starts
 * over, and the repeats it held are still counted in one line, so none goes uncounted.
 */
export function onceEach(
  log: Log,
  level: 'warn' | 'error',
  nowMs: () => number,
  windowMs: number = REFUSAL_WINDOW_MS,
): (key: string, message: string, fields?: LogFields) => void {
  const seen = new Map<string, { at: number; held: number }>();
  return (key, message, fields) => {
    const now = nowMs();
    const prior = seen.get(key);
    if (prior !== undefined && now - prior.at < windowMs) {
      prior.held += 1;
      return;
    }
    if (prior === undefined && seen.size >= REFUSAL_KEYS_MAX) {
      let lost = 0;
      for (const entry of seen.values()) lost += entry.held;
      seen.clear();
      if (lost > 0) log[level](`${level === 'warn' ? 'refusal' : 'failure'} memory was reset`, { suppressed: lost });
    }
    const held = prior?.held ?? 0;
    seen.set(key, { at: now, held: 0 });
    log[level](message, held === 0 ? fields : { ...fields, suppressed: held });
  };
}

/**
 * `log` with its `warn` said once per identical line per {@link REFUSAL_WINDOW_MS}. Every other level passes through.
 * The line and its fields ARE the identity, so two devices refused for the same reason are two lines.
 */
export function dedupedWarnings(log: Log, nowMs: () => number, windowMs: number = REFUSAL_WINDOW_MS): Log {
  const once = onceEach(log, 'warn', nowMs, windowMs);
  const warn = (message: string, fields?: LogFields): void =>
    once(`${message}\u0000${fields === undefined ? '' : JSON.stringify(Object.entries(fields))}`, message, fields);
  return {
    debug: (message, fields) => log.debug(message, fields),
    info: (message, fields) => log.info(message, fields),
    warn,
    error: (message, fields) => log.error(message, fields),
    child: scope => dedupedWarnings(log.child(scope), nowMs, windowMs),
  };
}
