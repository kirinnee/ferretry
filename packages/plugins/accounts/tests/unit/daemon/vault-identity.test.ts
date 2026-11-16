import { describe, it } from 'bun:test';
import type { InputTargetFacts } from '@ferretry/core-vault/contract';
import should from 'should';
import { identityOf } from '../../../daemon/lib/vault-inputs.ts';
import { FACTS } from './support/facts.ts';

/** The field's identity: what would have to change for these facts to be about another field. */

const SECRET_STORE: InputTargetFacts = { kind: 'secret', name: 'DEPLOY_TOKEN', exists: true };

describe('identityOf', () => {
  it('should give a terminal an identity from its place and its program, and no other fact', () => {
    const sudo = identityOf(FACTS, 'sudo@kirin-box');
    should(sudo).match(/^[0-9a-f]{16}$/u);
    should(identityOf({ ...FACTS, promptLine: 'Password:' }, 'sudo@kirin-box')).equal(sudo);
    should(identityOf(FACTS, 'sudo@other-box')).not.equal(sudo);
    should(identityOf({ ...FACTS, foreground: { ...FACTS.foreground, comm: 'su' } }, 'sudo@kirin-box')).not.equal(sudo);
  });

  it('should give a secret-store target none: nothing about it is a field to recognise again', () => {
    should(identityOf(SECRET_STORE, 'DEPLOY_TOKEN')).be.undefined();
  });
});
