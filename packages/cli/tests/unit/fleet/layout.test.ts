import { describe, it } from 'bun:test';
import should from 'should';
import { defaultConfigPath, resolveFleetLayout } from '../../../src/lib/fleet/layout';

const INPUTS = { stateHome: undefined, userHome: '/home/tester', product: 'ferretry' } as const;

describe('resolving the fleet layout', () => {
  it('should derive every directory from the state home', () => {
    // Act
    const layout = resolveFleetLayout({ ...INPUTS, stateHome: '/state' });

    // Assert
    should(layout).match({
      stateHome: '/state',
      userHome: '/home/tester',
      fleetDirectory: '/state/fleet',
      binDirectory: '/state/fleet/bin',
      homesDirectory: '/state/fleet/homes',
      assetsDirectory: '/state/fleet/assets',
      manifestPath: '/state/fleet/manifest.json',
    });
  });

  it('should default the state home from the product name, not a hardcoded directory', () => {
    // Act
    const layout = resolveFleetLayout(INPUTS);

    // Assert
    should(layout.stateHome).equal('/home/tester/.ferretry');
    should(layout.manifestPath).equal('/home/tester/.ferretry/fleet/manifest.json');
  });

  it('should treat a blank state home as unset rather than as the filesystem root', () => {
    // Act + Assert
    should(resolveFleetLayout({ ...INPUTS, stateHome: '   ' }).stateHome).equal('/home/tester/.ferretry');
  });

  it('should not double a trailing slash on a state home that carries one', () => {
    // Act + Assert
    should(resolveFleetLayout({ ...INPUTS, stateHome: '/state/' }).fleetDirectory).equal('/state/fleet');
  });

  it('should point each harness at the home its bare CLI already reads', () => {
    // Act + Assert
    should(resolveFleetLayout(INPUTS).defaultHomeDirectories).eql({
      claude: '/home/tester/.claude',
      codex: '/home/tester/.codex',
    });
  });

  it('should refuse to guess when there is no home directory', () => {
    // Act + Assert
    should(() => resolveFleetLayout({ ...INPUTS, userHome: '  ' })).throw(
      'cannot resolve the fleet layout without a home directory',
    );
  });

  it('should put the default configuration beside everything else the fleet owns', () => {
    // Act + Assert
    should(defaultConfigPath(resolveFleetLayout({ ...INPUTS, stateHome: '/state' }))).equal('/state/fleet/config.yaml');
  });
});
