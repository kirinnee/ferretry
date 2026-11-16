import { describe, expect, it } from 'bun:test';
import { type ApiRequest, answerWhenChanged, jsonResponse, namesTag } from '../../../contract/index.ts';

const requestOf = (ifNoneMatch?: string): ApiRequest =>
  ({ headers: new Map(ifNoneMatch === undefined ? [] : [['if-none-match', ifNoneMatch]]) }) as unknown as ApiRequest;

describe('namesTag', () => {
  it('names a tag among several, weakly, and by *', () => {
    expect(namesTag('"a"', '"a"')).toBe(true);
    expect(namesTag('"b", W/"a"', '"a"')).toBe(true);
    expect(namesTag('*', '"a"')).toBe(true);
    expect(namesTag('"b"', '"a"')).toBe(false);
  });
});

describe('answerWhenChanged', () => {
  it('builds the answer with its tag when the request names none', async () => {
    const built = await answerWhenChanged(requestOf(), '"t"', async () => jsonResponse({ a: 1 }));
    expect(built.status).toBe(200);
    expect(built.headers.get('etag')).toBe('"t"');
    expect(built.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(built.body)).toEqual({ a: 1 });
  });

  it('answers 304 with the tag and no body, and never builds, when the request names it', async () => {
    let builds = 0;
    const answered = await answerWhenChanged(requestOf('"t"'), '"t"', async () => {
      builds += 1;
      return jsonResponse({});
    });
    expect(answered).toEqual({ status: 304, headers: new Map([['etag', '"t"']]), body: '' });
    expect(builds).toBe(0);
  });

  it('builds when the request names another tag', async () => {
    expect((await answerWhenChanged(requestOf('"old"'), '"new"', async () => jsonResponse({}))).status).toBe(200);
  });

  it('puts the tag on a 200 only: a built refusal is returned as it came', async () => {
    const refusal = jsonResponse({ error: 'no' }, 404);
    const answered = await answerWhenChanged(requestOf(), '"t"', async () => refusal);
    expect(answered).toBe(refusal);
    expect(answered.headers.has('etag')).toBe(false);
  });
});
