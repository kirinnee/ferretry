import { expect, test } from 'bun:test';
import { registerReader } from '../../../daemon/reader/index.ts';

/**
 * A secret holding a quote, a backslash AND a newline: JSON escapes all three, and the rendered log indents every line
 * of a multi-line body. Neither spelling occurs literally in a rendered line, so the reader must mask each string while
 * it is still the value the harness wrote (`maskedEvent`), never the text it was rendered into.
 */
const secret = 'fixture-secret"\\\nend';
const mask = (text: string) => text.replaceAll(secret, '[redacted]');
const scrub = (value: unknown): unknown =>
  typeof value === 'string'
    ? mask(value)
    : Array.isArray(value)
      ? value.map(scrub)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, each]) => [key, scrub(each)]))
        : value;

const record = (value: unknown) => `${JSON.stringify(value)}\n`;
const fixture = new TextEncoder().encode(
  record({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-02-01T00:00:01.000Z',
    message: { role: 'user', content: `please deploy with ${secret}` },
  }) +
    record({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-02-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `deploy --token ${secret}` } },
          { type: 'text', text: `deploying with ${secret}` },
        ],
      },
    }) +
    record({
      type: 'user',
      uuid: 'r1',
      timestamp: '2026-02-01T00:00:03.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `ok ${secret}` }] }],
      },
    }),
);

function handle(file = 'file-one') {
  let closed = false;
  return {
    format: 'claude' as const,
    file,
    size: fixture.length,
    mtimeMs: 1,
    read: async (offset: number, length: number) => {
      if (closed) throw new Error('closed');
      return fixture.slice(offset, offset + length);
    },
    stat: async () => (closed ? undefined : { size: fixture.length, mtimeMs: 1 }),
    close: async () => {
      closed = true;
    },
    isClosed: () => closed,
  };
}
const call = (query: Record<string, string> = {}) =>
  ({
    params: new Map([['ferretId', 'lead']]),
    request: {
      query: new Map(Object.entries(query).map(([key, value]) => [key, [value]])),
      headers: { get: () => undefined },
    },
  }) as never;

/** A reader whose redactor masks `secret` and nothing else (a redactor that skips `unmasked` is the mutation check). */
const reader = (options: { readonly unmasked?: boolean } = {}) =>
  registerReader({
    bytes: async () => handle(),
    transcripts: async () => undefined,
    exists: async () => true,
    codec: { tag: async () => new Uint8Array(32), matches: async () => true },
    redactor: {
      redact: async text => mask(text),
      batch: async work => work({ text: mask, data: options.unmasked === true ? value => value : scrub }),
    },
    now: () => 0,
  });

const shownBy = async (route: 'logs' | 'log-page' | 'log-search') => {
  const r = reader();
  try {
    const response = await r.routes[`GET /v1/ferrets/:ferretId/${route}`](
      call(route === 'log-search' ? { q: 'deploy', tools: '1' } : {}),
    );
    return route === 'logs'
      ? response.body
      : route === 'log-page'
        ? JSON.parse(response.body).log
        : JSON.parse(response.body)
            .matches.map((match: { snippet: string }) => match.snippet)
            .join('\n');
  } finally {
    await r.close();
  }
};

/** Every spelling a reader could leak: the raw words, the JSON-escaped ones, and the ones a log indentation breaks. */
const leaks = (shown: string): boolean =>
  shown.includes('fixture-secret') || shown.includes(JSON.stringify(secret).slice(1, -1));

for (const route of ['logs', 'log-page', 'log-search'] as const)
  test(`${route} masks a secret with a quote, a backslash and a newline in a tool input, a message and a result`, async () => {
    const shown = await shownBy(route);
    expect(shown).toContain('[redacted]');
    expect(leaks(shown)).toBe(false);
  });

test('the logs route masks the message and the tool result, not only the tool input', async () => {
  const shown = await shownBy('logs');
  expect(shown).toContain('user/message: please deploy with [redacted]');
  expect(shown).toContain('assistant/message: deploying with [redacted]');
  expect(shown).toContain('ok [redacted]');
});

test('MUTATION: a reader that does not mask the structured input leaks it (the masking is what these tests pin)', async () => {
  // The final pass over the rendered text cannot find an escaped secret; only masking the value before it is serialised does.
  const r = reader({ unmasked: true });
  try {
    const response = await r.routes['GET /v1/ferrets/:ferretId/logs'](call());
    expect(leaks(response.body)).toBe(true);
  } finally {
    await r.close();
  }
});

test('port transcriptEvents masks the same escaped input', async () => {
  const r = reader();
  try {
    const events = await r.reads.transcriptEvents('lead', 20);
    expect(JSON.stringify(events)).toContain('[redacted]');
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
  } finally {
    await r.close();
  }
});
