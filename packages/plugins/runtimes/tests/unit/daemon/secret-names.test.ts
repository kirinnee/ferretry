/** The one rule for the numbered names the setup import gives its Vault keys, shared by the planner and the retry probe. */
import { describe, it } from 'bun:test';
import should from 'should';
import { inSecretFamily, secretNameAt } from '../../../daemon/lib/account/secret-names.ts';

describe('secretNameAt', () => {
  it('numbers a short base as it is', () => {
    should(secretNameAt('GITHUB_TOKEN', 2)).equal('GITHUB_TOKEN_2');
  });

  it('shortens a long base so the suffix still fits in 64 characters', () => {
    const base = 'K'.repeat(64);
    should(secretNameAt(base, 12)).equal(`${'K'.repeat(60)}_12`);
  });
});

describe('inSecretFamily', () => {
  it('holds the stem itself and every numbered name after it', () => {
    should(inSecretFamily('API_KEY', 'API_KEY')).be.true();
    should(inSecretFamily('API_KEY', 'API_KEY_2')).be.true();
    should(inSecretFamily('API_KEY', 'API_KEY_17')).be.true();
  });

  it('leaves out a neighbour that only shares the start, or whose tail is not a number', () => {
    should(inSecretFamily('API_KEY', 'API_KEYS')).be.false();
    should(inSecretFamily('API_KEY', 'API_KEY_ALT')).be.false();
    should(inSecretFamily('API_KEY', 'API_KEY_')).be.false();
    should(inSecretFamily('API_KEY', 'OTHER')).be.false();
  });

  it('reads a long stem by the shortened name the planner gave its numbered names', () => {
    const stem = 'L'.repeat(64);
    should(inSecretFamily(stem, stem)).be.true();
    should(inSecretFamily(stem, secretNameAt(stem, 2))).be.true();
  });
});
