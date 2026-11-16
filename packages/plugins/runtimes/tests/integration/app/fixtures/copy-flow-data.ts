/**
 * The fake data behind the copy-flow scenes: ONE made-up source machine and what this machine's review says about it.
 * Every name, command and script below is invented; nothing here is, or reads like, a real credential.
 */
import { InstantSchema } from '@ferretry/std';
import type { CloneReview } from '../../../../contract/index.ts';

export const BUNDLE = {
  format: 'ferretry-clone',
  version: 1,
  machine: 'work-mac',
  daemon: 'fy_daemon_source',
  exportedAt: '2026-11-14T09:00:00.000Z',
  credentials: [],
  components: {},
  profiles: {},
  runtimes: { 'claude-work': { agent: true }, 'codex-work': { agent: true }, 'plain-shell': { agent: false } },
  files: [],
  notCopied: [],
  keys: {},
};

const GUARD = {
  ref: 'hooks/guard',
  kind: 'hooks' as const,
  outcome: 'new' as const,
  match: 'none' as const,
  choice: 'add' as const,
  files: [],
  runnable: {
    reference: 'hooks/guard',
    kind: 'hooks' as const,
    name: 'guard',
    entries: [
      { label: 'Runs before every tool call', text: 'bash ./guard.sh', document: false },
      {
        label: 'Document hooks/guard.sh',
        text: '#!/bin/bash\n# fixture script: prints a line and exits\necho "guard ran for $1"\nexit 0\n',
        document: true,
      },
    ],
  },
};

const NOTES = {
  ref: 'mcp/notes',
  kind: 'mcp' as const,
  outcome: 'new' as const,
  match: 'none' as const,
  choice: 'add' as const,
  files: [],
  runnable: {
    reference: 'mcp/notes',
    kind: 'mcp' as const,
    name: 'notes',
    entries: [
      { label: 'Starts', text: 'node ./notes-server.js --port 4100', document: false },
      { label: 'Variable NOTES_KEY', text: '${secret:NOTES_KEY}', document: false },
    ],
  },
};

const PROFILE = {
  ref: 'profile/dev',
  kind: 'profile' as const,
  outcome: 'new' as const,
  match: 'none' as const,
  choice: 'add' as const,
  files: [],
};

const WARDEN = {
  path: 'warden.yaml' as const,
  keys: [{ key: 'mode', outcome: 'theirs' as const, choice: 'take' as const, mine: 'watch', theirs: 'guard' }],
};

const VOICE = {
  path: 'voice.yaml' as const,
  keys: [{ key: 'engine', outcome: 'theirs' as const, choice: 'take' as const, mine: 'local', theirs: 'hosted' }],
};

const BASE = {
  source: { name: 'work-mac', verified: 'browser' as const },
  same: { count: 2, probable: 0 },
};

/** A first copy: what would run, in full; the sign-in that stays behind; the key it needs. */
export const FIRST: CloneReview = {
  ...BASE,
  mode: 'first',
  items: [GUARD, NOTES, PROFILE],
  settings: [WARDEN, VOICE],
  logins: [
    {
      sourceId: 'bedrock',
      outcome: 'ask',
      runnable: { entries: [{ label: 'Variable AWS_PROFILE', text: 'prod-admin', document: false }] },
    },
  ],
  keys: [{ name: 'NOTES_KEY', outcome: 'missing' }],
  fingerprint: 'fp-first',
};

/** The second step of that first copy: the same source, now a repeat copy, with the settings that differ. */
export const FOLLOWUP: CloneReview = {
  ...BASE,
  mode: 'update',
  items: [],
  settings: [WARDEN, VOICE],
  logins: [],
  keys: [],
  fingerprint: 'fp-second',
};

/** A repeat copy: a command that CHANGED, an item both machines changed, a key both changed, a login to pick. */
export const UPDATE: CloneReview = {
  ...BASE,
  mode: 'update',
  source: { name: 'work-mac', verified: 'browser', lastCopiedAt: InstantSchema.parse('2026-11-10T09:00:00.000Z') },
  items: [
    {
      ...NOTES,
      outcome: 'theirs',
      choice: 'take',
      fields: ['command'],
      files: [{ path: 'mcp/notes.json', change: 'changed', lines: { added: 2, removed: 1 } }],
      runnable: {
        ...NOTES.runnable,
        entries: [{ label: 'Starts (changed)', text: 'node ./notes-server.js --port 4200 --verbose', document: false }],
      },
    },
    { ...PROFILE, outcome: 'both', choice: undefined as never },
  ],
  settings: [
    WARDEN,
    { path: 'voice.yaml', keys: [{ key: 'engine', outcome: 'both', mine: 'local', theirs: 'hosted' }] },
  ],
  logins: [{ sourceId: 'work', outcome: 'ask', candidates: ['studio-claude', 'studio-codex'] }],
  keys: [{ name: 'NOTES_KEY', outcome: 'newer' }],
  fingerprint: 'fp-update',
};
