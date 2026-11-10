import { describe, it } from 'bun:test';
import should from 'should';
import type { AccessApi } from '../../../../contract/index.ts';
import { fakeAccess } from '../../../../contract/testing/index.ts';
import { accessPortFor, CLEAR_NAMESPACES, withinNamespace } from '../../../../daemon/lib/push/reach.ts';

/** A port whose `clear` records the tags it was asked to take down. */
function recording() {
  const cleared: { tags: readonly string[]; except?: string | undefined; ferret?: string | undefined }[] = [];
  const port: AccessApi = {
    ...fakeAccess({ enrolments: 3 }),
    clear: async (tags, except, ferret) => {
      cleared.push({ tags, except, ferret });
      return 3;
    },
  };
  return { port, cleared };
}

describe('the port Access hands each plugin: a clear names only the plugin’s own lines', () => {
  it('should let Accounts clear its approvals’ lines (pa-…) and no other plugin’s', async () => {
    const { port, cleared } = recording();
    const accounts = accessPortFor(port, 'accounts', false);

    should(await accounts.clear?.(['pa-pa_0123456789abcdef01234567'], undefined, 'f1')).equal(3);
    should(await accounts.clear?.(['agenda-f1:A3', 'attention-f1:A3', 'push-enrolment'])).equal(0);
    should(await accounts.clear?.(['agenda-f1:A3', 'pa-x'])).equal(3);

    should(cleared).eql([
      { tags: ['pa-pa_0123456789abcdef01234567'], except: undefined, ferret: 'f1' },
      { tags: ['pa-x'], except: undefined, ferret: undefined },
    ]);
  });

  it('should let Agenda clear its asks’ and stops’ lines and not an approval’s', async () => {
    const { port, cleared } = recording();
    const agenda = accessPortFor(port, 'agenda', false);

    should(await agenda.clear?.(['pa-x'])).equal(0);
    should(await agenda.clear?.(['agenda-f1:A3', 'attention-f1', 'pa-x'], 'device_1')).equal(3);

    should(cleared).eql([{ tags: ['agenda-f1:A3', 'attention-f1'], except: 'device_1', ferret: undefined }]);
  });

  it('should hand a plugin with no namespace no clear at all, and keep the rest of the port', () => {
    const { port } = recording();
    const catalogs = accessPortFor(port, 'catalogs', false);

    should(catalogs.clear).be.undefined();
    should(catalogs.buzz).equal(port.buzz);
    should(catalogs.devices).equal(port.devices);
  });

  it('should hand a core caller the whole port', () => {
    const { port } = recording();

    should(accessPortFor(port, 'gate', true)).equal(port);
  });

  it('should hand nothing to clear with where the port has none to narrow', () => {
    const { clear: _clear, ...without } = recording().port;

    should(accessPortFor(without, 'accounts', false).clear).be.undefined();
  });

  it('should match a namespace by its prefix, exactly as written', () => {
    should(withinNamespace(['pa-1', 'xpa-1', 'PA-1', 'pa'], CLEAR_NAMESPACES.accounts ?? [])).eql(['pa-1']);
  });
});
