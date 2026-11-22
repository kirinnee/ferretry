/**
 * The import record keeps, beside the names an import created, the etag each owner file had when it was written, and reads
 * back only what is usable.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { parseImportRecord } from '../../../daemon/lib/account/import-record.ts';

const record = (entry: unknown): string =>
  JSON.stringify({ version: 1, components: { 'settings/codex-settings': entry } });

describe('parseImportRecord etags', () => {
  it('should read back the etag of each file an import wrote, by item name', () => {
    const read = parseImportRecord(
      record({ sources: [], digest: 'd', owned: ['profile-x'], etags: { 'codex-settings': 'e1', 'profile-x': 'e2' } }),
    );

    should(read?.components['settings/codex-settings']?.etags).eql({ 'codex-settings': 'e1', 'profile-x': 'e2' });
  });

  it('should keep only string etags, and none at all when nothing usable is there', () => {
    const mixed = parseImportRecord(record({ sources: [], digest: 'd', etags: { a: 'e1', b: 7 } }));
    const none = parseImportRecord(record({ sources: [], digest: 'd', etags: { b: 7 } }));
    const absent = parseImportRecord(record({ sources: [], digest: 'd' }));

    should(mixed?.components['settings/codex-settings']?.etags).eql({ a: 'e1' });
    should(none?.components['settings/codex-settings']?.etags).be.undefined();
    should(absent?.components['settings/codex-settings']?.etags).be.undefined();
  });
});
