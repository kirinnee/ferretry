/**
 * What a tool is, as data (docs/mcp-connector.md "How the tools are built"): its name, who may call it, what it says to a
 * voice assistant and what it does through `FleetGateway`. The MCP adapter registers these with the SDK; nothing here knows
 * about HTTP or the SDK, so the whole behaviour is unit-tested with a fake delegate.
 */
import type { z } from 'zod';
import type { ConnectorScope } from '../../../../contract/index.ts';
import type { ConnectorToolName } from '../demands.ts';
import type { FleetGateway } from '../gateway.ts';

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: false;
}

/** What a tool says back: the sentence(s), and the session it touched (for the security log). */
export interface ToolOutput {
  readonly text: string;
  readonly isError?: true;
  readonly sessionId?: string;
}

export interface ToolEnvironment {
  readonly gateway: FleetGateway;
  readonly now: () => number;
  /** The redaction door, for a tool that must cut text AFTER it is clean (output tails). */
  readonly clean: (text: string) => Promise<string>;
}

export interface ConnectorToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: ConnectorToolName;
  readonly title: string;
  readonly description: string;
  readonly scope: ConnectorScope;
  readonly annotations: ToolAnnotations;
  readonly input: Shape;
  readonly run: (args: z.infer<z.ZodObject<Shape>>, env: ToolEnvironment) => Promise<ToolOutput>;
}

export const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
