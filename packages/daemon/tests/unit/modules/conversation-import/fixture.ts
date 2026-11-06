import {
  type ConversationImportNeeds,
  type ConversationImportProvides,
  conversationImportModule,
} from '../../../../bin/modules/conversation-import.ts';
import type { DaemonStorage } from '../../../../src/adapters/storage/session-storage.ts';
import { LOOP_PARSE_PACING, type TranscriptParseWorker } from '../../../../src/adapters/transcript/index.ts';
import {
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  type ForeignHistoryEntry,
  type ForeignHistoryFiles,
  PacedTranscriptParser,
} from '../../../../src/lib/index.ts';
import { NO_HANDOFF_SCOPE } from '../../../../src/lib/imports/conversation-text.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';

/**
 * THE `conversationImport` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `conversationImportModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the
 * contract checks consume what production builds. Only the INPUTS are doubles: the foreign history's files are three
 * in-memory transcripts under a home that does not exist, the transcript worker is one that is never available (so the
 * inline readers answer, parsing on this thread), and the storage and the adopter are never asked anything. Building
 * starts nothing — every service only captures its inputs — so there is no timer or async work to leave behind in the
 * shared unit process.
 *
 * The three transcripts are what the mounted-surface tests read back: one readable Claude conversation (two messages
 * and one tool result whose text the history route must not expose), and two Codex files that are not JSON, which a
 * listing reports as one skipped reason with a count of two.
 */

const HOME = '/fixture/home';

/** The files the foreign history may read, by absolute path. */
const FILES: Readonly<Record<string, string>> = {
  [`${HOME}/.claude/projects/project/one.jsonl`]: [
    {
      type: 'user',
      uuid: 'record',
      timestamp: '2026-08-05T00:00:00.000Z',
      message: { role: 'user', content: 'record identifier' },
    },
    {
      type: 'assistant',
      uuid: 'reply',
      timestamp: '2026-08-05T00:00:01.000Z',
      message: { id: 'message', role: 'assistant', content: [{ type: 'text', text: 'message identifier' }] },
    },
    // The adversarial record: a tool result is parsed as a tool event, which the history route must never expose.
    {
      type: 'user',
      uuid: 'tool-record',
      timestamp: '2026-08-05T00:00:02.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-one', content: 'must not be exposed' }],
      },
    },
  ]
    .map(record => `${JSON.stringify(record)}\n`)
    .join(''),
  [`${HOME}/.codex/sessions/one.jsonl`]: '{invalid json}\n',
  [`${HOME}/.codex/sessions/two.jsonl`]: '{invalid json}\n',
};

/** A read-only filesystem over {@link FILES}: a directory is any prefix of a file's path. */
const foreignHistoryFiles: ForeignHistoryFiles = {
  entries: async (directory): Promise<readonly ForeignHistoryEntry[]> => {
    const prefix = `${directory}/`;
    const names = new Map<string, ForeignHistoryEntry['kind']>();
    for (const path of Object.keys(FILES)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'directory');
    }
    return [...names].map(([name, kind]) => ({ name, kind }));
  },
  size: async file => FILES[file]?.length,
  text: async file => FILES[file],
};

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function conversationImportNeeds(): ConversationImportNeeds {
  return {
    storage: {} as unknown as DaemonStorage,
    userHome: HOME,
    fleetDirectory: '/nonexistent/conversation-import-fixture-state-home/fleet',
    environment: {},
    transcriptWorker: { available: false } as unknown as TranscriptParseWorker,
    parsers: {
      claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), LOOP_PARSE_PACING),
      codex: new PacedTranscriptParser(new CodexTranscriptParser(), LOOP_PARSE_PACING),
    },
    handoffScope: NO_HANDOFF_SCOPE,
    foreignHistoryFiles,
    accountModel: async () => undefined,
    adopter: { adopt: NOT_EXERCISED('an adoption') },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtConversationImport(): BuiltModule<ConversationImportProvides> {
  return conversationImportModule.build(conversationImportNeeds(), undefined, LIFECYCLE);
}
