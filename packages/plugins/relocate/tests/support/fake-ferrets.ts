import type {
  FerretId,
  FerretsApi,
  FerretSummary,
  RelocationFile,
  RelocationSource,
} from '@ferretry/core-ferrets/contract';
import type { Result } from '@ferretry/std';
import type { PackedConversation } from '@ferretry/core-ferrets/contract';

export const FERRET = 'f-move-1' as FerretId;

/** What a ferret's session folder holds in a fixture: each path and its text. Nothing here is a real credential. */
export const SESSION_FILES: Readonly<Record<string, string>> = {
  'turns/turn-001.md': 'the assigned task',
  'turns/turn-002.md': 'a later turn',
  'channel/queued-s1.md': 'a long queued message',
  'attachments/a1/photo.txt': 'photo bytes',
};

/** Files a misbehaving or newer Ferrets might list: none of them may ever reach a bundle. */
export const NEVER_LISTED: Readonly<Record<string, string>> = {
  'environment.json': 'SESSION-CREDENTIAL-VALUE-aa11',
  'tokens.json': 'TOKENS-VALUE-bb22',
  'media/leak.png': 'MEDIA-VALUE-cc33',
  'attachments/id_rsa': 'ATTACHED-SECRET-NAME-VALUE-dd44',
};

export const HISTORY = '{"sequence":1,"type":"session.started"}\n{"sequence":2,"type":"turn.ended"}\n';
export const CONVERSATION = { relPath: 'projects/-work/abc-123.jsonl', text: '{"type":"user","text":"hello"}\n' };

export interface FakeSourceOptions {
  readonly busy?: readonly string[];
  readonly conversation?: Result<PackedConversation, { readonly reason: string }>;
  /** Extra listed files beyond the fixture's, by path (with their text). */
  readonly extra?: Readonly<Record<string, string>>;
  readonly size?: (path: string) => number | undefined;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The Ferrets side of the move over an in-memory ferret: lists and reads only what it is given, and counts what it was asked. */
export function fakeSource(options: FakeSourceOptions = {}): RelocationSource & { readonly reads: string[] } {
  const session = { ...SESSION_FILES, ...(options.extra ?? {}) };
  const reads: string[] = [];
  return {
    reads,
    files: async () => [
      ...Object.entries(session).map(
        ([path, text]): RelocationFile => ({ area: 'session', path, size: options.size?.(path) ?? text.length }),
      ),
      { area: 'history', path: 'history.jsonl', size: HISTORY.length },
    ],
    read: async (file, limit) => {
      reads.push(`${file.area}:${file.path}`);
      const text = file.area === 'history' ? HISTORY : session[file.path];
      if (text === undefined) throw new Error('not listed');
      if (text.length > limit) throw new Error('too large');
      return bytes(text);
    },
    busy: async () => options.busy ?? [],
    conversation: async () =>
      options.conversation ?? { ok: true, value: { relPath: CONVERSATION.relPath, bytes: bytes(CONVERSATION.text) } },
  };
}

export interface FakeFerrets {
  readonly port: Pick<FerretsApi, 'get' | 'workFolder' | 'relocationSource' | 'stop' | 'resume'>;
  readonly calls: string[];
  state: FerretSummary['state'];
}

function summaryOf(state: FerretSummary['state']): FerretSummary {
  return {
    id: FERRET,
    name: 'Mover',
    role: 'lead',
    harness: 'claude-code',
    runner: 'terminals',
    folder: '/work',
    state,
    createdAt: '2026-11-27T00:00:00.000Z',
    stateAt: '2026-11-27T00:00:00.000Z',
  } as unknown as FerretSummary;
}

/** The Ferrets port as the move uses it, recording `stop` and `resume` so a test can say "nothing was stopped". */
export function fakeFerrets(options: {
  readonly state?: FerretSummary['state'];
  readonly source?: RelocationSource | undefined;
  readonly folder?: string | undefined;
}): FakeFerrets {
  const calls: string[] = [];
  const self: FakeFerrets = {
    calls,
    state: options.state ?? 'idle',
    port: {
      get: async id => (id === FERRET ? summaryOf(self.state) : undefined),
      workFolder: async () => (options.folder === undefined ? undefined : { folder: options.folder }),
      relocationSource: async () => options.source,
      stop: async (_ferret, how) => {
        calls.push(`stop:${how}`);
        self.state = 'stopped';
      },
      resume: async () => {
        calls.push('resume');
        self.state = 'idle';
        return { ok: true, value: FERRET };
      },
    },
  };
  return self;
}
