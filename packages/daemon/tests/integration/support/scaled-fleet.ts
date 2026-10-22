/**
 * A STATE HOME SHAPED LIKE THE MAC THAT STALLED.
 *
 * The owner's daemon stalled its event loop for seconds at a time, for minutes after every boot, on a
 * fleet no test had: thirty-six sessions (six running), three Claude transcripts of 200 MB, thousands of
 * Codex rollouts, six runtime homes. A boot over a tidy two-session fixture is fast whatever the code
 * does, so the stall could not be reproduced, measured or held to a budget. This builds that fleet —
 * through the daemon's own storage, so every document is one the daemon parses back — at whatever
 * scale a caller asks for.
 *
 * Built once per root and reused: the transcripts are the expensive part, and a fixture that already
 * carries its marker is answered as it is.
 */
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  accountModelFiles,
  buildFleetManifest,
  ferretryCredentialDirectory,
  parseAccountModel,
  renderConfigFile,
} from '@ferretry/fleet';
import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import { buildWorld } from '../../../bin/fyd.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

export interface ScaledFleetShape {
  /** Every session the index holds. */
  readonly sessions: number;
  /** How many of them are running; the rest have finished. */
  readonly running: number;
  /** How many Claude transcripts are as large as {@link hugeTranscriptBytes}. */
  readonly hugeTranscripts: number;
  readonly hugeTranscriptBytes: number;
  /** Every other transcript's size. */
  readonly transcriptBytes: number;
  /** How many Codex rollouts the Codex home holds, and each one's size. */
  readonly rollouts: number;
  readonly rolloutBytes: number;
  /** Running Codex sessions whose rollout is still undiscovered, so a resolve walks every rollout. */
  readonly undiscoveredCodex: number;
}

/** The owner's Mac, as `fy daemon status` and the brief described it. */
export const OWNER_MAC_FLEET: ScaledFleetShape = Object.freeze({
  sessions: 36,
  running: 6,
  hugeTranscripts: 3,
  hugeTranscriptBytes: 200 * 1024 * 1024,
  transcriptBytes: 12 * 1024 * 1024,
  rollouts: 2_000,
  rolloutBytes: 48 * 1024,
  undiscoveredCodex: 2,
});

/** The five Claude runtimes and the one Codex runtime the Mac has. */
const CLAUDE_RUNTIMES = ['deepseek', 'glm-a', 'glm-b', 'kirin', 'minimax'] as const;
const CODEX_RUNTIME = 'codex-kirin';

export interface ScaledFleet {
  /** `FY_HOME`. */
  readonly home: string;
  /** The user home handed to `buildWorld`. */
  readonly userHome: string;
  readonly shape: ScaledFleetShape;
  /** Total transcript and rollout bytes on disk. */
  readonly bytes: number;
}

const AT = '2026-10-20T09:00:00.000Z';
const FINISHED = '2026-10-20T18:00:00.000Z';
const MARKER = 'scaled-fleet.json';
/**
 * What a cached fixture must have been built by to be reused. Bumped whenever the fixture gains
 * something a shape cannot name, so an old fixture on a developer's disk is rebuilt, not trusted.
 */
const FIXTURE_REVISION = 2;

/**
 * The logins the fleet's runtimes run on (docs/design/account-model.md): two Claude logins and one
 * Codex login, each in Ferretry's own file store, so the usage pass has real stores to read — on the
 * Mac this is the fleet refresh's whole cost, and a fixture with no logins measured none of it.
 */
export const FIXTURE_LOGINS = Object.freeze({
  claude: ['claude-work', 'claude-home'],
  codex: 'codex-main',
} as const);

/** Which login each runtime is on: the Claude runtimes split across the two Claude logins. */
const RUNTIME_LOGIN: Readonly<Record<string, string>> = {
  deepseek: 'claude-work',
  'glm-a': 'claude-work',
  kirin: 'claude-work',
  'glm-b': 'claude-home',
  minimax: 'claude-home',
  [CODEX_RUNTIME]: 'codex-main',
};

/**
 * How often the usage pass runs, in seconds: the fleet's `usage.interval`, cut from 60 so a profile
 * window of half a minute holds more than one pass.
 */
export const FIXTURE_USAGE_INTERVAL_SECONDS = 10;

/** Far beyond any test run, so no fake login ever reads as expired. */
const TOKEN_EXPIRES_AT = Date.parse('2099-01-01T00:00:00.000Z');

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A JWT's shape with no signature anybody checks: the facts a Codex login is judged from. */
const jwt = (payload: unknown): string => `${segment({ alg: 'none' })}.${segment(payload)}.TESTONLY`;

/**
 * The configuration, credential files and published manifest of {@link FIXTURE_LOGINS}, written the
 * way an apply leaves them. Every token is a fake marked `TESTONLY`; none reaches a network — the free
 * usage reads go to the loopback fake server (`fake-usage-server.ts`) through `FY_USAGE_PROBE_ORIGIN`.
 */
async function writeLogins(home: string): Promise<void> {
  const config = join(home, 'config');
  const fleet = join(home, 'fleet');
  const model = parseAccountModel({
    version: 2,
    credentials: {
      'claude-work': { harness: 'claude', store: 'ferretry' },
      'claude-home': { harness: 'claude', store: 'ferretry' },
      'codex-main': { harness: 'codex', store: 'ferretry' },
    },
    profiles: { default: { layers: [] } },
    runtimes: Object.fromEntries(
      Object.entries(RUNTIME_LOGIN).map(([runtime, credential]) => [
        runtime,
        { credential, profile: 'default', agent: true },
      ]),
    ),
    advanced: { usage: { interval: FIXTURE_USAGE_INTERVAL_SECONDS } },
  });
  for (const [path, { address, value }] of accountModelFiles(model)) {
    const text = renderConfigFile(path, address, value, undefined);
    if (text === undefined) continue;
    await mkdir(dirname(join(config, path)), { recursive: true });
    await writeFile(join(config, path), text, { mode: 0o600 });
  }

  for (const id of FIXTURE_LOGINS.claude) {
    const directory = ferretryCredentialDirectory(fleet, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `sk-ant-oat-${id}-TESTONLY`,
          refreshToken: `sk-ant-ort-${id}-TESTONLY`,
          expiresAt: TOKEN_EXPIRES_AT,
          scopes: ['user:inference', 'user:profile'],
        },
      }),
      { mode: 0o600 },
    );
  }
  const codex = ferretryCredentialDirectory(fleet, FIXTURE_LOGINS.codex);
  await mkdir(codex, { recursive: true, mode: 0o700 });
  await writeFile(
    join(codex, 'auth.json'),
    JSON.stringify({
      OPENAI_API_KEY: null,
      last_refresh: AT,
      tokens: {
        access_token: jwt({ exp: TOKEN_EXPIRES_AT / 1_000 }),
        refresh_token: 'rt-codex-main-TESTONLY',
        account_id: 'acct-fixture',
        id_token: jwt({
          email: 'fixture@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
        }),
      },
    }),
    { mode: 0o600 },
  );

  const manifest = buildFleetManifest({
    generatedAt: AT,
    accounts: [],
    runtimes: Object.entries(RUNTIME_LOGIN).map(([name, credential], index) => ({
      id: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
      name,
      harness: name === CODEX_RUNTIME ? 'codex' : 'claude',
      credential,
      profile: 'default',
      agent: true,
      wrapper: join(fleet, 'bin', name),
      models: [{ id: 'default', available: true }],
      defaultModel: 'default',
    })),
  });
  await writeFile(join(fleet, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** One Claude exchange: a prompt, a tool call, a priced reply. Every id is unique per `n`. */
function claudeExchange(sessionId: string, n: number): string {
  const at = new Date(Date.parse(AT) + n * 1_000).toISOString();
  const user = {
    type: 'user',
    sessionId,
    uuid: `${sessionId}-u-${String(n)}`,
    timestamp: at,
    message: { role: 'user', content: `Please continue with step ${String(n)} of the refactor.` },
  };
  const assistant = {
    type: 'assistant',
    sessionId,
    uuid: `${sessionId}-a-${String(n)}`,
    parentUuid: user.uuid,
    timestamp: at,
    message: {
      id: `msg_${sessionId}_${String(n)}`,
      role: 'assistant',
      model: 'claude-opus-4-1',
      content: [
        {
          type: 'text',
          text: `Working on step ${String(n)}. ${'Reading the module and planning the change. '.repeat(8)}`,
        },
        { type: 'tool_use', id: `toolu_${sessionId}_${String(n)}`, name: 'Read', input: { file_path: '/src/a.ts' } },
      ],
      usage: {
        input_tokens: 1_200,
        output_tokens: 340,
        cache_read_input_tokens: 52_000,
        cache_creation_input_tokens: 0,
      },
    },
  };
  const result = {
    type: 'user',
    sessionId,
    uuid: `${sessionId}-r-${String(n)}`,
    parentUuid: assistant.uuid,
    timestamp: at,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `toolu_${sessionId}_${String(n)}`, content: 'x'.repeat(1_500) }],
    },
  };
  return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n${JSON.stringify(result)}\n`;
}

/** One Codex rollout record set: the header, then turns that each end with a rate-limit reading. */
function codexRollout(conversationId: string, bytes: number): string {
  const lines = [
    JSON.stringify({
      timestamp: AT,
      type: 'session_meta',
      payload: { id: conversationId, cwd: '/work', originator: 'codex_cli_rs' },
    }),
  ];
  let size = lines[0]?.length ?? 0;
  for (let n = 0; size < bytes; n += 1) {
    const at = new Date(Date.parse(AT) + n * 1_000).toISOString();
    const turn = [
      JSON.stringify({
        timestamp: at,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'y'.repeat(600) }] },
      }),
      JSON.stringify({
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 1_000 + n, output_tokens: 200, total_tokens: 1_200 + n } },
          rate_limits: {
            primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 3_600 },
            secondary: { used_percent: 40, window_minutes: 10_080, resets_in_seconds: 86_400 },
          },
        },
      }),
    ];
    lines.push(...turn);
    size += turn.reduce((sum, line) => sum + line.length + 1, 0);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes `bytes` of Claude transcript for `sessionId`, a megabyte of exchanges at a time. */
async function writeClaudeTranscript(file: string, sessionId: string, bytes: number): Promise<number> {
  const handle = await open(file, 'w');
  let written = 0;
  let n = 0;
  try {
    while (written < bytes) {
      const parts: string[] = [];
      let chunk = 0;
      while (chunk < 1024 * 1024 && written + chunk < bytes) {
        const exchange = claudeExchange(sessionId, n);
        n += 1;
        parts.push(exchange);
        chunk += exchange.length;
      }
      const text = parts.join('');
      await handle.write(text);
      written += Buffer.byteLength(text);
    }
  } finally {
    await handle.close();
  }
  return written;
}

/** The id of the fixture's `index`th session; the first `running` of them are the running ones. */
export const sessionIdOf = (index: number): string => `scaled-${String(index).padStart(2, '0')}`;

/**
 * The fleet under `root`, built if it is not there yet. Sessions are written through the daemon's own
 * storage with the protocol's schemas, exactly as the boot-lifecycle fixtures write theirs.
 */
export async function scaledFleet(root: string, shape: ScaledFleetShape = OWNER_MAC_FLEET): Promise<ScaledFleet> {
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  const marker = join(root, MARKER);
  const existing = await readFile(marker, 'utf8').catch(() => undefined);
  const cached = existing === undefined ? undefined : (JSON.parse(existing) as ScaledFleet & { revision?: number });
  if (cached?.revision === FIXTURE_REVISION && JSON.stringify(cached.shape) === JSON.stringify(shape)) return cached;
  // A fixture built by an older revision or for another shape is built again from nothing, never patched.
  if (cached !== undefined) await Promise.all([home, userHome, marker].map(path => rm(path, { recursive: true, force: true })));

  await mkdir(userHome, { recursive: true });
  // The state home is claimed FIRST: its layout refuses a non-empty directory it did not mark.
  process.env.FY_HOME = home;
  const opened = await buildWorld({}, { userHome }).storage.open();
  const homes = join(home, 'fleet', 'homes');
  const codexHome = join(homes, CODEX_RUNTIME);
  let bytes = 0;

  // Six runtime homes, one per runtime the Mac has.
  for (const runtime of [...CLAUDE_RUNTIMES, CODEX_RUNTIME]) await mkdir(join(homes, runtime), { recursive: true });

  // Thousands of Codex rollouts, spread across day directories as Codex writes them.
  const rolloutFiles: string[] = [];
  // Every rollout here predates every session, so each undiscovered session's baseline names them all —
  // exactly what a real launch records before it starts the harness.
  const rolloutIds: string[] = [];
  for (let index = 0; index < shape.rollouts; index += 1) {
    const day = String((index % 28) + 1).padStart(2, '0');
    const directory = join(codexHome, 'sessions', '2026', '10', day);
    await mkdir(directory, { recursive: true });
    const conversationId = `0199${String(index).padStart(4, '0')}-0000-7000-8000-${String(index).padStart(12, '0')}`;
    const file = join(directory, `rollout-2026-10-${day}T09-00-00-${conversationId}.jsonl`);
    const text = codexRollout(conversationId, shape.rolloutBytes);
    await writeFile(file, text);
    bytes += Buffer.byteLength(text);
    rolloutFiles.push(file);
    rolloutIds.push(conversationId);
  }

  let hugeLeft = shape.hugeTranscripts;
  try {
    for (let index = 0; index < shape.sessions; index += 1) {
      const sessionId = sessionIdOf(index);
      const id = parseSessionId(sessionId);
      const running = index < shape.running;
      // Every third session is Codex; the rest are Claude, spread over the five Claude runtimes.
      const codex = index % 3 === 2;
      const runtime = codex ? CODEX_RUNTIME : CLAUDE_RUNTIMES[index % CLAUDE_RUNTIMES.length]!;
      const runtimeHome = join(homes, runtime);
      await opened.storage.writeConfig(
        id,
        SessionConfigSchema.parse({
          id: sessionId,
          incarnation: `${sessionId}-1`,
          runtimeGeneration: 1,
          name: `Scaled ${String(index)}`,
          boardAccess: 'none',
          agent: runtime,
          harness: codex ? 'codex' : 'claude',
          modelHint: 'opus',
          mode: 'auto',
          remoteControl: false,
          harnessFlags: [],
          cwd: '/work',
          createdAt: AT,
          updatedAt: AT,
          turn: 1,
          intervalSeconds: 30,
          timeoutSeconds: 0,
          nudgeAfterSeconds: 0,
          killAfterSeconds: 0,
          directSendMaxChars: 4_096,
          resumeMenuChoice: 'full',
          maxSnapshots: 10,
          retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
        }),
      );
      await opened.storage.writeState(
        id,
        SessionStateSchema.parse({
          id: sessionId,
          status: running ? 'running' : 'completed',
          turn: 1,
          startedAt: AT,
          lastActivityAt: running ? AT : FINISHED,
          ...(running ? {} : { finishedAt: FINISHED }),
        }),
      );
      let transcript: { [key: string]: string | number | string[] };
      if (codex) {
        const undiscovered = running && index < shape.running && index % 3 === 2 && shape.undiscoveredCodex > 0;
        const file = rolloutFiles[index % Math.max(1, rolloutFiles.length)];
        transcript =
          undiscovered || file === undefined
            ? {
                v: 1,
                home: codexHome,
                identity: 'undiscovered',
                baseline: rolloutIds,
                correlationToken: `fy-${sessionId}`,
              }
            : {
                v: 1,
                home: codexHome,
                identity: 'correlated',
                harnessSessionId: `${sessionId}-codex`,
                file,
                resolvedAt: AT,
              };
      } else {
        const directory = join(runtimeHome, 'projects', '-work');
        await mkdir(directory, { recursive: true });
        const harnessSessionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        const file = join(directory, `${harnessSessionId}.jsonl`);
        // The huge ones: the first Claude session (running), then the first finished ones, as on the Mac.
        const huge = hugeLeft > 0 && (index === 0 || index >= shape.running);
        if (huge) hugeLeft -= 1;
        const size = huge ? shape.hugeTranscriptBytes : shape.transcriptBytes;
        bytes += await writeClaudeTranscript(file, harnessSessionId, size);
        transcript = { v: 1, home: runtimeHome, identity: 'minted', harnessSessionId, file, resolvedAt: AT };
      }
      await opened.storage.updateConfig(id, current => ({
        ...(current as Record<string, unknown>),
        command: ['/usr/bin/env', codex ? 'codex' : 'claude'],
        tmuxSession: `fy-${sessionId}`,
        transcript,
      }));
    }
  } finally {
    await opened.storage.close();
  }

  await writeLogins(home);

  const fleet: ScaledFleet = { home, userHome, shape, bytes };
  await writeFile(marker, JSON.stringify({ ...fleet, revision: FIXTURE_REVISION }));
  return fleet;
}
