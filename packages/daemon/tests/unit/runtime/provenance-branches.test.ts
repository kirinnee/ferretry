import { describe, it } from 'bun:test';
import should from 'should';
import { parseDaemonConfig } from '../../../src/lib/runtime/config.ts';
import { describeConfiguration } from '../../../src/lib/runtime/provenance.ts';

describe('effective configuration with provenance, for a partly written grant', () => {
  it('should say which axis of a grant was written down when the file names only one', () => {
    // Arrange: an operator who wrote `{"use": false}` chose one of the two axes and left the other alone.
    const document = { grants: { terminal: { use: false } } };

    // Act
    const rows = describeConfiguration({
      document,
      config: parseDaemonConfig(document),
      overrides: {},
      configFile: '/home/a/.ferretry/config/daemon.json',
      stateHome: '/home/a/.ferretry',
      stateHomeFromEnvironment: false,
    });
    const terminal = rows.find(candidate => candidate.name === 'grants.terminal');
    const fleet = rows.find(candidate => candidate.name === 'grants.fleet');

    // Assert
    should(terminal?.origin).equal('config file');
    should(terminal?.note).equal('use was written down; the other is the default');
    should(terminal?.value).match(/^use=off /u);
    should(fleet?.origin).equal('default');
    should(fleet?.note).be.undefined();
  });
});
