import type { PluginCallHeaders } from './implement.ts';

/** The one header a half sets to make a retried act the same act (`PluginCallHeaders['x-fy-request-id']`). */
const REQUEST_ID_HEADER = 'x-fy-request-id';
/** The agenda channel header and the one value it may carry (the Asks contract's `AGENDA_CHANNEL_HEADER` / `AGENDA_CHANNEL_VERSION`). */
const AGENDA_CHANNEL_HEADER = 'x-fy-agenda-channel';
const AGENDA_CHANNEL_VERSIONS: ReadonlySet<string> = new Set(['2']);
/** The one range a half may ask for: `bytes=<first>-<last>`, two whole numbers (a media file is read in pieces). */
const RANGE_HEADER = 'range';
const RANGE_SHAPE = /^bytes=\d{1,12}-\d{1,12}$/u;

/**
 * The CLOSED list of headers a half may set (`PluginCallHeaders`), owned here so every shell (the app's and the CLI's)
 * forwards exactly the same thing: `x-fy-request-id`, `x-fy-agenda-channel` with today's value, and a `range` of the shape above. Any other key a half
 * passes is dropped, and so is a channel value outside the list; nothing else (credentials, the contract hash) is ever
 * a half's to send. `undefined` when nothing survives, so a call with none sends none.
 */
export function allowedCallHeaders(given: PluginCallHeaders | undefined): Record<string, string> | undefined {
  if (given === undefined) return undefined;
  const sent: Record<string, string> = {};
  const requestId = given[REQUEST_ID_HEADER];
  if (typeof requestId === 'string' && requestId !== '') sent[REQUEST_ID_HEADER] = requestId;
  const channel = given[AGENDA_CHANNEL_HEADER];
  if (channel !== undefined && AGENDA_CHANNEL_VERSIONS.has(channel)) sent[AGENDA_CHANNEL_HEADER] = channel;
  const range = given[RANGE_HEADER];
  if (typeof range === 'string' && RANGE_SHAPE.test(range)) sent[RANGE_HEADER] = range;
  return Object.keys(sent).length === 0 ? undefined : sent;
}
