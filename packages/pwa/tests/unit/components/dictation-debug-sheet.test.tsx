import { describe, expect, it } from 'bun:test';
import { type CleanupTrace, TRACE_REDACTED } from '@ferretry/protocol';
import { DictationDebugSheet } from '../../../src/components/dictation-debug-sheet.tsx';
import type { ClipboardWriter } from '../../../src/features/onboarding/copy-button.tsx';
import type { DictationDebugRecord } from '../../../src/lib/stt/dictation-debug.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const FAKE_AT = Date.UTC(2026, 9, 21, 9, 30, 15);

const cleanedTrace: CleanupTrace = {
  via: 'device',
  provider: 'groq',
  model: 'example-model',
  host: 'api.example.invalid',
  startedAt: FAKE_AT,
  totalMs: 412.4,
  outcome: 'cleaned',
  finalText: 'Fix the bug.',
  attempts: [
    {
      withContext: true,
      request: {
        host: 'api.example.invalid',
        path: '/v1/chat/completions',
        headers: { authorization: TRACE_REDACTED, 'content-type': 'application/json' },
        params: { model: 'example-model', temperature: 0 },
        messages: [
          { role: 'system', content: 'You tidy dictated text.' },
          { role: 'user', content: 'um fix the bug' },
        ],
      },
      status: 200,
      response: {
        raw: '{"choices":[]}',
        content: '<think>hm</think>Fix the bug.',
        reasoning: 'it said um',
        finishReason: 'stop',
        usage: { promptTokens: 40, completionTokens: 8, totalTokens: 48, reasoningTokens: 3 },
        steps: [{ step: 'reasoning_stripped', detail: 'removed 14 characters' }, { step: 'guard_passed' }],
        verdict: 'cleaned',
      },
      timings: { firstByteMs: 120.2, totalMs: 410 },
    },
  ],
};

const failedTrace: CleanupTrace = {
  via: 'daemon',
  provider: 'cerebras',
  model: 'other-model',
  host: 'daemon.example.invalid',
  totalMs: 900,
  outcome: 'failed',
  failure: { message: 'the provider refused' },
  attempts: [
    {
      withContext: true,
      request: {
        host: 'daemon.example.invalid',
        path: '/v1/stt/enhance',
        headers: {},
        params: {},
        messages: [{ role: 'user', content: 'raw words' }],
      },
      status: 429,
      errorBody: 'slow down',
      failure: 'rate limited',
      timings: { totalMs: 300 },
    },
    {
      withContext: false,
      request: {
        host: 'daemon.example.invalid',
        path: '/v1/stt/enhance',
        headers: {},
        params: {},
        messages: [{ role: 'user', content: 'raw words' }],
      },
      response: {
        raw: '{}',
        steps: [{ step: 'guard_rejected' }, { step: 'kept_raw', detail: 'kept as spoken' }],
        verdict: 'kept_raw',
        reason: 'the reply added words',
      },
      timings: { totalMs: 500 },
    },
  ],
};

const failedWithCode: CleanupTrace = {
  ...failedTrace,
  failure: { code: 'enhancement-timeout', message: 'timed out' },
  attempts: [failedTrace.attempts[0] as CleanupTrace['attempts'][number]],
};

const record = (trace: CleanupTrace): DictationDebugRecord => ({ id: 'debug-1', at: FAKE_AT, trace });

const showSheet = async (trace: CleanupTrace, copy: ClipboardWriter = async () => undefined) => {
  let closed = 0;
  const view = await mount(
    <DictationDebugSheet
      record={record(trace)}
      copy={copy}
      onClose={() => {
        closed += 1;
      }}
    />,
  );
  return { view, closed: () => closed };
};

const section = (container: HTMLElement, title: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-debug-section="${title}"]`), `the ${title} section`);
const toggle = (container: HTMLElement, title: string): HTMLButtonElement =>
  must(section(container, title).querySelector<HTMLButtonElement>('button[aria-expanded]'), `${title} toggle`);
const copyButton = (container: HTMLElement, title: string): HTMLButtonElement =>
  must(section(container, title).querySelector<HTMLButtonElement>('button[data-copy-state]'), `${title} copy`);
const open = async (container: HTMLElement, title: string): Promise<void> => {
  await interact(() => toggle(container, title).click());
};

const timed: DictationDebugRecord = {
  ...record(cleanedTrace),
  timeline: {
    totalMs: 1_200,
    speech: { engine: 'parakeet', totalMs: 500 },
    cleanup: { provider: 'groq', via: 'device', outcome: 'cleaned', attempts: 1, totalMs: 600, firstByteMs: 120 },
    insertMs: 4,
  },
};

describe('<DictationDebugSheet>', () => {
  it('shows how long each stage took, with the slowest named, when the record carries a timeline', async () => {
    const view = await mount(
      <DictationDebugSheet record={timed} copy={async () => undefined} onClose={() => undefined} />,
    );
    const timeline = section(view.container, 'Timeline');
    expect(toggle(view.container, 'Timeline').getAttribute('aria-expanded')).toBe('true');
    expect(timeline.querySelector('[data-timeline-bar]')).not.toBeNull();
    expect(timeline.textContent).toContain('Cleanup 600 ms · slowest');
    expect(timeline.textContent).toContain('Stop to composer');
    await view.unmount();
  });

  it('has no timeline section for a record without one', async () => {
    const { view } = await showSheet(cleanedTrace);
    expect(view.container.querySelector('[data-debug-section="Timeline"]')).toBeNull();
    await view.unmount();
  });

  it('says where the record lives and opens on the overview and the final text', async () => {
    const { view } = await showSheet(cleanedTrace);
    const text = view.container.textContent ?? '';
    expect(text).toContain('Held in memory on this device only. Gone on reload.');
    expect(toggle(view.container, 'Overview').getAttribute('aria-expanded')).toBe('true');
    expect(toggle(view.container, 'Final text').getAttribute('aria-expanded')).toBe('true');
    expect(toggle(view.container, 'Request').getAttribute('aria-expanded')).toBe('false');
    expect(section(view.container, 'Final text').textContent).toContain('Fix the bug.');
    await view.unmount();
  });

  it('shows the overview: provider, model, host, path, timings and token usage', async () => {
    const { view } = await showSheet(cleanedTrace);
    const overview = section(view.container, 'Overview').textContent ?? '';
    for (const expected of [
      'groq',
      'example-model',
      'api.example.invalid',
      'This browser, with its own key',
      'cleaned',
      '2026-10-21 09:30:15 UTC',
      '412 ms',
      '200',
      '120 ms',
      'stop',
      'prompt 40 · completion 8 · total 48 · reasoning 3',
    ]) {
      expect(overview).toContain(expected);
    }
    expect(overview).not.toContain('Attempt 1');
    await view.unmount();
  });

  it('renders the request by role, with the key redacted', async () => {
    const { view } = await showSheet(cleanedTrace);
    await open(view.container, 'Request');
    const request = section(view.container, 'Request').textContent ?? '';
    expect(request).toContain('POST https://api.example.invalid/v1/chat/completions');
    expect(request).toContain('Message 1 · system');
    expect(request).toContain('You tidy dictated text.');
    expect(request).toContain('Message 2 · user');
    expect(request).toContain('um fix the bug');
    expect(request).toContain(`"authorization": "${TRACE_REDACTED}"`);
    expect(request).toContain('"temperature": 0');
    await view.unmount();
  });

  it('renders the raw response with the reasoning and the message before stripping', async () => {
    const { view } = await showSheet(cleanedTrace);
    await open(view.container, 'Raw response');
    const response = section(view.container, 'Raw response').textContent ?? '';
    expect(response).toContain('it said um');
    expect(response).toContain('<think>hm</think>Fix the bug.');
    expect(response).toContain('{"choices":[]}');
    await view.unmount();
  });

  it('renders the post-processing steps and the verdict', async () => {
    const { view } = await showSheet(cleanedTrace);
    await open(view.container, 'Post-processing');
    const steps = section(view.container, 'Post-processing').textContent ?? '';
    expect(steps).toContain('reasoning stripped — removed 14 characters');
    expect(steps).toContain('guard passed');
    expect(steps).toContain('Verdict: cleaned');
    await view.unmount();
  });

  it('shows the whole record as raw JSON', async () => {
    const { view } = await showSheet(cleanedTrace);
    await open(view.container, 'Raw JSON');
    const json = must(view.container.querySelector('[data-debug-json]'), 'the JSON').textContent ?? '';
    expect(JSON.parse(json)).toEqual(record(cleanedTrace));
    await view.unmount();
  });

  it('labels both attempts of a retried call and shows every failure plainly', async () => {
    const { view } = await showSheet(failedTrace);
    const overview = section(view.container, 'Overview').textContent ?? '';
    expect(overview).toContain('failed: the provider refused');
    expect(overview).toContain('The daemon');
    expect(overview).toContain('Attempt 1 · HTTP status');
    expect(overview).toContain('Attempt 2 · Attempt time');
    expect(section(view.container, 'Final text').textContent).toContain('No text was kept');

    await open(view.container, 'Request');
    expect(section(view.container, 'Request').textContent).toContain('Attempt 2 — without the conversation');
    await open(view.container, 'Raw response');
    const response = section(view.container, 'Raw response').textContent ?? '';
    expect(response).toContain('Attempt 1 — with the conversation');
    expect(response).toContain('rate limited');
    expect(response).toContain('slow down');
    await open(view.container, 'Post-processing');
    const steps = section(view.container, 'Post-processing').textContent ?? '';
    expect(steps).toContain('No reply reached the checks.');
    expect(steps).toContain('guard rejected');
    expect(steps).toContain('kept raw — kept as spoken');
    expect(steps).toContain('Verdict: kept raw — the reply added words');
    await view.unmount();
  });

  it('names a failure by its code when it has one', async () => {
    const { view } = await showSheet(failedWithCode);
    expect(section(view.container, 'Overview').textContent).toContain('enhancement-timeout: timed out');
    await view.unmount();
  });

  it('collapses a section again', async () => {
    const { view } = await showSheet(cleanedTrace);
    await open(view.container, 'Overview');
    expect(toggle(view.container, 'Overview').getAttribute('aria-expanded')).toBe('false');
    await view.unmount();
  });

  it('copies one section at a time, and says Copied', async () => {
    const written: string[] = [];
    const { view } = await showSheet(cleanedTrace, async text => {
      written.push(text);
    });
    await interact(() => copyButton(view.container, 'Request').click());
    await interact(() => copyButton(view.container, 'Final text').click());
    await interact(() => copyButton(view.container, 'Overview').click());
    await interact(() => copyButton(view.container, 'Raw response').click());
    await interact(() => copyButton(view.container, 'Post-processing').click());
    await interact(() => copyButton(view.container, 'Raw JSON').click());
    expect(written[0]).toContain('[system]\nYou tidy dictated text.');
    expect(written[0]).toContain(`"authorization": "${TRACE_REDACTED}"`);
    expect(written[1]).toBe('Fix the bug.');
    expect(written[2]).toContain('Model: example-model');
    expect(written[3]).toContain('[reasoning]\nit said um');
    expect(written[4]).toContain('Verdict: cleaned');
    expect(JSON.parse(written[5] as string)).toEqual(record(cleanedTrace));
    expect(copyButton(view.container, 'Final text').getAttribute('data-copy-state')).toBe('copied');
    expect(copyButton(view.container, 'Final text').textContent).toContain('Copied');
    await view.unmount();
  });

  it('copies the text of a failed call and of every attempt', async () => {
    const written: string[] = [];
    const { view } = await showSheet(failedTrace, async text => {
      written.push(text);
    });
    await interact(() => copyButton(view.container, 'Final text').click());
    await interact(() => copyButton(view.container, 'Raw response').click());
    await interact(() => copyButton(view.container, 'Post-processing').click());
    expect(written[0]).toBe('');
    expect(written[1]).toContain('Failure: rate limited');
    expect(written[1]).toContain('Provider body:\nslow down');
    expect(written[1]).toContain('Attempt 2 — without the conversation');
    expect(written[2]).toContain('No reply reached the checks.');
    await view.unmount();
  });

  it('says so when the clipboard refuses', async () => {
    const { view } = await showSheet(cleanedTrace, async () => {
      throw new Error('blocked');
    });
    await interact(() => copyButton(view.container, 'Final text').click());
    expect(copyButton(view.container, 'Final text').getAttribute('data-copy-state')).toBe('failed');
    expect(copyButton(view.container, 'Final text').textContent).toContain('Copy blocked');
    await view.unmount();
  });

  it('falls back to the browser clipboard when none is given', async () => {
    const written: string[] = [];
    const navigatorLike = globalThis.navigator as unknown as { clipboard?: unknown };
    const before = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    try {
      const view = await mount(<DictationDebugSheet record={record(cleanedTrace)} onClose={() => undefined} />);
      await interact(() => copyButton(view.container, 'Final text').click());
      expect(written).toEqual(['Fix the bug.']);
      await view.unmount();
    } finally {
      if (before) Object.defineProperty(globalThis.navigator, 'clipboard', before);
      else delete navigatorLike.clipboard;
    }
  });

  it('closes from its Close button and from Escape', async () => {
    const { view, closed } = await showSheet(cleanedTrace);
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('button[aria-label="Close"]'), 'Close').click(),
    );
    expect(closed()).toBe(1);
    await interact(() => pressKey(document, 'Escape'));
    expect(closed()).toBe(2);
    await view.unmount();
  });
});
