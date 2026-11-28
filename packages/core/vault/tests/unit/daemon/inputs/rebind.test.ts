import { describe, it } from 'bun:test';
import should from 'should';
import type { InputTargetFacts } from '../../../../contract/index.ts';
import { actionOriginsOf, bindingOf, mayRebind } from '../../../../daemon/lib/inputs/rebind.ts';
import { FACTS } from './support.ts';

const secret = (exists: boolean): InputTargetFacts => ({ kind: 'secret', name: 'TOKEN', exists });

const page = (visible: boolean): InputTargetFacts => ({
  kind: 'page',
  pageId: 'page-1',
  origin: 'https://example.com',
  secure: true,
  navigationId: 'loader-1',
  fields: [
    {
      fieldId: 'value',
      frameOrigin: 'https://example.com',
      frameId: 'main',
      backendNodeId: 7,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 1, h: 1 },
      visible,
    },
  ],
});

describe('the complete origin is compared independently of the clipped action display', () => {
  it('detects different long origins sharing the whole display prefix', () => {
    const facts = page(true);
    if (facts.kind !== 'page') throw new Error('page');
    const field = facts.fields[0]!;
    const withOrigin = (digest: string): InputTargetFacts => ({
      ...facts,
      fields: [
        {
          ...field,
          field: { ...field.field, formAction: `https://${'a'.repeat(248)}`, formActionOriginDigest: digest },
        },
      ],
    });
    should(actionOriginsOf(withOrigin('a'.repeat(64)))).not.equal(actionOriginsOf(withOrigin('b'.repeat(64))));
    should(bindingOf(withOrigin('a'.repeat(64)))).equal(bindingOf(withOrigin('b'.repeat(64))));
  });
});

describe('when a changed target is still the same target', () => {
  it('should bind the secret store by its name alone: whether it already holds a value may change', () => {
    should(bindingOf(secret(false))).equal(bindingOf(secret(true)));
    should(bindingOf(secret(false))).not.equal(bindingOf({ kind: 'secret', name: 'OTHER', exists: false }));
    should(mayRebind(bindingOf(secret(false)), secret(true))).be.true();
    should(mayRebind(bindingOf(secret(false)), { kind: 'secret', name: 'OTHER', exists: false })).be.false();
  });

  it('should rebind a terminal redrawn a row lower, and not one whose program changed', () => {
    const lower = { ...FACTS, cursorRow: FACTS.cursorRow + 1 };
    const other = { ...FACTS, foreground: { ...FACTS.foreground, argv: 'sudo -k' } };

    should(mayRebind(bindingOf(FACTS), lower)).be.true();
    should(mayRebind(bindingOf(FACTS), other)).be.false();
  });

  it('should rebind a page only while every field is visible to the owner', () => {
    should(mayRebind(bindingOf(page(true)), page(true))).be.true();
    should(mayRebind(bindingOf(page(true)), page(false))).be.false();
  });
});

describe('where a page sends what is typed, as origins (E-314)', () => {
  const sending = (formAction?: string): InputTargetFacts => {
    const facts = page(true);
    if (facts.kind !== 'page') throw new Error('page');
    const field = facts.fields[0]!;
    return {
      ...facts,
      fields: [{ ...field, field: { ...field.field, ...(formAction === undefined ? {} : { formAction }) } }],
    };
  };

  it('should name the origin of a form action, whatever its path, and nothing for a form-less field or a terminal', () => {
    should(actionOriginsOf(sending('https://a.example/x/y'))).equal('https://a.example');
    should(actionOriginsOf(sending('https://a.example/other'))).equal(actionOriginsOf(sending('https://a.example/x')));
    should(actionOriginsOf(sending('https://b.example/x'))).not.equal(actionOriginsOf(sending('https://a.example/x')));
    should(actionOriginsOf(sending())).equal('');
    should(actionOriginsOf(FACTS)).equal('');
  });

  it('should keep an action that is not an address as it is, so a change in it still differs', () => {
    should(actionOriginsOf(sending('not an address'))).equal('not an address');
  });
});
