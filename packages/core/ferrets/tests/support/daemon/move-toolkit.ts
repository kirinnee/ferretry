import { join } from 'node:path';
import type {
  ConversionRequest,
  ConversionResult,
  ConvertedConversationSummary,
  TranscriptToolkit,
} from '../../../daemon/lib/moves/ports.ts';

/**
 * A stand-in for the harness plugins' pure transcript pieces (`TranscriptToolkit`): where each harness writes a
 * transcript, the version gate, the hand-off pointer rules and a converter that records what it was asked and answers
 * a fixed conversion. The real converter belongs to the plugins and is measured there; what the move owns — the request
 * it builds, the paths and the provenance it derives, every refusal — is measured against this.
 */

const CODEX_TESTED_MINORS = [145, 156, 163, 164, 165];

const SUMMARY = (request: ConversionRequest): ConvertedConversationSummary => ({
  converter: 1,
  source: { harness: request.source.harness },
  target: {
    harness: request.target.harness,
    version: /(\d+\.\d+\.\d+)/u.exec(request.target.version ?? '')?.[1] ?? '0.0.0',
    conversationId: request.target.conversationId,
  },
  turns: 3,
  keptTurns: 3,
  omittedTurns: 0,
  cutNewest: false,
  messages: 3,
  nativeToolCalls: 0,
  toolCallsAsText: 0,
  attachments: 1,
  dropped: { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 },
  estimatedTokens: 120,
  budgetTokens: request.target.contextWindow,
});

export interface RecordingToolkit extends TranscriptToolkit {
  /** Every request the converter was handed, in order. */
  readonly conversions: ConversionRequest[];
}

/** The fake toolkit. Its converter refuses a Codex version outside the tested table unless the format was probed `same`. */
export function testToolkit(): RecordingToolkit {
  const conversions: ConversionRequest[] = [];
  const toolkit: RecordingToolkit = {
    conversions,
    claudeProjectDirectory: cwd => cwd.replaceAll(/[^a-zA-Z0-9]/gu, '-'),
    claudeTranscriptFile: (home, cwd, id) => join(home, 'projects', toolkit.claudeProjectDirectory(cwd), `${id}.jsonl`),
    codexRolloutRelativePath: (threadId, at) => {
      const [, year, month, day, hour, minute, second] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(
        at,
      ) ?? ['', '1970', '01', '01', '00', '00', '00'];
      return `sessions/${year}/${month}/${day}/rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-${threadId}.jsonl`;
    },
    harnessVersionRefusal: (harness, version, role) => {
      if (harness !== 'codex') return undefined;
      const parsed = /(\d+)\.(\d+)\.(\d+)/u.exec(version ?? '');
      if (parsed === null)
        return `Ferretry couldn't tell which Codex version this machine runs, and the converter is tested only on Codex 0.145, 0.156, 0.163, 0.164, 0.165, so it won't write a conversation for it.`;
      return CODEX_TESTED_MINORS.includes(Number(parsed[2]))
        ? undefined
        : `Codex ${parsed[0]} isn't one of the versions the converter was tested on (${role}).`;
    },
    convertConversation: (request: ConversionRequest): ConversionResult => {
      conversions.push(request);
      const refusal = toolkit.harnessVersionRefusal('codex', request.target.version, 'target');
      if (request.target.harness === 'codex' && refusal !== undefined && request.target.format?.kind !== 'same') {
        const format = request.target.format;
        return {
          kind: 'refused',
          reason: format?.kind === 'different' ? `${refusal} ${format.reason}` : refusal,
        };
      }
      const summary = SUMMARY(request);
      return {
        kind: 'converted',
        transcript: JSON.stringify({ target: request.target.harness, id: request.target.conversationId }),
        files: [{ name: 'attachment-1.png', data: 'AAAA' }],
        summary:
          request.target.format?.kind === 'same' && refusal !== undefined
            ? { ...summary, formatNote: 'its format is unchanged from the one validated' }
            : summary,
        sentinels: [],
        nativeTools: [],
      };
    },
    handoffPointerPaths: text => [
      ...new Set(
        [...text.matchAll(/Read the (?:file|queued message file at) (\/[^\s"\\]+?\.md)(?= now| completely now)/gu)].map(
          match => match[1] as string,
        ),
      ),
    ],
    isReadableHandoff: (path, scope) => scope.roots.some(root => path.startsWith(`${root}/`) && !path.includes('..')),
    handoffReadMaxBytes: 64 * 1024,
  };
  return toolkit;
}
