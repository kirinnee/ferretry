import { createHash } from 'node:crypto';
import type { ConfigFileText } from '../../../src/lib/config-files/evaluate.ts';

/** The provisioner's revision of a text: sha256 of its UTF-8 bytes, hex. */
export const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A file as the directory reader hands it over. */
export const file = (path: string, text: string): ConfigFileText => ({ path, text });

/** What the daemon would have accepted for these files: each text under its own digest. */
export const acceptedOf = (files: readonly ConfigFileText[]): Record<string, { etag: string; text: string }> =>
  Object.fromEntries(files.map(entry => [entry.path, { etag: digest(entry.text), text: entry.text }]));

/** A login that needs no secret: the owner's own host login. */
export const LOGIN_TEXT = 'harness: claude\nstore: host\n';

/** A login that does not clash with the host login: a machine has one `store: host` login per harness. */
export const SECOND_LOGIN_TEXT = 'harness: codex\nstore: ferretry\n';

/** One instructions component. */
const INSTRUCTIONS_TEXT = 'file: instructions/main.md\n';

/** A profile that contains the instructions component above. */
const PROFILE_TEXT = 'contents:\n  - instructions/main\n';

/** A runtime on the login and profile above. */
const RUNTIME_TEXT = 'credential: you\nprofile: default\nagent: true\n';

/** A fleet of one login, one component, one profile and one runtime. */
export const FLEET_FILES: readonly ConfigFileText[] = [
  file('logins/you.yaml', LOGIN_TEXT),
  file('components/instructions/main.yaml', INSTRUCTIONS_TEXT),
  file('profiles/default.yaml', PROFILE_TEXT),
  file('runtimes/claude.yaml', RUNTIME_TEXT),
];
