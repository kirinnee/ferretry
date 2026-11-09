/**
 * The Codex rollout parser, record by record: each line a rollout can carry is read into the events the turn watch and
 * the transcript views share, or into an issue that says what was wrong with it. A record that is not Codex's to read
 * is `recognized: false`, never an issue.
 */
import { describe, expect, test } from 'bun:test';
import { CodexTranscriptParser } from '../../daemon/lib/transcript/codex.ts';
import {
  normalizeTranscriptQuestions,
  transcriptJsonValue,
  transcriptNumber,
  transcriptText,
} from '../../daemon/lib/transcript/value.ts';

const AT = '2026-11-08T10:00:00.000Z';
const parser = new CodexTranscriptParser();
const parse = (record: unknown) =>
  parser.parseRecord(record, { source: 'rollout.jsonl', line: 7, sessionId: 'ctx-s1' });
const item = (payload: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  parse({ timestamp: AT, type: 'response_item', payload, ...more });
const event = (payload: Record<string, unknown>) => parse({ timestamp: AT, type: 'event_msg', payload });
const messages = (result: ReturnType<typeof parse>) => result.issues.map(issue => issue.message);

describe('a record that is not a usable record', () => {
  test('is an issue, not a crash: no object, no type, no item type on an event', () => {
    expect(messages(parse(5))).toEqual(['Codex record must be an object']);
    expect(messages(parse([]))).toEqual(['Codex record must be an object']);
    expect(messages(parse({ payload: {} }))).toEqual(['Codex record has no type']);
    expect(messages(parse({ type: 'event_msg', payload: {} }))).toEqual(['Codex event message has no item type']);
    expect(parse(5)).toMatchObject({ events: [], recognized: true });
    expect(parse({ type: 'event_msg' }).issues[0]).toMatchObject({
      code: 'invalid-record',
      recoverable: true,
      source: 'rollout.jsonl',
      line: 7,
      recordType: 'event_msg',
    });
  });

  test('is left alone, recognized: false, when it is a kind of record the Codex parser does not read', () => {
    expect(parse({ type: 'session_meta', payload: { id: 's1' } })).toEqual({
      events: [],
      issues: [],
      recognized: false,
    });
  });

  test('says nothing for the user and agent messages the response items already carry', () => {
    for (const type of ['user_message', 'agent_message'])
      expect(event({ type, message: 'hello' })).toEqual({ events: [], issues: [], recognized: true });
  });
});

describe('the settings a turn runs under', () => {
  test('reads the model, the effort and the service tier off a turn context', () => {
    const result = parse({
      timestamp: AT,
      type: 'turn_context',
      payload: { model: 'gpt-6.1-sol', reasoning_effort: 'high', service_tier: 'fast', turn_id: 't1' },
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: 'settings',
        harness: 'codex',
        role: 'system',
        sessionId: 'ctx-s1',
        turnId: 't1',
        timestamp: AT,
        settings: { model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'fast' },
      }),
    ]);
  });

  test('reads an applied thread setting from the payload, or from the record itself, and takes effort for the effort', () => {
    const fromPayload = parse({
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', effort: 'low' } },
    });
    expect(fromPayload.events[0]).toMatchObject({ settings: { model: 'gpt-6.1-sol', reasoningEffort: 'low' } });
    const fromRecord = parse({
      type: 'event_msg',
      payload: { type: 'thread_settings_applied' },
      thread_settings: { model: 'gpt-6.1-sol' },
    });
    expect(fromRecord.events[0]).toMatchObject({ settings: { model: 'gpt-6.1-sol' } });
    expect(fromRecord.events[0]).not.toHaveProperty('settings.serviceTier');
  });

  test('is an issue when the record names no setting at all', () => {
    expect(messages(parse({ type: 'turn_context', payload: {} }))).toEqual(['Codex settings record has no settings']);
    expect(messages(event({ type: 'thread_settings_applied' }))).toEqual(['Codex settings record has no settings']);
  });
});

describe('the boundaries of a turn', () => {
  test('a turn that started, and one that completed without a failure, are boundaries and nothing more', () => {
    expect(event({ type: 'task_started' }).events.map(each => [each.kind, 'state' in each && each.state])).toEqual([
      ['turn', 'started'],
    ]);
    expect(event({ type: 'task_complete' }).events.map(each => [each.kind, 'state' in each && each.state])).toEqual([
      ['turn', 'completed'],
    ]);
  });

  test('a turn that completed on a failure the provider reported also carries the failure, with its code', () => {
    const result = event({
      type: 'task_complete',
      error: { message: 'You hit your usage limit.', codex_error_info: 'usage_limit_exceeded' },
    });
    expect(result.events.map(each => each.kind)).toEqual(['turn', 'error']);
    expect(result.events[1]).toMatchObject({
      error: { message: 'You hit your usage limit.', code: 'usage_limit_exceeded', recoverable: true },
    });
  });

  test('an aborted turn carries the reason when it gave one, and is only a boundary when it did not', () => {
    const aborted = event({ type: 'turn_aborted', message: 'interrupted', code: 'interrupted' });
    expect(aborted.events.map(each => each.kind)).toEqual(['turn', 'error']);
    expect(aborted.events[1]).toMatchObject({ error: { message: 'interrupted', code: 'interrupted' } });
    expect(event({ type: 'turn_aborted' }).events.map(each => each.kind)).toEqual(['turn']);
    expect(event({ type: 'task_complete', error: 'oops' }).events.map(each => each.kind)).toEqual(['turn']);
  });
});

describe('what the model reasoned, spent, and compacted', () => {
  test('agent reasoning is the model’s reasoning text, and an issue without text', () => {
    expect(event({ type: 'agent_reasoning', text: 'thinking it over' }).events[0]).toMatchObject({
      kind: 'reasoning',
      role: 'assistant',
      text: 'thinking it over',
      format: 'reasoning',
    });
    expect(messages(event({ type: 'agent_reasoning' }))).toEqual(['Codex reasoning record has no text']);
  });

  test('a token count is the usage of the last call, with the session total when the rollout keeps one', () => {
    const result = event({
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 100,
          output_tokens: 20,
          cached_input_tokens: 40,
          cache_write_input_tokens: 5,
          reasoning_output_tokens: 8,
        },
        total_token_usage: { total_tokens: 900 },
        model_context_window: 200_000,
      },
    });
    expect(result.events[0]).toMatchObject({
      kind: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        cacheCreationInputTokens: 5,
        reasoningTokens: 8,
        contextTokens: 120,
        contextWindow: 200_000,
        sessionTotalTokens: 900,
      },
    });
  });

  test('a token count adds the context from what it has, and leaves out the session total it does not have', () => {
    const onlyOutput = event({ type: 'token_count', info: { last_token_usage: { output_tokens: 3 } } });
    expect(onlyOutput.events[0]).toMatchObject({ usage: { outputTokens: 3, contextTokens: 3 } });
    expect(onlyOutput.events[0]).not.toHaveProperty('usage.sessionTotalTokens');
    const onlyCache = event({ type: 'token_count', info: { last_token_usage: { cached_input_tokens: 9 } } });
    expect(onlyCache.events[0]).toMatchObject({ usage: { cachedInputTokens: 9 } });
    expect(onlyCache.events[0]).toMatchObject({ usage: { contextTokens: undefined } });
  });

  test('a token count that spent nothing, or says nothing, is no event', () => {
    expect(event({ type: 'token_count' }).events).toEqual([]);
    expect(event({ type: 'token_count', info: { last_token_usage: {} } }).events).toEqual([]);
    expect(
      event({ type: 'token_count', info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } } }).events,
    ).toEqual([]);
    expect(event({ type: 'token_count', info: { last_token_usage: { input_tokens: -4 } } }).events).toEqual([]);
  });

  test('a compaction is its boundary and its summary, and an issue without a summary', () => {
    const result = parse({ timestamp: AT, type: 'compacted', payload: { message: 'we agreed on the plan' } });
    expect(result.events.map(each => each.kind)).toEqual(['compaction', 'message']);
    expect(result.events[1]).toMatchObject({ role: 'system', text: 'we agreed on the plan' });
    expect(messages(parse({ type: 'compacted', payload: {} }))).toEqual(['Codex compaction record has no summary']);
  });
});

describe('errors', () => {
  test('an error event, a stream error and an error record are all errors, read from wherever they keep the words', () => {
    expect(event({ type: 'error', message: 'boom', code: 'E1' }).events[0]).toMatchObject({
      kind: 'error',
      error: { message: 'boom', code: 'E1', recoverable: true },
    });
    expect(
      event({ type: 'stream_error', text: 'stream dropped', error: { type: 'overloaded' } }).events[0],
    ).toMatchObject({
      error: { message: 'stream dropped', code: 'overloaded' },
    });
    expect(parse({ type: 'error', error: { message: 'nested words', code: 'N1' } }).events[0]).toMatchObject({
      error: { message: 'nested words', code: 'N1' },
    });
    expect(
      parse({ type: 'error', error: { error: 'words in error', codex_error_info: 'info-code' } }).events[0],
    ).toMatchObject({
      error: { message: 'words in error', code: 'info-code' },
    });
  });

  test('an error with no words is an issue', () => {
    expect(messages(event({ type: 'error' }))).toEqual(['Codex error record has no message']);
    expect(messages(parse({ type: 'error' }))).toEqual(['Codex error record has no message']);
  });
});

describe('messages', () => {
  test('a message with an invalid role is an issue, and a response item with no type is one too', () => {
    expect(messages(item({ type: 'message', role: 'robot', content: 'x' }))).toEqual([
      'Codex message has an invalid role',
    ]);
    expect(messages(item({ role: 'user' }))).toEqual(['Codex response item has no type']);
  });

  test('reads text blocks by the role that wrote them, one event per block, with the block’s place', () => {
    const user = item({
      type: 'message',
      id: 'm1',
      role: 'user',
      turn_id: 't1',
      content: [
        'plain string',
        { type: 'input_text', text: 'typed' },
        { text: 'untyped' },
        { type: 'text', text: 'texty' },
      ],
    });
    expect(user.issues).toEqual([]);
    expect(user.events.map(each => ('text' in each ? each.text : undefined))).toEqual([
      'plain string',
      'typed',
      'untyped',
      'texty',
    ]);
    expect(user.events.map(each => ('blockIndex' in each ? each.blockIndex : undefined))).toEqual([0, 1, 2, 3]);
    expect(user.events[1]).toMatchObject({ role: 'user', messageId: 'm1', itemId: 'm1', turnId: 't1' });
    const assistant = item({
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', output_text: 'said' },
        { type: 'refusal', text: 'cannot' },
      ],
    });
    expect(assistant.events.map(each => ('text' in each ? each.text : undefined))).toEqual(['said', 'cannot']);
  });

  test('content that is a single string is one message', () => {
    expect(item({ type: 'message', role: 'developer', content: 'be careful' }).events[0]).toMatchObject({
      kind: 'message',
      role: 'developer',
      text: 'be careful',
    });
  });

  test('a block type the role does not write is unsupported, and a block that is no object is invalid', () => {
    const wrongRole = item({ type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'x' }] });
    expect(wrongRole.events).toEqual([]);
    expect(wrongRole.issues[0]).toMatchObject({
      code: 'unsupported-record',
      message: 'Codex message block type is not supported',
      blockType: 'input_text',
    });
    const notObject = item({ type: 'message', role: 'user', content: [7] });
    expect(notObject.issues[0]).toMatchObject({
      code: 'invalid-record',
      message: 'Codex message block is not an object',
    });
    expect(messages(item({ type: 'message', role: 'user' }))).toEqual(['Codex message block is not an object']);
  });

  test('a message with an empty content list is an issue', () => {
    expect(messages(item({ type: 'message', role: 'user', content: [] }))).toEqual(['Codex message has no content']);
  });

  test('reads each kind of attachment by where it keeps its bytes or address, and refuses one that keeps neither', () => {
    const kinds = item({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'https://x.test/a.png', name: 'a.png', media_type: 'image/png' },
        { type: 'image', source: { data: 'QUJD', media_type: 'image/jpeg' } },
        { type: 'input_audio', audio_url: 'https://x.test/a.wav', mime_type: 'audio/wav' },
        { type: 'audio', data: 'QUJD' },
        { type: 'input_file', file_url: 'https://x.test/a.pdf', filename: 'a.pdf' },
        { type: 'file', file_id: 'file-1' },
        { type: 'file', url: 'https://x.test/b.bin' },
        { type: 'file', file_data: 'REVG' },
        { type: 'file', source: { url: 'https://x.test/c.bin' } },
      ],
    });
    expect(kinds.issues).toEqual([]);
    expect(kinds.events.map(each => ('attachment' in each ? each.attachment.kind : undefined))).toEqual([
      'image',
      'image',
      'audio',
      'audio',
      'file',
      'file',
      'file',
      'file',
      'file',
    ]);
    expect(kinds.events[0]).toMatchObject({
      attachment: { kind: 'image', name: 'a.png', mediaType: 'image/png', uri: 'https://x.test/a.png' },
    });
    expect(kinds.events[1]).toMatchObject({ attachment: { data: 'QUJD', mediaType: 'image/jpeg' } });
    const empty = item({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: '   ' }, { type: 'file' }],
    });
    expect(empty.events).toEqual([]);
    expect(empty.issues.map(issue => issue.message)).toEqual([
      'Codex attachment block has no usable content',
      'Codex attachment block has no usable content',
    ]);
  });
});

describe('reasoning items', () => {
  test('are the summary and the content, text joined by lines, and an issue without any', () => {
    const result = item({
      type: 'reasoning',
      summary: [{ text: 'first thought' }],
      content: [{ output_text: 'second thought' }, 'third'],
    });
    expect(result.events[0]).toMatchObject({ kind: 'reasoning', text: 'first thought\nsecond thought\nthird' });
    expect(messages(item({ type: 'reasoning' }))).toEqual(['Codex reasoning item has no text']);
    expect(messages(item({ type: 'reasoning', summary: 'not a list', content: [{ type: 'x' }] }))).toEqual([
      'Codex reasoning item has no text',
    ]);
  });
});

describe('tool calls', () => {
  test('read the call id and name, and the arguments as the JSON they were sent as', () => {
    const result = item({
      type: 'function_call',
      call_id: 'call-1',
      name: 'shell',
      arguments: '{"command":["ls","-la"]}',
    });
    expect(result.issues).toEqual([]);
    expect(result.events[0]).toMatchObject({
      kind: 'tool-call',
      role: 'assistant',
      call: { id: 'call-1', name: 'shell', input: { command: ['ls', '-la'] } },
    });
    const byId = item({ type: 'custom_tool_call', id: 'call-2', name: 'apply_patch', arguments: { patch: 'x' } });
    expect(byId.events[0]).toMatchObject({ call: { id: 'call-2', input: { patch: 'x' } } });
  });

  test('keep malformed arguments as the text they came as, and say so', () => {
    for (const arguments_ of ['{"command": [', '42', 'null', 7, null]) {
      const result = item({ type: 'function_call', call_id: 'c', name: 'shell', arguments: arguments_ });
      expect(result.issues.map(issue => [issue.code, issue.message])).toEqual([
        ['invalid-tool-input', 'Codex tool arguments contain malformed embedded JSON'],
      ]);
      expect(result.events).toHaveLength(1);
    }
    const raw = item({ type: 'function_call', call_id: 'c', name: 'shell', arguments: '{"command": [' });
    expect(raw.events[0]).toMatchObject({ call: { input: '{"command": [' } });
  });

  test('take their input from input, action, execution or the revised prompt when there are no arguments', () => {
    const input = (payload: Record<string, unknown>) =>
      (item({ type: 'tool_call', call_id: 'c', name: 'n', ...payload }).events[0] as { call: { input: unknown } }).call
        .input;
    expect(input({ input: { a: 1 } })).toEqual({ a: 1 });
    expect(input({ action: { type: 'click' } })).toEqual({ type: 'click' });
    expect(input({ execution: 'client' })).toEqual({ execution: 'client' });
    expect(input({ revised_prompt: 'a cat' })).toEqual({ revisedPrompt: 'a cat' });
    expect(input({})).toEqual({});
  });

  test('name themselves for the tool they call when they carry no name', () => {
    const named = (type: string) =>
      (item({ type, id: 'c' }).events[0] as { call: { name: string } } | undefined)?.call.name;
    expect(named('local_shell_call')).toBe('local_shell');
    expect(named('web_search_call')).toBe('web_search');
    expect(named('computer_call')).toBe('computer');
    expect(named('apply_patch_call')).toBe('apply_patch');
    expect(named('mcp_call')).toBe('mcp');
    expect(named('tool_search_call')).toBe('tool_search');
    expect(named('image_generation_call')).toBe('image_generation');
  });

  test('without an id or a name are an issue, and no call', () => {
    for (const payload of [
      { type: 'function_call', name: 'shell' },
      { type: 'function_call', call_id: '  ', name: 'shell' },
      { type: 'function_call', call_id: 'c' },
      { type: 'function_call', call_id: 'c', name: '   ' },
      { type: 'tool_call', call_id: 'c' },
    ]) {
      const result = item(payload);
      expect(result.events).toEqual([]);
      expect(messages(result)).toEqual(['Codex tool call lacks id or name']);
    }
  });

  test('that ask the person a question carry the questions, and say what is wrong with them', () => {
    const good = item({
      type: 'function_call',
      call_id: 'q1',
      name: 'request_user_input',
      arguments: JSON.stringify({
        questions: [
          {
            question: 'Which one?',
            header: 'Pick',
            multiSelect: true,
            options: [{ label: 'A', description: 'first' }, { label: 'B' }],
          },
        ],
      }),
    });
    expect(good.issues).toEqual([]);
    expect(good.events[0]).toMatchObject({
      call: {
        questions: [
          {
            question: 'Which one?',
            header: 'Pick',
            multiple: true,
            options: [{ label: 'A', description: 'first' }, { label: 'B' }],
          },
        ],
      },
    });
    const none = item({ type: 'function_call', call_id: 'q2', name: 'AskUserQuestion', arguments: '{"questions":[]}' });
    expect(messages(none)).toEqual(['Codex question tool input has no valid questions']);
    expect(none.events[0]).not.toHaveProperty('call.questions');
    const partial = item({
      type: 'function_call',
      call_id: 'q3',
      name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{ question: 'Fine?', options: [{ nolabel: true }] }, { nothing: 1 }] }),
    });
    expect(messages(partial)).toEqual(['Codex question tool input contains malformed questions or options']);
    expect(partial.events[0]).toMatchObject({ call: { questions: [{ question: 'Fine?', options: [] }] } });
  });

  test('that generate an image carry the image as an attachment, and an issue when it is blank', () => {
    const made = item({ type: 'image_generation_call', id: 'img1', result: 'QUJDRA==', revised_prompt: 'a cat' });
    expect(made.events.map(each => each.kind)).toEqual(['tool-call', 'attachment']);
    expect(made.events[1]).toMatchObject({ attachment: { kind: 'image', data: 'QUJDRA==' } });
    const blank = item({ type: 'image_generation_call', id: 'img2', result: '   ' });
    expect(blank.events.map(each => each.kind)).toEqual(['tool-call']);
    expect(messages(blank)).toEqual(['Codex generated image has no usable content']);
    const pending = item({ type: 'image_generation_call', id: 'img3' });
    expect(pending.events.map(each => each.kind)).toEqual(['tool-call']);
    expect(pending.issues).toEqual([]);
  });
});

describe('tool results', () => {
  const result = (payload: Record<string, unknown>) =>
    item({ type: 'function_call_output', call_id: 'call-1', ...payload });

  test('carry the output against the call it answers, as JSON and as text', () => {
    const answered = result({ output: 'total 0' });
    expect(answered.events[0]).toMatchObject({
      kind: 'tool-result',
      role: 'tool',
      result: { callId: 'call-1', content: 'total 0', text: 'total 0', isError: false },
    });
    const structured = result({ output: { exit: 0 } });
    expect(structured.events[0]).toMatchObject({ result: { content: { exit: 0 }, isError: false } });
    expect(structured.events[0]).not.toHaveProperty('result.text');
  });

  test('take the content from result, tools or content when there is no output, and the call id from id', () => {
    const contentOf = (payload: Record<string, unknown>) =>
      (item({ type: 'tool_search_output', ...payload }).events[0] as { result: { callId: string; content: unknown } })
        .result;
    expect(contentOf({ call_id: 'c1', result: 'from result' })).toMatchObject({
      callId: 'c1',
      content: 'from result',
    });
    expect(contentOf({ id: 'c2', tools: [{ text: 'a tool' }] })).toMatchObject({ callId: 'c2' });
    expect(contentOf({ id: 'c3', content: 'from content' })).toMatchObject({ content: 'from content' });
    expect(contentOf({ id: 'c4', output: null })).toMatchObject({ content: null });
  });

  test('are an error when the call failed, however the rollout says so', () => {
    const failed = (payload: Record<string, unknown>) =>
      (result({ output: 'x', ...payload }).events[0] as { result: { isError: boolean } }).result.isError;
    expect(failed({})).toBe(false);
    expect(failed({ is_error: true })).toBe(true);
    expect(failed({ isError: true })).toBe(true);
    expect(failed({ success: false })).toBe(true);
    for (const status of ['failed', 'ERROR', 'incomplete', 'Cancelled']) expect(failed({ status })).toBe(true);
    expect(failed({ status: 'completed', success: true })).toBe(false);
  });

  test('read every kind of result the rollout names', () => {
    for (const type of [
      'function_call_output',
      'custom_tool_call_output',
      'local_shell_call_output',
      'web_search_call_output',
      'computer_call_output',
      'apply_patch_call_output',
      'mcp_call_output',
      'tool_call_output',
      'tool_search_output',
    ])
      expect(item({ type, call_id: 'c', output: 'ok' }).events.map(each => each.kind)).toEqual(['tool-result']);
  });

  test('without a call id, or without any content, are an issue', () => {
    expect(messages(item({ type: 'function_call_output', output: 'x' }))).toEqual(['Codex tool result lacks call id']);
    expect(messages(item({ type: 'function_call_output', call_id: ' ', output: 'x' }))).toEqual([
      'Codex tool result lacks call id',
    ]);
    expect(messages(item({ type: 'function_call_output', call_id: 'c' }))).toEqual([
      'Codex tool result has no content',
    ]);
  });
});

describe('a response item the parser does not know', () => {
  test('is unsupported, with the type named, and is not dropped silently', () => {
    const result = item({ type: 'telepathy' });
    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'unsupported-record',
        message: 'Codex response item type is not supported',
        recordType: 'response_item',
        itemType: 'telepathy',
      }),
    ]);
  });
});

describe('the plain values a transcript is made of', () => {
  test('numbers are the finite non-negative ones', () => {
    expect(transcriptNumber(3)).toBe(3);
    expect(transcriptNumber(0)).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3', null])
      expect(transcriptNumber(bad)).toBeUndefined();
  });

  test('JSON keeps what is JSON, turns the rest to null, drops undefined keys and cuts a value that contains itself', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    const inherited = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as unknown;
    expect(
      transcriptJsonValue({
        text: 's',
        yes: true,
        none: null,
        big: Number.POSITIVE_INFINITY,
        fn: () => 1,
        skipped: undefined,
        list: [1, undefined, Number.NaN, { deep: 'x' }],
        loop,
      }),
    ).toEqual({
      text: 's',
      yes: true,
      none: null,
      big: null,
      fn: null,
      list: [1, null, null, { deep: 'x' }],
      loop: { name: 'loop', self: null },
    });
    const normalized = transcriptJsonValue(inherited) as Record<string, unknown>;
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.keys(normalized).sort()).toEqual(['__proto__', 'ok']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const shared = { a: 1 };
    expect(transcriptJsonValue([shared, shared])).toEqual([{ a: 1 }, { a: 1 }]);
  });

  test('text is a string, the text of one block, or the lines of a list’s strings and blocks', () => {
    expect(transcriptText('plain')).toBe('plain');
    expect(transcriptText({ text: 'one' })).toBe('one');
    expect(transcriptText({ output_text: 'two' })).toBe('two');
    expect(transcriptText(['a', { text: 'b' }, { output_text: 'c' }, { type: 'image' }, 7])).toBe('a\nb\nc');
    expect(transcriptText([{ type: 'image' }])).toBeUndefined();
    expect(transcriptText([])).toBeUndefined();
    expect(transcriptText(7)).toBeUndefined();
    expect(transcriptText(null)).toBeUndefined();
  });

  test('questions are read with their options, and every entry that is not one is counted, not guessed at', () => {
    expect(normalizeTranscriptQuestions({ questions: [] })).toEqual({ questions: [], invalidEntries: 0 });
    expect(normalizeTranscriptQuestions({})).toEqual({ questions: [], invalidEntries: 0 });
    expect(normalizeTranscriptQuestions({ questions: 'which?' })).toEqual({ questions: [], invalidEntries: 1 });
    expect(normalizeTranscriptQuestions('nonsense')).toEqual({ questions: [], invalidEntries: 0 });
    const read = normalizeTranscriptQuestions({
      questions: [
        { question: 'One?', multi_select: true, options: [{ label: 'x', preview: 'p' }, { label: 7 }] },
        { question: 'Two?', options: 'a b c' },
        { header: 'no question' },
        'not an object',
      ],
    });
    expect(read.invalidEntries).toBe(4);
    expect(read.questions).toEqual([
      {
        question: 'One?',
        header: undefined,
        multiple: true,
        options: [{ label: 'x', description: undefined, preview: 'p' }],
      },
      { question: 'Two?', header: undefined, multiple: false, options: [] },
    ]);
  });
});
