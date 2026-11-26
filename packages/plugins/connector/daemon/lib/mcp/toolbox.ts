/**
 * Running a tool: everything around a tool body that is the same for all of them — the operator's grants, the token's
 * scope, redaction of what goes out, and the record of what a write did. The order is deliberate: nothing touches the
 * daemon before both gates have passed, and nothing leaves before it has been cleaned.
 */
import { z } from 'zod';
import { daemonGrantRefusal } from './demands.ts';
import { clip } from './format.ts';
import { type FleetGateway, ToolFailure } from './gateway.ts';
import type { ConnectorAccess, ConnectorAuditSink } from '../ports.ts';
import type { ConnectorCallsLog, ConnectorToolOutcome, DaemonGrantsSource } from './ports.ts';
import { redactHostTokenShapes, type ConnectorTextGuard } from './redaction.ts';
import type { ConnectorToolSpec, ToolEnvironment, ToolOutput } from './tools/spec.ts';

const LOG_ARG_CUT = 500;

export interface ToolboxOptions {
  readonly daemonGrants: DaemonGrantsSource;
  readonly guard: ConnectorTextGuard;
  readonly callsLog: ConnectorCallsLog;
  readonly audit: ConnectorAuditSink;
  readonly now: () => number;
}

/** What the SDK adapter gets back for one call. */
export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * everything around a tool body that is the same for all of them: the operator's grants, the token's scope,
 * redaction of what goes out, and the record of what a write did. The order is deliberate — nothing touches the
 * daemon before both gates have passed, and nothing leaves before it has been cleaned.
 */
export class ConnectorToolbox {
  constructor(private readonly options: ToolboxOptions) {}

  async execute(
    spec: ConnectorToolSpec,
    rawArgs: unknown,
    access: ConnectorAccess,
    gateway: FleetGateway,
  ): Promise<ToolResult> {
    const write = spec.scope === 'fleet:write';
    // `gated`: refused BEFORE the tool ran (scope, the operator's grants). The calls log keeps those; the security
    // log does not, because nothing was attempted. Every outcome of a tool that DID run is in both, as it ended.
    const finish = async (output: ToolOutput, outcome: ConnectorToolOutcome, gated = false): Promise<ToolResult> => {
      const text = await this.options.guard.clean(output.text);
      if (write) await this.record(spec, rawArgs, access, outcome, output.sessionId, gated);
      return { text, isError: outcome !== 'ok' };
    };
    if (!access.scopes.includes(spec.scope)) {
      return await finish(
        {
          text: 'This connection can only look, not change anything. It was approved for read access only.',
          isError: true,
        },
        'refused',
        true,
      );
    }
    let grants: ReturnType<DaemonGrantsSource>;
    try {
      grants = this.options.daemonGrants();
    } catch {
      grants = undefined;
    }
    const refusal = daemonGrantRefusal(spec.name, grants);
    if (refusal !== undefined) return await finish({ text: refusal, isError: true }, 'refused', true);
    gateway.clean = async text => await this.options.guard.clean(text);
    try {
      const args = z.object(spec.input as z.ZodRawShape).parse(rawArgs ?? {});
      const output = await (spec.run as (a: unknown, e: ToolEnvironment) => Promise<ToolOutput>)(args, {
        gateway,
        now: this.options.now,
        clean: async text => await this.options.guard.clean(text),
      });
      return await finish(output, 'ok');
    } catch (error) {
      if (error instanceof ToolFailure)
        return await finish(
          {
            text: error.message,
            isError: true,
            ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
          },
          error.refused ? 'refused' : 'error',
        );
      return await finish(
        { text: 'Something went wrong on the machine, so I did not do that.', isError: true },
        'error',
      );
    }
  }

  private async record(
    spec: ConnectorToolSpec,
    rawArgs: unknown,
    access: ConnectorAccess,
    outcome: ConnectorToolOutcome,
    sessionId: string | undefined,
    gated: boolean,
  ): Promise<void> {
    try {
      // What the caller typed is also masked by the shape of the host's own tokens, which this plugin never holds.
      const args = cutLongStrings(await this.options.guard.cleanData(maskHostTokenShapes(declaredOnly(spec, rawArgs))));
      await this.options.callsLog.append({
        at: new Date(this.options.now()).toISOString(),
        tool: spec.name,
        grantId: access.grantId,
        tokenId: access.tokenId,
        args: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
        outcome,
      });
    } catch {
      // The security log below still has the call; a calls-log failure must not fail the tool.
    }
    if (gated) return;
    try {
      await this.options.audit.record({
        kind: 'connector.tool',
        grantId: access.grantId,
        tool: spec.name,
        ...(sessionId === undefined ? {} : { sessionId }),
        outcome,
      });
    } catch {
      // The sink never throws into a request by contract; belt and braces.
    }
  }
}

/** Only the arguments the tool declares: a caller-chosen property name is never written to the log. */
function declaredOnly(spec: ConnectorToolSpec, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const declared = new Set(Object.keys(spec.input));
  // Scalars only, so a call that was refused before its arguments were validated (a nested object, a huge array) can neither
  // smuggle caller-chosen key names into the log nor make one line large enough to rotate away the others.
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) => declared.has(key) && ['string', 'number', 'boolean'].includes(typeof entry),
    ),
  );
}

function maskHostTokenShapes(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, entry]) => [key, typeof entry === 'string' ? redactHostTokenShapes(entry) : entry]),
  );
}

/** Message/answer/task text is cut to 500 characters in the calls log: the log says WHAT was done, not the whole text. */
function cutLongStrings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? clip(entry, LOG_ARG_CUT) : entry]),
  );
}
