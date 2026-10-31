import { describe, it } from 'bun:test';
import should from 'should';
import {
  CatalogInstallRefusalError,
  SkillFolderChanged,
  SkillFolderRefused,
} from '../../../src/lib/catalog-installs/ports.ts';

/** The errors the installer's ports speak in: each says what it is, so a route can answer each its own way. */

describe('the errors the installer ports speak in', () => {
  it('a refusal carries its code from the contract and its sentence', () => {
    const error = new CatalogInstallRefusalError('catalog_downgrade', 'that is older');

    should(error).be.instanceOf(Error);
    should(error.code).equal('catalog_downgrade');
    should(error.message).equal('that is older');
    should(error.name).equal('CatalogInstallRefusalError');
  });

  it('a folder that cannot be used says why', () => {
    const error = new SkillFolderRefused('a link on the way');

    should(error.name).equal('SkillFolderRefused');
    should(error.message).equal('a link on the way');
  });

  it('a folder that moved under the write says so and to try again', () => {
    const error = new SkillFolderChanged();

    should(error.name).equal('SkillFolderChanged');
    should(error.message).match(/Try again/u);
  });
});
