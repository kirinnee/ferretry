import { expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import {
  parseRenameBody,
  parseResumeBody,
  parseStartBody,
  parseStopBody,
} from '../../../../daemon/lib/ferrets/wire.ts';

const refused = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the body to be refused');
};

test('an auto start without a prompt, or with a blank one, is refused naming the prompt', () => {
  for (const prompt of [undefined, '   ']) {
    const error = refused(() =>
      parseStartBody({ mode: 'auto', folder: '/work', ...(prompt === undefined ? {} : { prompt }) }),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.validationIssues).toEqual([{ path: ['prompt'], message: 'an auto start needs a prompt' }]);
  }
});

test('an auto start with a prompt, and an interactive start with none, are accepted', () => {
  expect(parseStartBody({ mode: 'auto', folder: '/work', prompt: 'go' }).options).toMatchObject({ mode: 'auto' });
  expect(parseStartBody({ mode: 'interactive', folder: '/work' })).toBeDefined();
});

test('--auto and a named runtime together are refused naming the runtime', () => {
  const error = refused(() => parseStartBody({ auto: true, runtime: 'x', folder: '/work' }));
  expect(error.validationIssues).toEqual([{ path: ['runtime'], message: '--auto picks the runtime; do not name one' }]);
});

test('a start with no folder is refused with the folder sentence', () => {
  const error = refused(() => parseStartBody({ name: 'sam' }));
  expect(error.status).toBe(400);
  expect(error.message).toBe('a start must name the absolute working directory to run in');
});

test('a start splits identity fields from option fields, leaving options out when there are none', () => {
  const bare = parseStartBody({ folder: '/work', name: 'sam' });
  expect(bare).toEqual({ folder: '/work', name: 'sam' });
  expect('options' in bare).toBe(false);
  const withOptions = parseStartBody({ folder: '/work', model: 'm1' });
  expect(withOptions.folder).toBe('/work');
  expect(withOptions.options).toMatchObject({ model: 'm1' });
});

test('a start body with an unknown field is refused', () => {
  expect(refused(() => parseStartBody({ folder: '/work', bogus: 1 })).code).toBe('invalid_request');
});

test('a rename needs a name or a title', () => {
  const error = refused(() => parseRenameBody({}));
  expect(error.validationIssues).toEqual([{ path: [], message: 'name or title is required' }]);
  expect(parseRenameBody({ title: 'Fix the thing' })).toEqual({ title: 'Fix the thing' });
});

test('V-0443 a start body carries initialAttachments into the request options exactly as v4 shaped them, and refuses a malformed one', () => {
  const file = { filename: 'shot.png', mime: 'image/png', base64: 'iVBORw0K' };
  expect(parseStartBody({ mode: 'auto', folder: '/work', prompt: 'go', initialAttachments: [file] }).options).toEqual({
    mode: 'auto',
    initialAttachments: [file],
  });
  // The mime is optional (the CLI states one only for an image).
  const bare = { filename: 'brief.docx', base64: 'QUJD' };
  expect(parseStartBody({ folder: '/work', initialAttachments: [bare] }).options?.initialAttachments).toEqual([bare]);
  const bad: readonly unknown[] = [
    [{ filename: '', base64: 'QUJD' }],
    [{ filename: 'a.png', base64: '' }],
    [{ filename: 'a.png', base64: 'not base64!' }],
    [{ filename: 'a.png', base64: 'QUJ' }],
    [{ filename: 'a.png', mime: '', base64: 'QUJD' }],
    [{ filename: 'a.png', base64: 'QUJD', path: '/etc/passwd' }],
    'shot.png',
  ];
  for (const initialAttachments of bad) {
    const error = refused(() => parseStartBody({ folder: '/work', initialAttachments }));
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_request');
  }
});

test('stop and resume bodies parse strictly: an empty reason or message is refused, empty bodies pass', () => {
  expect(parseStopBody({})).toEqual({});
  expect(parseStopBody({ reason: 'done' })).toEqual({ reason: 'done' });
  expect(refused(() => parseStopBody({ reason: '' })).status).toBe(400);
  expect(parseResumeBody({ message: 'continue' })).toEqual({ message: 'continue' });
  expect(refused(() => parseResumeBody({ extra: 1 })).status).toBe(400);
});
