import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { InputTargetFacts } from '@ferretry/protocol';
import should from 'should';
import { clearDigest, clearJobOf } from '../../../src/lib/sign-in-grants/clear.ts';

const PASSWORD = 'correct-horse-battery-staple';

const page: InputTargetFacts = {
  kind: 'browser',
  pageId: 'p1',
  origin: 'https://github.com',
  secure: true,
  navigationId: 'n1',
  fields: [
    {
      fieldId: 'user',
      frameOrigin: 'https://github.com',
      frameId: 'main',
      backendNodeId: 11,
      field: { tag: 'input', type: 'text' },
      box: { x: 0, y: 0, w: 1, h: 1 },
      visible: true,
    },
    {
      fieldId: 'pass',
      frameOrigin: 'https://github.com',
      frameId: 'main',
      backendNodeId: 12,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 1, h: 1 },
      visible: true,
    },
  ],
};

describe('clearJobOf: what the browser checks when the hold ends, never the value', () => {
  it('should name only the password fields, each with a fresh salt and the salted hash of what was typed', () => {
    const job = clearJobOf(page, [
      { field: 'user', text: 'kirinnee', secret: false },
      { field: 'pass', text: PASSWORD, secret: true },
    ]);
    should(job?.navigationId).equal('n1');
    should(job?.fields).have.length(1);
    const [only] = job?.fields ?? [];
    should(only).match({ frameId: 'main', backendNodeId: 12 });
    should(only?.salt).match(/^[0-9a-f]{32}$/u);
    should(only?.digest).equal(
      createHash('sha256')
        .update(`${only?.salt ?? ''}${PASSWORD}`, 'utf8')
        .digest('hex'),
    );
    should(JSON.stringify(job)).not.containEql(PASSWORD);
  });

  it('should hash the same value differently under two salts', () => {
    should(clearDigest('a'.repeat(32), PASSWORD)).not.equal(clearDigest('b'.repeat(32), PASSWORD));
  });

  it('should have nothing to clear on a terminal, or on a page where no password was typed', () => {
    should(
      clearJobOf({ kind: 'secret', name: 'TOKEN', exists: false }, [{ field: 'value', text: PASSWORD, secret: true }]),
    ).be.undefined();
    should(clearJobOf(page, [{ field: 'user', text: 'kirinnee', secret: false }])).be.undefined();
  });
});
