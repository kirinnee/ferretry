import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * STAND-INS FOR `claude` AND `codex`. They do exactly what the real binary does with its login, and nothing else:
 * each one finds a credential only where the real binary reads it (measured with the real binaries, claude 2.1.317 and
 * codex 0.166, by strace, against a loopback server), makes ONE provider request with it, and prints the reply.
 *
 * claude reads, in this order (anything earlier wins): `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`),
 * `ANTHROPIC_API_KEY` (`x-api-key`), then the OAuth file `<CLAUDE_SECURESTORAGE_CONFIG_DIR, else CLAUDE_CONFIG_DIR>/
 * .credentials.json` (`claudeAiOauth.accessToken`, Bearer), and sends to `ANTHROPIC_BASE_URL`. With none of them it says
 * `Not logged in · Please run /login`, as the real one does.
 * codex reads `<CODEX_HOME>/auth.json` (`OPENAI_API_KEY`, else `tokens.access_token`; Bearer) and sends to a base URL
 * its `config.toml`/`-c model_providers` names.
 *
 * WHY NOT THE REAL BINARIES: the real claude with an OAuth file talks to api.anthropic.com to refresh or validate the
 * token even when ANTHROPIC_BASE_URL is set, so it needs the network; claude-code is unfree in nixpkgs and the flake is
 * stock nixpkgs. The OAuth case therefore cannot be hermetic with the real binary. The env case WAS shown to work with
 * the real binary (see the report), so only the stand-in is used, for one uniform harness.
 *
 * Two inputs the real binary would take from somewhere the harness does not set are baked in: the provider URL for a
 * login with no base-URL variable (an OAuth login), and the log path. The launch itself must supply everything else.
 */
const COMMON = String.raw`
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const LOG = __LOG__;
const BAKED_URL = __URL__;
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(__VERSION__); process.exit(0); }
const env = process.env;
const log = record => appendFileSync(LOG, JSON.stringify(record) + '\n');
const filesIn = dir => { try { return readdirSync(dir).sort(); } catch { return []; } };
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
const stdinLine = async () => { for await (const chunk of process.stdin) return String(chunk); return ''; };
const say = text => { console.log(text); };
`;

const CLAUDE = String.raw`
import { appendFileSync as append, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
// Claude's settings precedence for env (measured with the real binary): a project's .claude/settings.json and
// settings.local.json outrank the process environment, and the --settings file outranks the project. A value the stand-in
// reads is therefore the one this layering leaves, not the raw process environment.
const applyEnv = text => { try { const found = JSON.parse(text).env; if (found && typeof found === 'object') for (const [k, v] of Object.entries(found)) if (typeof v === 'string') process.env[k] = v; } catch {} };
const readText = file => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } };
for (const name of ['settings.json', 'settings.local.json']) { const text = readText(join(process.cwd(), '.claude', name)); if (text !== undefined) applyEnv(text); }
const settingsFlag = args.indexOf('--settings');
const settingsArg = settingsFlag >= 0 ? args[settingsFlag + 1] : undefined;
if (settingsArg !== undefined) { const inline = settingsArg.trimStart().startsWith('{'); const text = inline ? settingsArg : readText(settingsArg); if (text !== undefined) applyEnv(text); }
const configDir = env.CLAUDE_CONFIG_DIR;
const storeDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined && env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== '' ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR : configDir;
const oauth = storeDir === undefined ? undefined : readJson(join(storeDir, '.credentials.json'))?.claudeAiOauth;
let auth = 'none', headers = {};
if (env.ANTHROPIC_AUTH_TOKEN) { auth = 'ANTHROPIC_AUTH_TOKEN'; headers = { authorization: 'Bearer ' + env.ANTHROPIC_AUTH_TOKEN }; }
else if (env.ANTHROPIC_API_KEY) { auth = 'ANTHROPIC_API_KEY'; headers = { 'x-api-key': env.ANTHROPIC_API_KEY }; }
else if (oauth && typeof oauth.accessToken === 'string' && oauth.expiresAt > Date.now()) { auth = 'oauth-file'; headers = { authorization: 'Bearer ' + oauth.accessToken }; }
const base = env.ANTHROPIC_BASE_URL || (auth === 'oauth-file' ? BAKED_URL : undefined);
const sid = args[args.indexOf('--session-id') + 1] ?? 'no-session-id';
log({ binary: 'claude', argv: args, argvFlags: args.filter(a => a.startsWith('--')).map(a => a.split('=')[0]), auth, base: base === undefined ? 'none' : 'set', baseUrl: base ?? null,
  envNames: Object.keys(env).filter(k => /^(ANTHROPIC_|CLAUDE_|FY_)/u.test(k)).sort(), configDir, storeDir: storeDir ?? null,
  configDirFiles: configDir === undefined ? [] : filesIn(configDir), storeDirFiles: storeDir === undefined ? [] : filesIn(storeDir) });
// The transcript the daemon reads: <config>/projects/<cwd, every non-alphanumeric as '-'>/<session id>.jsonl.
const transcriptDir = join(configDir ?? '/nonexistent', 'projects', process.cwd().replace(/[^A-Za-z0-9]/gu, '-'));
mkdirSync(transcriptDir, { recursive: true });
const transcript = join(transcriptDir, sid + '.jsonl');
const record = (role, n, parent, text) => append(transcript, JSON.stringify({ type: role, uuid: role[0] + n + '-' + sid, parentUuid: parent, sessionId: sid,
  timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }] } }) + '\n');
process.stdout.write('Fake Claude ready\n> ');
let n = 0;
for await (const line of createInterface({ input: process.stdin })) {
  n += 1;
  record('user', n, null, line);
  if (auth === 'none' || base === undefined) { say('Not logged in · Please run /login'); process.stdout.write('> '); continue; }
  const response = await fetch(base + '/v1/messages', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'fake-model', max_tokens: 16, messages: [{ role: 'user', content: line }] }) });
  const body = await response.json();
  record('assistant', n, 'u' + n + '-' + sid, body.content?.[0]?.text ?? 'NO-TEXT');
  say('working'); process.stdout.write('> ');
}
`;

const CODEX = String.raw`
import { createInterface } from 'node:readline';
const home = env.CODEX_HOME;
const authFile = home === undefined ? undefined : readJson(join(home, 'auth.json'));
const key = authFile?.OPENAI_API_KEY ?? authFile?.tokens?.access_token;
const base = env.OPENAI_BASE_URL || BAKED_URL;
log({ binary: 'codex', argvFlags: args.filter(a => a.startsWith('-')), auth: key ? 'auth.json' : 'none', envNames: Object.keys(env).filter(k => /^(OPENAI_|CODEX_|FY_)/u.test(k)).sort(),
  home, homeFiles: home === undefined ? [] : filesIn(home) });
process.stdout.write('  >_ OpenAI Codex (v0.166.0)\n     ' + process.cwd() + '\n\n› ');
for await (const line of createInterface({ input: process.stdin })) {
  if (!key) { say('Not logged in: run codex login'); process.stdout.write('› '); continue; }
  const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', input: line, stream: false }) });
  const body = await response.json();
  say('• ' + (body.output?.[0]?.content?.[0]?.text ?? 'NO-TEXT')); process.stdout.write('› ');
}
`;

export interface StubBinaries {
  /** The directory to put first on the daemon's PATH. */
  readonly dir: string;
  /** What the stand-ins appended, one JSON record per launch. */
  readonly log: string;
}

/** Writes `claude` and `codex` into `<root>/bin`, each a tiny sh launcher for a bun script, and an empty log. */
export async function writeStubBinaries(root: string, providerUrl: string): Promise<StubBinaries> {
  const dir = join(root, 'bin');
  const log = join(root, 'stub-launches.jsonl');
  await mkdir(dir, { recursive: true });
  await writeFile(log, '');
  const fill = (script: string, version: string) =>
    script
      .replace('__LOG__', JSON.stringify(log))
      .replace('__URL__', JSON.stringify(providerUrl))
      .replace('__VERSION__', JSON.stringify(version));
  for (const [name, body, version] of [
    ['claude', CLAUDE, '2.1.317 (Claude Code)'],
    ['codex', CODEX, 'codex-cli 0.166.0'],
  ] as const) {
    const script = join(dir, `${name}.stub.mjs`);
    await writeFile(script, fill(COMMON + body, version));
    const launcher = join(dir, name);
    await writeFile(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    await chmod(launcher, 0o755);
  }
  return { dir, log };
}
