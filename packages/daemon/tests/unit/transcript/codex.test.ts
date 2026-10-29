import { describe, it } from 'bun:test';
import should from 'should';
import fixture from '../../fixtures/transcript/codex.jsonl' with { type: 'text' };
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';

describe('CodexTranscriptParser', () => {
  it('should normalize the synthetic fixture into the common event model', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = subject.parse({ text: fixture, source: 'codex.jsonl', sessionId: 'session-synthetic' });

    // Assert
    should(actual.issues).have.length(0);
    should(actual.events).have.length(13);
    should(actual.observedInputs).containDeep([
      { harness: 'codex', text: 'Please inspect the Codex fixture.', proofKey: 'message-user' },
    ]);
    should(actual.events.map(event => event.kind)).deepEqual([
      'message',
      'attachment',
      'message',
      'reasoning',
      'tool-call',
      'tool-result',
      'usage',
      'settings',
      'turn',
      'turn',
      'compaction',
      'message',
      'error',
    ]);
    should(actual.events[0]).containDeep({ harness: 'codex', sessionId: 'session-synthetic', role: 'user' });
    should(actual.events[1]).containDeep({ attachment: { kind: 'image', uri: 'fixture://image-1' } });
    should(actual.events[2]).containDeep({ kind: 'message', phase: 'commentary' });
    should(actual.events[4]).containDeep({
      call: { id: 'call-question', name: 'request_user_input', questions: [{ question: 'Which synthetic option?' }] },
    });
    should(actual.events[6]).containDeep({
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 3,
        reasoningTokens: 2,
        contextTokens: 25,
        contextWindow: 128000,
      },
    });
    should(actual.events[7]).containDeep({ settings: { model: 'gpt-synthetic', reasoningEffort: 'high' } });
    should(actual.events[10]).containDeep({ kind: 'compaction', role: 'system' });
    should(actual.events[11]).containDeep({ kind: 'message', role: 'system', text: 'Synthetic context summary.' });
    should(actual.events[12]).containDeep({ error: { code: 'fixture_error', recoverable: true } });
  });

  it('should preserve malformed embedded tool arguments and report them', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const input = {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{broken' },
    };

    // Act
    const actual = subject.parseRecord(input, { line: 3 });

    // Assert
    should(actual.events).have.length(1);
    should(actual.events[0]).containDeep({ call: { id: 'call-1', input: '{broken' } });
    should(actual.issues).have.length(1);
    should(actual.issues[0]).containDeep({ code: 'invalid-tool-input', line: 3 });

    for (const argumentsValue of ['not-json', '42']) {
      const malformed = subject.parseRecord({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: `call-${argumentsValue}`,
          name: 'exec_command',
          arguments: argumentsValue,
        },
      });
      should(malformed.events).have.length(1);
      should(malformed.issues).containDeep([{ code: 'invalid-tool-input' }]);
    }
    const primitive = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call-primitive', name: 'exec_command', arguments: 42 },
    });
    should(primitive.events).have.length(1);
    should(primitive.issues).containDeep([{ code: 'invalid-tool-input' }]);
  });

  it('should report response-item drift instead of classifying it by a name suffix', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const input = { type: 'response_item', payload: { type: 'future_magic_call', call_id: 'call-future' } };

    // Act
    const actual = subject.parseRecord(input);

    // Assert
    should(actual.events).have.length(0);
    should(actual.issues).containDeep([
      { code: 'unsupported-record', recordType: 'response_item', itemType: 'future_magic_call' },
    ]);
  });

  it('should reject role-incompatible message blocks and suppress window-only usage', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const records = [
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'not user input' }] },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_text', text: 'not assistant output' }],
        },
      },
    ];

    // Act
    const messages = records.map(record => subject.parseRecord(record));
    const usage = [
      subject.parseRecord({
        type: 'event_msg',
        payload: { type: 'token_count', info: { model_context_window: 128_000 } },
      }),
      subject.parseRecord({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 0, output_tokens: 0 }, model_context_window: 128_000 },
        },
      }),
    ];

    // Assert
    should(messages.every(result => result.events.length === 0)).be.true();
    should(messages.every(result => result.issues[0]?.code === 'unsupported-record')).be.true();
    should(usage.every(result => result.events.length === 0)).be.true();
    should(usage.every(result => result.issues.length === 0)).be.true();
  });

  it('should model aborted turns, local tools, and failed results explicitly', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const inputs = [
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-2', message: 'Synthetic abort.' } },
      { type: 'response_item', payload: { type: 'local_shell_call', call_id: 'call-shell', action: ['pwd'] } },
      {
        type: 'response_item',
        payload: { type: 'local_shell_call_output', call_id: 'call-shell', output: 'failed', status: 'cancelled' },
      },
    ];

    // Act
    const actual = inputs.flatMap(input => subject.parseRecord(input).events);

    // Assert
    should(actual).containDeep([
      { kind: 'turn', state: 'aborted', turnId: 'turn-2' },
      { kind: 'error', error: { message: 'Synthetic abort.' } },
      { kind: 'tool-call', call: { id: 'call-shell', name: 'local_shell', input: ['pwd'] } },
      { kind: 'tool-result', result: { callId: 'call-shell', isError: true } },
    ]);
  });

  it('should return structured issues for malformed known records', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const cases = [
      {},
      { type: 'event_msg', payload: {} },
      { type: 'turn_context', payload: {} },
      { type: 'compacted', payload: {} },
      { type: 'event_msg', payload: { type: 'agent_reasoning' } },
      { type: 'response_item', payload: { role: 'user' } },
      { type: 'response_item', payload: { type: 'message', role: 'invalid', content: [] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'missing-id' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: '   ', name: 'blank-id' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'blank-name', name: '   ' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'missing-id' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: ' ', output: null } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'missing-content' } },
    ];

    // Act
    const actual = cases.map(input => subject.parseRecord(input));

    // Assert
    should(actual.every(result => result.events.length === 0)).be.true();
    should(actual.every(result => result.issues[0]?.code === 'invalid-record')).be.true();
  });

  it('should normalize a top-level error without requiring a nested payload', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = subject.parseRecord({ type: 'error', message: 'Synthetic top-level failure.', code: 'fixture' });

    // Assert
    should(actual.issues).be.empty();
    should(actual.events).containDeep([
      {
        kind: 'error',
        error: { message: 'Synthetic top-level failure.', code: 'fixture', recoverable: true },
      },
    ]);
  });

  it('should retain item metadata, standard file fields, and malformed question diagnostics', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const reasoning = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'reasoning', id: 'reasoning-item', summary: [{ type: 'summary_text', text: 'Synthetic.' }] },
    });
    const file = subject.parseRecord({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'message-item',
        role: 'user',
        content: [{ type: 'input_file', file_id: 'file-synthetic', file_data: 'c3ludGhldGlj' }],
      },
    });
    const question = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call-question', name: 'request_user_input', arguments: '{}' },
    });

    // Assert
    should(reasoning.events).containDeep([{ itemId: 'reasoning-item', messageId: undefined }]);
    should(file.events).containDeep([
      {
        itemId: 'message-item',
        messageId: 'message-item',
        attachment: { kind: 'file', uri: 'file-synthetic', data: 'c3ludGhldGlj' },
      },
    ]);
    should(question.events).containDeep([{ kind: 'tool-call', call: { id: 'call-question' } }]);
    should(question.issues).containDeep([{ code: 'invalid-tool-input' }]);
  });

  it('should reject empty attachments and report malformed question siblings without dropping valid ones', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const attachmentTypes = ['input_image', 'input_audio', 'input_file'];
    const question = {
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call-question',
        name: 'request_user_input',
        arguments: JSON.stringify({
          questions: [
            { question: 'Choose?', options: [{ label: 'Alpha' }, { description: 'missing label' }] },
            { question: 'Malformed options', options: 'not-an-array' },
            { options: [] },
          ],
        }),
      },
    };

    // Act
    const attachments = attachmentTypes.map(type =>
      subject.parseRecord({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type, name: 'empty' }] },
      }),
    );
    const questions = subject.parseRecord(question);

    // Assert
    should(attachments.every(result => result.events.length === 0)).be.true();
    should(attachments.every(result => result.issues[0]?.code === 'invalid-record')).be.true();
    should(attachments.every(result => result.issues[0]?.recordType === 'response_item')).be.true();
    should(attachments.every(result => result.issues[0]?.itemType === 'message')).be.true();
    should(questions.events).containDeep([
      {
        kind: 'tool-call',
        call: {
          questions: [
            { question: 'Choose?', options: [{ label: 'Alpha' }] },
            { question: 'Malformed options', options: [] },
          ],
        },
      },
    ]);
    should(questions.issues).containDeep([
      { code: 'invalid-tool-input', recordType: 'response_item', itemType: 'function_call' },
    ]);
  });

  it('should report an empty generated image without inventing an attachment', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'image_generation_call', id: 'image-empty', revised_prompt: 'Synthetic', result: '   ' },
    });

    // Assert
    should(actual.events.map(event => event.kind)).deepEqual(['tool-call']);
    should(actual.issues).containDeep([
      { code: 'invalid-record', recordType: 'response_item', itemType: 'image_generation_call' },
    ]);
  });

  it('should normalize current search, image, and audio shapes explicitly', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const search = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'tool_search_call', id: 'search-item', arguments: { query: 'synthetic' } },
    });
    const image = subject.parseRecord({
      type: 'response_item',
      payload: {
        type: 'image_generation_call',
        id: 'image-item',
        revised_prompt: 'A synthetic diagram.',
        result: 'c3ludGhldGljLWltYWdl',
      },
    });
    const audio = subject.parseRecord({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', audio_url: 'fixture://audio', media_type: 'audio/wav' }],
      },
    });
    const incomplete = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'tool_call_output', call_id: 'call-incomplete', output: 'partial', status: 'incomplete' },
    });

    // Assert
    should(search.events).containDeep([
      { kind: 'tool-call', call: { id: 'search-item', name: 'tool_search', input: { query: 'synthetic' } } },
    ]);
    should(image.events).containDeep([
      {
        kind: 'tool-call',
        call: { id: 'image-item', name: 'image_generation', input: { revisedPrompt: 'A synthetic diagram.' } },
      },
      { kind: 'attachment', attachment: { kind: 'image', data: 'c3ludGhldGljLWltYWdl' } },
    ]);
    should(audio.events).containDeep([
      { kind: 'attachment', attachment: { kind: 'audio', uri: 'fixture://audio', mediaType: 'audio/wav' } },
    ]);
    should(incomplete.events).containDeep([{ kind: 'tool-result', result: { isError: true } }]);
  });

  it('should name each built-in tool call by its item type when the payload names none', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const call = (type: string, extra: Record<string, unknown>) =>
      subject.parseRecord({ type: 'response_item', payload: { type, call_id: `call-${type}`, ...extra } });

    // Act
    const actual = [
      call('web_search_call', { action: { query: 'synthetic' } }),
      call('computer_call', { action: { type: 'screenshot' } }),
      call('apply_patch_call', { input: '*** Begin Patch' }),
      call('mcp_call', { execution: { server: 'fixture' } }),
    ];

    // Assert
    should(actual.flatMap(result => result.issues)).be.empty();
    should(actual.flatMap(result => result.events)).containDeep([
      { kind: 'tool-call', call: { id: 'call-web_search_call', name: 'web_search', input: { query: 'synthetic' } } },
      { kind: 'tool-call', call: { id: 'call-computer_call', name: 'computer', input: { type: 'screenshot' } } },
      { kind: 'tool-call', call: { id: 'call-apply_patch_call', name: 'apply_patch', input: '*** Begin Patch' } },
      {
        kind: 'tool-call',
        call: { id: 'call-mcp_call', name: 'mcp', input: { execution: { server: 'fixture' } } },
      },
    ]);
  });

  it('should keep a tool call that carries no arguments at all, with an empty input', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'computer_call', call_id: 'call-bare' },
    });

    // Assert
    should(actual.issues).be.empty();
    should(actual.events).containDeep([{ kind: 'tool-call', call: { id: 'call-bare', name: 'computer', input: {} } }]);
  });

  it('should refuse a generic tool call that names no tool, since its type cannot name one', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'tool_call', call_id: 'call-nameless' },
    });

    // Assert
    should(actual.events).be.empty();
    should(actual.issues).containDeep([
      { code: 'invalid-record', message: 'Codex tool call lacks id or name', itemType: 'tool_call' },
    ]);
  });

  it('should read an error message from whichever field the harness used', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = [
      subject.parseRecord({ type: 'error', text: 'Plain text failure.' }),
      subject.parseRecord({ type: 'error', error: { message: 'Nested message.', type: 'rate_limit' } }),
      subject.parseRecord({ type: 'event_msg', payload: { type: 'stream_error', error: { error: 'Nested error.' } } }),
    ];

    // Assert
    should(actual.flatMap(result => result.issues)).be.empty();
    should(actual.flatMap(result => result.events)).containDeep([
      { kind: 'error', error: { message: 'Plain text failure.', recoverable: true } },
      { kind: 'error', error: { message: 'Nested message.', code: 'rate_limit', recoverable: true } },
      { kind: 'error', error: { message: 'Nested error.', recoverable: true } },
    ]);
  });

  it('should report an error record that carries no message anywhere', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = [
      subject.parseRecord({ type: 'error', code: 'only_a_code' }),
      subject.parseRecord({ type: 'event_msg', payload: { type: 'error' } }),
    ];

    // Assert
    should(actual.flatMap(result => result.events)).be.empty();
    should(actual.map(result => result.issues)).containDeep([
      [{ code: 'invalid-record', message: 'Codex error record has no message', recordType: 'error' }],
      [
        {
          code: 'invalid-record',
          message: 'Codex error record has no message',
          recordType: 'event_msg',
          itemType: 'error',
        },
      ],
    ]);
  });

  it('should take message content that is a bare string, alone or inside an array', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const message = (content: unknown) =>
      subject.parseRecord({ type: 'response_item', payload: { type: 'message', role: 'assistant', content } });

    // Act
    const alone = message('Bare string reply.');
    const inArray = message(['First.', { type: 'output_text', text: 'Second.' }]);

    // Assert
    should(alone.issues).be.empty();
    should(alone.events).containDeep([
      { kind: 'message', role: 'assistant', text: 'Bare string reply.', blockIndex: 0 },
    ]);
    should(inArray.events).containDeep([
      { kind: 'message', text: 'First.', blockIndex: 0 },
      { kind: 'message', text: 'Second.', blockIndex: 1 },
    ]);
  });

  it('should report a reasoning item whose summary and content hold no text', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], content: [] },
    });

    // Assert
    should(actual.events).be.empty();
    should(actual.issues).containDeep([
      { code: 'invalid-record', message: 'Codex reasoning item has no text', itemType: 'reasoning' },
    ]);
  });

  it('should preserve canonical variants while suppressing mirrored chat records', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const reasoning = subject.parseRecord({
      type: 'event_msg',
      payload: { type: 'agent_reasoning', text: 'Readable legacy reasoning.' },
    });
    const mirrors = ['user_message', 'agent_message'].map(type =>
      subject.parseRecord({ type: 'event_msg', payload: { type, message: 'Mirrored chat.' } }),
    );
    const customTool = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call-custom', name: 'apply_patch', input: 'synthetic patch' },
    });
    const searchOutput = subject.parseRecord({
      type: 'response_item',
      payload: { type: 'tool_search_output', call_id: 'call-search', tools: [{ name: 'synthetic' }], status: 'failed' },
    });
    const settings = subject.parseRecord({
      type: 'turn_context',
      payload: { model: 'gpt-synthetic', effort: 'xhigh', turn_id: 'turn-settings' },
    });

    // Assert
    should(reasoning.events).containDeep([{ kind: 'reasoning', text: 'Readable legacy reasoning.' }]);
    should(mirrors.every(result => result.events.length === 0 && result.issues.length === 0)).be.true();
    should(customTool.events).containDeep([
      { kind: 'tool-call', call: { id: 'call-custom', name: 'apply_patch', input: 'synthetic patch' } },
    ]);
    should(searchOutput.events).containDeep([
      {
        kind: 'tool-result',
        result: { callId: 'call-search', content: [{ name: 'synthetic' }], isError: true },
      },
    ]);
    should(settings.events).containDeep([
      { kind: 'settings', turnId: 'turn-settings', settings: { model: 'gpt-synthetic', reasoningEffort: 'xhigh' } },
    ]);
  });
});
