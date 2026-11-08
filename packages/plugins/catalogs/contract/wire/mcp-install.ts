import { z } from 'zod';
const SessionMcpEnvNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/u, 'use NAME=value, with an upper-case NAME');

const SessionMcpEnvSchema = z.record(SessionMcpEnvNameSchema, z.string().max(4096));

const HTTP_URL = /^https?:\/\/[^\s]+$/u;

const SessionMcpServerSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('command'),
    command: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64),
    env: SessionMcpEnvSchema,
  }),
  z.strictObject({
    transport: z.literal('url'),
    // A plain pattern rather than `z.url()`: that accepts `javascript:` and `data:` too.
    url: z.string().max(2048).regex(HTTP_URL, 'use an http:// or https:// address'),
    /** Login scope only: the server signs in through Ferretry's MCP OAuth (docs/mcp-oauth.md). */
    oauth: z.boolean(),
  }),
]);

export type SessionMcpServer = z.infer<typeof SessionMcpServerSchema>;
