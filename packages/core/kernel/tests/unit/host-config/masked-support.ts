import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';

/**
 * Shared by the cfg-leak tests (CFG-LEAK-R, CFG-LEAK-W): a collection shaped like an MCP server's, which carries the
 * three places a value a person wrote into a flag can sit — a list of arguments, a url, an environment — plus a free
 * `note`. It sits under `mcp/`, a folder an agent may name. Fake only: every value below is shaped like a credential and
 * is none.
 */

/** A 16-character value of 16 distinct characters: past every length and entropy gate a rule has, and no known shape. */
export const VALUE = 'Zk3pQ9vXw2LmN7rT';
/** A second one, so a test can tell "the same value" from "another value". */
export const OTHER_VALUE = 'Hy8cBt4Fg6SdJ1uE';
/** A 10-character password: past the mask's 8, under the write rule's 16. */
export const SHORT_PASSWORD = 'hunter2024';

export const HIDDEN = '‹hidden›';

export const mcpDef = defineConfig({
  collection: 'mcp',
  name: /^[a-z0-9-]{1,40}$/,
  schema: z.strictObject({
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().optional(),
    note: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    limit: z.number().int().default(10),
  }),
  axis: 'configure',
  loosens: (before, after) =>
    after.limit > (before?.limit ?? 10) ? [`raises the limit from ${before?.limit ?? 10} to ${after.limit}`] : [],
});

/** The same def, as the one-file def the pure mask is asked about. */
export const fileDef = defineConfig({
  file: 'servers.yaml',
  schema: z.strictObject({
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().optional(),
    note: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    limit: z.number().int().default(10),
  }),
  axis: 'configure',
  loosens: () => [],
});

/** A file that takes anything, so the cutter meets every shape of value. */
export const openDef = defineConfig({
  file: 'open.yaml',
  schema: z.looseObject({}),
  axis: 'configure',
  loosens: () => [],
});

/** A file whose top-level value is anything, a list included: nothing in it can be re-set by key. */
export const anyDef = defineConfig({
  file: 'any.yaml',
  schema: z.unknown(),
  axis: 'configure',
  loosens: () => [],
});

/** A def of credential records: its text is withheld whenever it fails its check, whatever the reason. */
export const recordsDef = defineConfig({
  file: 'records.yaml',
  schema: z.strictObject({ name: z.string() }),
  axis: 'configure',
  credentialRecords: true,
  loosens: () => [],
});

/**
 * Names the write rule (W, `findFlagSecrets`) reads as a credential by the TAIL of the name (dashes stripped): the class
 * the read mask must cut as well (CFG-LEAK-R). The first eight were shown raw before the mask took W's name test.
 */
export const TAIL_NAMES = [
  'key',
  'keys',
  'tokens',
  'secrets',
  'passwords',
  'passwds',
  'apitoken',
  'authtoken',
  'sessiontoken',
  'clientsecret',
  'ssh-key',
  'signing-key',
  'encryption-key',
  'license-key',
  'master-key',
  'credentials',
  'credential',
];

/** The three forms a flag takes with a value: after a space, glued by `=`, and `-e NAME=v`. */
export const flagForms = (name: string, value: string): readonly (readonly string[])[] => [
  [`--${name}`, value],
  [`--${name}=${value}`],
  ['-e', `${name.toUpperCase().replaceAll('-', '_')}=${value}`],
];

/** A word that glues raw text to a `${secret:NAME}` pointer: the raw part is a credential written next to a pointer. */
export const GLUED_POINTER_LINES: readonly (readonly string[])[] = [
  ['-e', 'API_KEY=prefix${secret:X}'],
  ['--token', 'prefix${secret:X}'],
  ['-e', 'API_KEY=${secret:X}?model=short'],
  ['--header=Authorization: Bearer v${secret:X}'],
];
