import { describe, it } from 'bun:test';
import type { InputTargetFacts } from '@ferretry/protocol';
import should from 'should';
import { clearJobOf } from '../../../src/lib/sign-in-grants/clear.ts';

const field = (fieldId: string, backendNodeId: number, type: string) => ({
  fieldId,
  frameOrigin: 'https://github.com',
  frameId: 'main',
  backendNodeId,
  field: { tag: 'input', type },
  box: { x: 0, y: 0, w: 1, h: 1 },
  visible: true,
});

const page: InputTargetFacts = {
  kind: 'browser',
  pageId: 'p1',
  origin: 'https://github.com',
  secure: true,
  navigationId: 'n1',
  fields: [field('user', 11, 'text'), field('pass', 12, 'password')],
};

describe('clearJobOf: which nodes the browser checks before the hold ends, never a value', () => {
  it('should name only the typed password fields, by frame and node, in the document they went into', () => {
    should(clearJobOf(page, ['pass'])).deepEqual({
      navigationId: 'n1',
      fields: [{ frameId: 'main', backendNodeId: 12 }],
    });
  });

  it('should have nothing to clear on a terminal or the secret store, or on a page where no password was typed', () => {
    should(clearJobOf({ kind: 'secret', name: 'TOKEN', exists: false }, ['value'])).be.undefined();
    should(clearJobOf(page, [])).be.undefined();
  });
});
