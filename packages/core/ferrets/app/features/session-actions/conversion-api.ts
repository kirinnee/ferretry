/**
 * The two daemon calls behind "Move to Codex… / Move to Claude…": the read that says what a conversion
 * would carry, and the move itself. Each takes what it needs as a parameter so a test hands in a fake.
 *
 * The preview is a read — no request id, nothing written — and is PARSED through the shared schema, so
 * a body this page cannot read is a failed read rather than a claim about the conversation.
 */
import {
  type ConversionPreview,
  ConversionPreviewRequestSchema,
  ConversionPreviewSchema,
  type IFyApiClient,
  type SessionView,
} from '@ferretry/protocol';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from '../../lib/runtime-models.ts';

/** Asks the daemon that owns the session what moving it onto `agent` would carry, or why it cannot. */
export const readConversionPreview = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch,
  agent: string,
  signal?: AbortSignal,
): Promise<ConversionPreview> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('the connection does not own this session scope');
  const target = daemonRequest(daemon, `/v1/sessions/${encodeURIComponent(scope.sessionId)}/conversion-preview`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ConversionPreviewRequestSchema.parse({ agent })),
    ...(signal === undefined ? {} : { signal }),
  });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const message = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new DaemonResponseError(response.status, message, typeof body.code === 'string' ? body.code : undefined);
  }
  const parsed = ConversionPreviewSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new DaemonResponseError(502, 'the daemon answered with a body this page cannot read');
  return parsed.data;
};

/**
 * Moves the ferret onto `agent`, converting its conversation into that harness's own format. The daemon
 * runs the target CLI once to prove it opens the converted file, so this can take a little while.
 * Nothing changes when it throws. `forceInflight` is only ever set after the person confirmed it.
 */
export const moveToOtherHarness = async (
  client: Pick<IFyApiClient, 'migrate'>,
  view: SessionView,
  agent: string,
  requestId: string,
  forceInflight: boolean,
): Promise<SessionView> =>
  await client.migrate(view.config.id, agent, undefined, false, requestId, forceInflight ? true : undefined, 'convert');
