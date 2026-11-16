/**
 * EVERY CALL THIS APP MAKES TO THE DAEMON, TIMED WHERE IT LEAVES THE HALF.
 *
 * Today the recorder wrapped the carrier's `fetch` in the composition root. In 5.0 a half reaches its daemon only
 * through the per-daemon client the shell hands it (§9.6), so the same recorder wraps that client: what is counted
 * is what this half actually sent, by route pattern.
 *
 * The caller is never slowed for it: the answer is handed back the moment it arrives. Sizes are the JSON the call
 * carried (the transport's own bytes are the shell's), counted without copying a large body.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { DaemonCallError } from '../../shell.ts';
import type { PerformanceRecorder, RequestOutcome } from './recorder.ts';
import { routePattern } from './route-pattern.ts';

/** UTF-8 length of a string, counted rather than encoded, so a large body is not copied to be measured. */
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      // A surrogate pair is one four-byte character.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

/** What a JSON value weighs on the wire; `undefined` and anything that cannot be serialised weigh nothing. */
export const jsonBytes = (value: unknown): number => {
  if (value === undefined || value === null) return 0;
  try {
    return utf8Length(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
};

const outcomeOf = (error: unknown): RequestOutcome => (error instanceof DaemonCallError ? error.status : 'failed');

/** `client`, with every call it makes recorded on `recorder` by route pattern. */
export const recordingClient = <Client extends Pick<PluginClient, 'call'>>(
  client: Client,
  recorder: PerformanceRecorder,
): Client =>
  ({
    ...client,
    call: async <Answer = unknown>(route: string, init?: Parameters<PluginClient['call']>[1]): Promise<Answer> => {
      const space = route.indexOf(' ');
      const pattern = routePattern(route.slice(0, space), route.slice(space + 1));
      const bytesOut = jsonBytes(init?.body);
      const at = recorder.clock.now();
      try {
        const answer = await client.call<Answer>(route, init);
        recorder.recordRequest({
          route: pattern,
          at,
          durationMs: recorder.clock.now() - at,
          outcome: 200,
          bytesIn: jsonBytes(answer),
          bytesOut,
        });
        return answer;
      } catch (error) {
        recorder.recordRequest({
          route: pattern,
          at,
          durationMs: recorder.clock.now() - at,
          outcome: outcomeOf(error),
          bytesIn: 0,
          bytesOut,
        });
        throw error;
      }
    },
  }) as Client;
