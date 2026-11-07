import { describe, it } from 'bun:test';
import type { TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import {
  type ConversationConvertRequest,
  codexModelProvider,
  needsRolloutFormatProbe,
  planConversationConvert,
} from '../../../src/lib/migrate/conversation-convert.ts';

/**
 * The plan for a cross-harness move: what is written where, under which id, and every refusal that
 * leaves the session untouched. The conversion itself is measured in `transcript/convert.test.ts`.
 */

const AT = '2026-10-20T08:00:00.000Z';
const NEW_ID = '22222222-3333-4444-8555-666666666666';
const CLAUDE_SOURCE: TranscriptProvenance = {
  v: 1,
  home: '/homes/claude',
  harnessSessionId: 'src-1',
  identity: 'minted',
  file: '/homes/claude/projects/-work-repo/src-1.jsonl',
  resolvedAt: AT,
};
const CLAUDE_TEXT = [
  { type: 'user', message: { role: 'user', content: 'hello' } },
  {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'pic' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
  },
]
  .map(record => JSON.stringify({ ...record, sessionId: 'src-1', version: '2.1.281', timestamp: AT }))
  .join('\n');

const base: ConversationConvertRequest = {
  sourceHarness: 'claude',
  targetHarness: 'codex',
  source: CLAUDE_SOURCE,
  sourceText: CLAUDE_TEXT,
  documents: new Map(),
  targetHome: '/homes/codex',
  targetVersion: 'codex-cli 0.163.0',
  targetAgent: 'codex-a',
  targetModel: 'gpt-5.5',
  targetWindow: 200_000,
  cwd: '/work/repo',
  sessionDirectory: '/state/sessions/s1',
  conversationId: NEW_ID,
  at: AT,
};

describe('planning a cross-harness conversion', () => {
  it('should write a Codex rollout under a fresh thread id, adopted and correlated by the session directory', () => {
    // Act
    const plan = planConversationConvert({ ...base, targetModelProvider: 'fleet' });

    // Assert
    if (plan.kind !== 'convert') throw new Error(plan.reason);
    const file = `/homes/codex/sessions/2026/10/20/rollout-2026-10-20T08-00-00-${NEW_ID}.jsonl`;
    should(plan.conversationId).equal(NEW_ID);
    should(plan.provenance).deepEqual({
      v: 1,
      home: '/homes/codex',
      harnessSessionId: NEW_ID,
      identity: 'adopted',
      correlationToken: '/state/sessions/s1',
      file,
      resolvedAt: AT,
    });
    should(plan.transcript.file).equal(file);
    const meta = JSON.parse(plan.transcript.text.split('\n')[0] ?? '');
    should(meta.payload).match({
      id: NEW_ID,
      cwd: '/work/repo',
      model_provider: 'fleet',
      runtime_workspace_roots: ['/work/repo', '/state/sessions/s1/codex-correlation/unreachable'],
    });
    should(plan.files).deepEqual([{ file: `/state/sessions/s1/conversions/${NEW_ID}/attachment-1.png`, data: 'AAAA' }]);
    should(plan.summary.target).deepEqual({ harness: 'codex', version: '0.163.0', conversationId: NEW_ID });
  });

  it('should let an untested Codex take the conversion when its probed format is the validated one, and refuse it otherwise', () => {
    // Arrange
    const untested = { ...base, targetVersion: 'codex-cli 0.170.2' };

    // Act
    const same = planConversationConvert({ ...untested, targetFormat: { kind: 'same' } });
    const different = planConversationConvert({
      ...untested,
      targetFormat: { kind: 'different', reason: 'it no longer writes session_meta/- records' },
    });
    const unprobed = planConversationConvert(untested);

    // Assert
    if (same.kind !== 'convert') throw new Error(same.reason);
    should(same.summary.formatNote).containEql('unchanged from the one validated on Codex 0.165');
    should(different.kind).equal('unconvertible');
    should((different as { reason: string }).reason).containEql('it no longer writes session_meta/- records');
    should(unprobed.kind).equal('unconvertible');
  });

  it('should render the same conversion elsewhere for the validation run, with the place deciding cwd, id and provider', () => {
    // Arrange
    const plan = planConversationConvert(base);
    if (plan.kind !== 'convert') throw new Error(plan.reason);

    // Act
    const elsewhere = plan.render({ cwd: '/tmp/check/work', conversationId: 'check-id', modelProvider: 'fy_check' });
    const defaulted = plan.render({ cwd: '/tmp/check/work', conversationId: 'check-id' });

    // Assert
    if (elsewhere.kind !== 'converted' || defaulted.kind !== 'converted') throw new Error('refused');
    should(JSON.parse(elsewhere.transcript.split('\n')[0] ?? '').payload).match({
      id: 'check-id',
      cwd: '/tmp/check/work',
      model_provider: 'fy_check',
    });
    should(JSON.parse(defaulted.transcript.split('\n')[0] ?? '').payload.model_provider).equal('openai');
  });

  it('should write a Claude transcript at the path Claude derives, minted under the new id, recording the target model', () => {
    // Arrange
    const codexText = [
      { type: 'session_meta', payload: { id: 'thread-1', cli_version: '0.156.1' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      },
    ]
      .map(record => JSON.stringify({ timestamp: AT, ...record }))
      .join('\n');

    // Act
    const plan = planConversationConvert({
      ...base,
      sourceHarness: 'codex',
      targetHarness: 'claude',
      source: { ...CLAUDE_SOURCE, home: '/homes/codex', harnessSessionId: 'thread-1' },
      sourceText: codexText,
      targetHome: '/homes/claude-b',
      targetVersion: '2.1.304 (Claude Code)',
      targetModel: 'claude-opus-5-5',
    });

    // Assert
    if (plan.kind !== 'convert') throw new Error(plan.reason);
    should(plan.provenance).deepEqual({
      v: 1,
      home: '/homes/claude-b',
      harnessSessionId: NEW_ID,
      identity: 'minted',
      file: `/homes/claude-b/projects/-work-repo/${NEW_ID}.jsonl`,
      resolvedAt: AT,
    });
    should(JSON.parse(plan.transcript.text.split('\n')[0] ?? '')).match({ sessionId: NEW_ID, version: '2.1.304' });
  });

  it('should refuse, naming what is missing, before anything is written', () => {
    // Act
    const reasons = [
      planConversationConvert({ ...base, targetHarness: 'claude' }),
      planConversationConvert({ ...base, source: undefined }),
      planConversationConvert({ ...base, source: { v: 1, home: '/h', identity: 'undiscovered' } }),
      planConversationConvert({ ...base, sourceText: undefined }),
      planConversationConvert({ ...base, targetHome: undefined }),
      planConversationConvert({ ...base, targetVersion: undefined }),
    ].map(plan => (plan.kind === 'unconvertible' ? plan.reason : 'converted'));

    // Assert
    should(reasons).deepEqual([
      'codex-a runs the same harness as this session, so its conversation can be resumed there as it is — move it without converting. Nothing was changed.',
      "Ferretry hasn't matched this session to its conversation yet, so there's nothing to convert. Nothing was changed.",
      "Ferretry hasn't matched this session to its conversation yet, so there's nothing to convert. Nothing was changed.",
      `The conversation file ${CLAUDE_SOURCE.file} is gone, so there's nothing to convert. Nothing was changed.`,
      "codex-a doesn't say where it keeps its conversations, so a converted one can't be written there. Nothing was changed.",
      "Ferretry couldn't tell which Codex version this machine runs, and the converter is tested only on Codex 0.145, 0.156, 0.163, 0.164, 0.165, so it won't write a conversation for it. Nothing was changed.",
    ]);
  });
});

describe("reading a Codex home's model provider", () => {
  it('should read the top-level key in either quoting, and nothing from inside a table', () => {
    // Act + Assert
    should(codexModelProvider('model = "x"\nmodel_provider = "fleet" # chosen\n[model_providers.fleet]\n')).equal(
      'fleet',
    );
    should(codexModelProvider("model_provider = 'single'")).equal('single');
    should(codexModelProvider('[profiles.a]\nmodel_provider = "inside"')).be.undefined();
    should(codexModelProvider('model_provider = ""\nmodel = "y"')).be.undefined();
    should(codexModelProvider(undefined)).be.undefined();
  });
});

describe('deciding whether a target needs its rollout format probed', () => {
  it('should probe only a Codex whose version the converter was not measured on', () => {
    // Act + Assert
    should(needsRolloutFormatProbe('codex', 'codex-cli 0.165.0')).be.false();
    should(needsRolloutFormatProbe('codex', 'codex-cli 0.170.2')).be.true();
    should(needsRolloutFormatProbe('codex', undefined)).be.false();
    should(needsRolloutFormatProbe('claude', '9.9.9')).be.false();
  });
});
