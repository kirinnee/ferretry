import { describe, expect, test } from 'bun:test';
import type { PushNumberPage } from '../../../daemon/challenges/push-number-read.ts';
import type { BrowserInputFacts } from '../../../daemon/target/lib/contracts.ts';
import { elementParam } from '../../../daemon/target/lib/element.ts';
import { workerInputFields } from '../../../daemon/target/lib/worker-port.ts';
import { type InputWorkerPages, isInputMethod, serveInputMethod } from '../../../daemon/target/lib/worker-serve.ts';
import { FakeWorld } from '../../support/page-world.ts';

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const pointer = (id: string) => ({ id, target: { kind: 'selector' as const, selector: `#${id}` } });

function loginWorld() {
  const world = new FakeWorld();
  world.element('#user', 11, ['type', 'text', 'name', 'username', 'autocomplete', 'username']);
  world.element('#pw', 12, ['type', 'password', 'name', 'pw', 'autocomplete', 'current-password']);
  const pageId = world.subject.pageId;
  const pushPage: PushNumberPage = {
    evaluate: async <R>() => ({ provider: 'okta', number: { value: '42', from: 'okta' } }) as R,
    url: () => 'https://login.example.test/step',
  };
  const pages: InputWorkerPages = {
    subject: id => {
      if (id !== pageId) throw new Error('that page is gone');
      return world.subject;
    },
    session: async id => {
      if (id !== pageId) throw new Error('that page is gone');
      return world.session('page-target');
    },
    pushPage: () => pushPage,
  };
  const serve = async (method: string, params: Record<string, unknown>) =>
    wire(await serveInputMethod(pages, method, wire(params)));
  return { world, pages, pageId, serve };
}

async function pageFacts(
  serve: ReturnType<typeof loginWorld>['serve'],
  pageId: string,
  ids: readonly string[] = ['user', 'pw'],
): Promise<BrowserInputFacts> {
  const observed = (await serve('inputObserve', { pageId, fields: ids.map(pointer) })) as {
    observation: { ok: boolean; facts: BrowserInputFacts };
  };
  expect(observed.observation.ok).toBe(true);
  return observed.observation.facts;
}

describe('the worker side of the page input seam', () => {
  test('it knows which methods are the seam’s, and refuses any other', async () => {
    const { serve, pageId } = loginWorld();
    expect(isInputMethod('inputType')).toBe(true);
    expect(isInputMethod('pushNumberRead')).toBe(true);
    expect(isInputMethod('navigate')).toBe(false);
    await expect(serve('navigate', { pageId })).rejects.toThrow('not a page input method');
  });

  test('reads answer the document, the text and the fields of the page they name', async () => {
    const { serve, pageId } = loginWorld();
    expect(await serve('inputDocument', { pageId })).toEqual({
      document: { navigationId: 'loader-1', host: 'localhost:3000' },
    });
    expect(((await serve('inputText', { pageId })) as { text: string }).text).toContain('Welcome back');
    const facts = await pageFacts(serve, pageId);
    const again = (await serve('inputRefind', {
      pageId,
      expected: facts,
      fields: [pointer('user'), pointer('pw')],
    })) as {
      observation: { ok: boolean };
    };
    expect(again.observation.ok).toBe(true);
    const shot = (await serve('inputShot', { pageId, facts })) as { shot: { pngBase64: string } };
    expect(shot.shot.pngBase64).toBe('cG5n');
  });

  test('the push number is read from the page and its document', async () => {
    const { serve, pageId } = loginWorld();
    const answer = (await serve('pushNumberRead', { pageId })) as { read: { provider: string; number: unknown } };
    expect(answer.read.provider).toBe('okta');
    expect(answer.read.number).toMatchObject({ value: '42', from: 'okta' });
  });

  test('a read of a page that is gone throws, so the worker answers its fixed error', async () => {
    const { serve } = loginWorld();
    for (const method of ['inputDocument', 'inputText', 'pushNumberRead'])
      await expect(serve(method, { pageId: 'gone' })).rejects.toThrow('that page is gone');
  });

  test('a field list that is empty, or has a field without an id or a target, is refused', async () => {
    const { serve, pageId } = loginWorld();
    await expect(serve('inputObserve', { pageId, fields: [] })).rejects.toThrow('fields are required');
    await expect(serve('inputObserve', { pageId, fields: 'nope' })).rejects.toThrow('fields are required');
    await expect(serve('inputObserve', { pageId, fields: [{ target: pointer('user').target }] })).rejects.toThrow(
      'a field needs an id and a target',
    );
    await expect(serve('inputObserve', { pageId, fields: [{ id: 'x' }] })).rejects.toThrow(
      'a field needs an id and a target',
    );
    await expect(serve('inputObserve', { pageId, fields: [null] })).rejects.toThrow();
  });

  test('refind and shot refuse facts that are not page facts', async () => {
    const { serve, pageId } = loginWorld();
    await expect(serve('inputRefind', { pageId, expected: { kind: 'nope' }, fields: [pointer('pw')] })).rejects.toThrow(
      'facts are not page facts',
    );
    await expect(serve('inputShot', { pageId, facts: 1 })).rejects.toThrow('facts are not page facts');
  });

  test('the write types into the page, and anything wrong says a word instead of throwing', async () => {
    const { serve, pageId, world } = loginWorld();
    const facts = await pageFacts(serve, pageId, ['pw']);
    const values = [{ field: 'pw', text: 'hunter2' }];
    expect(await serve('inputType', { pageId, expected: facts, values, submit: false })).toEqual({ outcome: 'typed' });
    expect(await serve('inputType', { pageId: 'gone', expected: facts, values })).toEqual({ outcome: 'target_gone' });
    expect(await serve('inputType', { pageId, expected: { kind: 'nope' }, values })).toEqual({
      outcome: 'target_changed',
    });
    expect(await serve('inputType', { pageId, expected: facts, values: 'nope' })).toEqual({
      outcome: 'target_changed',
    });
    expect(await serve('inputType', { pageId, expected: facts, values: [{ field: 'pw' }] })).toEqual({
      outcome: 'target_changed',
    });
    expect(await serve('inputType', { pageId, expected: facts, values: [null] })).toEqual({
      outcome: 'target_changed',
    });
    world.session('page-target').failOn = method =>
      method === 'Input.insertText' ? new Error('boom hunter2') : undefined;
    expect(await serve('inputType', { pageId, expected: facts, values, submit: true })).toEqual({
      outcome: 'uncertain',
    });
  });

  test('the arm answers armed for good facts, and refused for anything malformed or failing', async () => {
    const { serve, pageId, world } = loginWorld();
    const facts = await pageFacts(serve, pageId, ['pw']);
    expect(await serve('inputArm', { pageId, expected: facts, fieldIds: ['pw'] })).toEqual({ outcome: 'armed' });
    expect(await serve('inputArm', { pageId, expected: facts, fieldIds: [1] })).toEqual({ outcome: 'refused' });
    expect(await serve('inputArm', { pageId, expected: facts, fieldIds: 'nope' })).toEqual({ outcome: 'refused' });
    expect(await serve('inputArm', { pageId: 'gone', expected: facts, fieldIds: ['pw'] })).toEqual({
      outcome: 'refused',
    });
    expect(await serve('inputArm', { pageId, expected: { kind: 'nope' }, fieldIds: ['pw'] })).toEqual({
      outcome: 'refused',
    });
    world.armFails = true;
    expect(await serve('inputArm', { pageId, expected: facts, fieldIds: ['pw'] })).toEqual({ outcome: 'refused' });
  });

  test('the probe answers what the page does with a dummy, and aborted for anything malformed or failing', async () => {
    const { serve, pageId } = loginWorld();
    const facts = await pageFacts(serve, pageId, ['pw']);
    const probed = (await serve('inputProbe', { pageId, expected: facts, fieldIds: ['pw'], dummy: 'zzz' })) as {
      outcome: string;
    };
    expect(['hidden', 'shown', 'aborted']).toContain(probed.outcome);
    expect(await serve('inputProbe', { pageId, expected: facts, fieldIds: [1], dummy: 'zzz' })).toEqual({
      outcome: 'aborted',
    });
    expect(await serve('inputProbe', { pageId, expected: facts, fieldIds: ['pw'], dummy: '' })).toEqual({
      outcome: 'aborted',
    });
    expect(await serve('inputProbe', { pageId, expected: facts, fieldIds: ['pw'], dummy: 5 })).toEqual({
      outcome: 'aborted',
    });
    expect(await serve('inputProbe', { pageId: 'gone', expected: facts, fieldIds: ['pw'], dummy: 'z' })).toEqual({
      outcome: 'aborted',
    });
  });

  test('the clear checks the fields of a good job, says moved for a page that is gone, and unknown for a bad job', async () => {
    const { serve, pageId } = loginWorld();
    const facts = await pageFacts(serve, pageId, ['pw']);
    const field = facts.fields[0] as BrowserInputFacts['fields'][number];
    const job = {
      navigationId: facts.navigationId,
      fields: [{ frameId: field.frameId, backendNodeId: field.backendNodeId }],
    };
    const cleared = (await serve('inputClear', { pageId, job })) as { outcome: string };
    expect(['cleared', 'moved', 'unknown']).toContain(cleared.outcome);
    expect(await serve('inputClear', { pageId: 'gone', job })).toEqual({ outcome: 'moved' });
    const fieldOf = { frameId: 'f', backendNodeId: 5 };
    for (const bad of [
      undefined,
      { navigationId: '', fields: [fieldOf] },
      { navigationId: 'n', fields: 'nope' },
      { navigationId: 'n', fields: [null] },
      { navigationId: 'n', fields: [{ frameId: 1, backendNodeId: 5 }] },
      { navigationId: 'n', fields: [{ frameId: 'f', backendNodeId: 'x' }] },
      { navigationId: 'n', fields: [{ frameId: 'f', backendNodeId: 1.5 }] },
      { navigationId: 'n', fields: [{ frameId: 'f', backendNodeId: 0 }] },
      { navigationId: 'n', fields: [] },
      { navigationId: 'n', fields: Array.from({ length: 9 }, () => fieldOf) },
    ])
      expect(await serve('inputClear', { pageId, job: bad })).toEqual({ outcome: 'unknown' });
  });
});

describe('an element target as the worker receives one', () => {
  test('a ref in either spelling and a selector are believed; anything else is refused', () => {
    expect(elementParam(undefined)).toBeUndefined();
    expect(elementParam({ kind: 'ref', ref: 'e12' })).toEqual({ kind: 'ref', ref: 'e12' });
    expect(elementParam({ kind: 'ref', ref: 'f1e3' })).toEqual({ kind: 'ref', ref: 'f1e3' });
    expect(elementParam({ kind: 'selector', selector: '#pw' })).toEqual({ kind: 'selector', selector: '#pw' });
    for (const bad of [null, 'x', [], { kind: 'ref', ref: 'nope' }, { kind: 'selector', selector: '' }, { kind: 'x' }])
      expect(() => elementParam(bad)).toThrow(
        bad !== null && typeof bad === 'object' && !Array.isArray(bad)
          ? 'target is not a ref or a selector'
          : 'target must be an object',
      );
  });
});

describe('the daemon side of the page input seam', () => {
  const port = (answer: unknown) => {
    const sent: { method: string; params: unknown }[] = [];
    const fields = workerInputFields(async (method, params) => {
      sent.push({ method, params });
      if (answer instanceof Error) throw answer;
      return answer;
    });
    return { fields, sent };
  };
  const facts = { kind: 'page' } as unknown as BrowserInputFacts;

  test('the document answer is believed only with a document id, and a host only when it fits', async () => {
    expect(await port({ document: { navigationId: 'n1', host: 'a.test' } }).fields.inputDocument('p')).toEqual({
      navigationId: 'n1',
      host: 'a.test',
    });
    expect(await port({ document: { navigationId: 'n1', host: '' } }).fields.inputDocument('p')).toEqual({
      navigationId: 'n1',
    });
    for (const bad of [
      null,
      {},
      { document: {} },
      { document: { navigationId: '' } },
      { document: { navigationId: 'x'.repeat(129) } },
    ])
      await expect(port(bad).fields.inputDocument('p')).rejects.toMatchObject({ status: 502 });
  });

  test('the text answer is believed only when it is a string of a sane size', async () => {
    expect(await port({ text: 'hello' }).fields.inputText('p')).toBe('hello');
    await expect(port({ text: 5 }).fields.inputText('p')).rejects.toThrow(
      'the browser did not answer with the page text',
    );
    await expect(port(null).fields.inputText('p')).rejects.toMatchObject({ code: 'upstream_failed' });
    await expect(port({ text: 'x'.repeat(1_300_000) }).fields.inputText('p')).rejects.toMatchObject({ status: 502 });
  });

  test('an observation says what is missing or ambiguous, and anything else is refused without quoting it', async () => {
    const missing = await port({ observation: { ok: false, missing: 'm'.repeat(100) } }).fields.inputObserve('p', []);
    expect(missing).toEqual({ ok: false, missing: 'm'.repeat(64) });
    const ambiguous = await port({ observation: { ok: false, ambiguous: 'a'.repeat(100) } }).fields.inputRefind(
      'p',
      facts,
      [],
    );
    expect(ambiguous).toEqual({ ok: false, ambiguous: 'a'.repeat(64) });
    for (const bad of [
      null,
      {},
      { observation: { ok: true, facts: { kind: 'page' } } },
      { observation: { ok: false } },
    ])
      await expect(port(bad).fields.inputObserve('p', [])).rejects.toThrow(
        'the browser described the fields in a form Ferretry does not accept',
      );
  });

  test('a shot is a bounded base64 png and a finite clip, or it is refused', async () => {
    const clip = { x: 1, y: 2, w: 3, h: 4 };
    expect(await port({ shot: { pngBase64: 'cG5n', clip } }).fields.inputShot('p', facts)).toEqual({
      pngBase64: 'cG5n',
      clip,
    });
    for (const bad of [
      null,
      {},
      { shot: { pngBase64: '', clip } },
      { shot: { pngBase64: 'not base64!', clip } },
      { shot: { pngBase64: 'x'.repeat(4_000_001), clip } },
      { shot: { pngBase64: 'cG5n', clip: { x: 1, y: 2, w: 3 } } },
      { shot: { pngBase64: 'cG5n' } },
    ])
      await expect(port(bad).fields.inputShot('p', facts)).rejects.toThrow(
        'the browser sent no usable picture of the fields',
      );
  });

  test('the write is typed, changed or gone when the worker says so, and uncertain otherwise', async () => {
    for (const word of ['typed', 'target_changed', 'target_gone'] as const)
      expect(await port({ outcome: word }).fields.inputType('p', facts, [], false)).toBe(word);
    expect(await port({ outcome: 'weird' }).fields.inputType('p', facts, [], false)).toBe('uncertain');
    expect(await port(new Error('crash')).fields.inputType('p', facts, [], false)).toBe('uncertain');
  });

  test('the arm, the clear and the probe each fall back to their cautious word', async () => {
    expect(await port({ outcome: 'armed' }).fields.inputArm('p', facts, ['a'])).toBe('armed');
    expect(await port({ outcome: 'x' }).fields.inputArm('p', facts, ['a'])).toBe('refused');
    expect(await port(new Error('crash')).fields.inputArm('p', facts, ['a'])).toBe('refused');
    expect(await port({ outcome: 'cleared' }).fields.inputClear('p', { navigationId: 'n', fields: [] })).toBe(
      'cleared',
    );
    expect(await port({ outcome: 'moved' }).fields.inputClear('p', { navigationId: 'n', fields: [] })).toBe('moved');
    expect(await port({ outcome: 'x' }).fields.inputClear('p', { navigationId: 'n', fields: [] })).toBe('unknown');
    expect(await port(new Error('crash')).fields.inputClear('p', { navigationId: 'n', fields: [] })).toBe('unknown');
    expect(await port({ outcome: 'hidden' }).fields.inputProbe('p', facts, ['a'], 'd')).toBe('hidden');
    expect(await port({ outcome: 'shown' }).fields.inputProbe('p', facts, ['a'], 'd')).toBe('shown');
    expect(await port({ outcome: 'x' }).fields.inputProbe('p', facts, ['a'], 'd')).toBe('aborted');
    expect(await port(new Error('crash')).fields.inputProbe('p', facts, ['a'], 'd')).toBe('aborted');
  });

  test('the push number is read from the answer’s read, and refused when it is not in the contract’s shape', async () => {
    const read = { origin: 'https://a.test', navigationId: 'n', missing: 'none-found' as const };
    expect(await port({ read }).fields.pushNumberRead('p')).toEqual(read);
    await expect(port(null).fields.pushNumberRead('p')).rejects.toMatchObject({ status: 502 });
  });
});

describe('a write that blows up before it begins', () => {
  test('answers uncertain, never the error, because the write may have begun', async () => {
    const { world, pageId, pages } = loginWorld();
    const page = world.page;
    const broken: InputWorkerPages = {
      ...pages,
      subject: () => ({
        ...world.subject,
        page: {
          ...page,
          isClosed: () => {
            throw new Error('the page object failed with hunter2');
          },
        },
      }),
    };
    const answer = await serveInputMethod(broken, 'inputType', {
      pageId,
      expected: (await serveInputMethod(pages, 'inputObserve', { pageId, fields: [pointer('pw')] })) as never,
      values: [],
    }).catch((error: unknown) => error);
    // The facts above are the observation wrapper, not page facts: malformed facts answer target_changed first.
    expect(answer).toEqual({ outcome: 'target_changed' });
    const facts = await pageFacts(
      async (method, params) => wire(await serveInputMethod(pages, method, wire(params))),
      pageId,
      ['pw'],
    );
    expect(await serveInputMethod(broken, 'inputType', { pageId, expected: facts, values: [] })).toEqual({
      outcome: 'uncertain',
    });
  });
});
