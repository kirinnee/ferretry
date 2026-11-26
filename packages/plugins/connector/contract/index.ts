/**
 * @ferretry/plugin-connector/contract — the remote Claude connector's wire schemas, config, state, audit kinds and words
 * (docs/mcp-connector.md). The authorization server itself is `daemon/lib/oauth/`; nothing here decides.
 */
import type { Word } from '@ferretry/kernel/contract';
import { defineConfig, defineState } from '@ferretry/kernel/contract';
import { auditKind } from '@ferretry/core-gate/contract';
import { ConnectorConfigSchema, connectorLoosens } from './config.ts';
import { ConnectorCallLineSchema } from './calls.ts';
import { ConnectorStateFileSchema } from './state.ts';

export * from './calls.ts';
export * from './config.ts';
export * from './state.ts';
export * from './policy.ts';
export * from './wire.ts';

export const CONNECTOR = 'connector' as const;

export const CONNECTOR_WORDS: readonly Word[] = [
  { word: 'Claude connector', means: 'lets the Claude app reach your ferrets, once you approve it' },
  { word: 'match code', means: 'the short code that shows a sign-in request on screen is the one you started' },
];

// ─── config (§9.2, §7.2) ─────────────────────────────────────────────────────────────────────────────────────────

/** `config/connector.yaml`. Switching it on, a new redirect URI and a new address wait for the owner (S1). */
export const CONNECTOR_CONFIG = defineConfig({
  file: 'connector.yaml',
  schema: ConnectorConfigSchema,
  axis: 'configure',
  loosens: connectorLoosens,
});

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

/** `state/connector/connector.json`: clients, grants and token DIGESTS. Never a raw credential. `0600`. */
export const CONNECTOR_STATE = defineState({
  name: 'connector',
  path: 'connector.json',
  store: 'json',
  format: 1,
  schema: ConnectorStateFileSchema,
  mode: 0o600,
});

/** `state/connector/calls.jsonl`: one line per write-tool call, arguments redacted and cut. `0600`; at 1 MiB it moves to `calls.1.jsonl`. */
export const CONNECTOR_CALLS = defineState({
  name: 'calls',
  path: 'calls.jsonl',
  store: 'jsonl',
  format: 1,
  schema: ConnectorCallLineSchema,
  mode: 0o600,
});

/** The previous calls log: the live one is moved here whole when it passes 1 MiB, replacing the one before it. */
export const CONNECTOR_CALLS_ROTATED = defineState({
  name: 'calls-rotated',
  path: 'calls.1.jsonl',
  store: 'jsonl',
  format: 1,
  schema: ConnectorCallLineSchema,
  mode: 0o600,
});

// ─── audit kinds (Gate's log; docs/audit.md) ─────────────────────────────────────────────────────────────────────

/** Names and ids only: a client's chosen name, a grant id, a tool name. Never an address, a code or a token. */
export const CONNECTOR_AUDIT = {
  clientRegistered: auditKind('connector.client-registered'),
  grantApproved: auditKind('connector.grant-approved'),
  grantDenied: auditKind('connector.grant-denied'),
  grantRevoked: auditKind('connector.grant-revoked'),
  refreshReused: auditKind('connector.refresh-reused'),
  tool: auditKind('connector.tool'),
} as const;
