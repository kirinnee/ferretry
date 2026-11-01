import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ComponentSourceRule,
  componentSourceProblem,
  fencedBy,
  type StateHomeFence,
} from '../../src/lib/state-home-fence.ts';

const HOME = '/home/me/.ferretry';
const ASSETS = `${HOME}/fleet/assets`;
const FENCE: StateHomeFence = { homes: [HOME, `${HOME}/state`, `${HOME}/config`], open: [ASSETS] };
const RULE: ComponentSourceRule = { fence: FENCE, userHome: '/home/me', assetsDirectory: ASSETS };

describe('fencedBy', () => {
  it.each([
    [`${HOME}/api-token`, HOME],
    [`${HOME}/state/secrets.key`, HOME],
    [HOME, HOME],
    [`${HOME}/..cache/api-token`, HOME],
    [`${HOME}/fleet/homes/claude-one/auth.json`, HOME],
  ])('should fence %s inside the home', (path, home) => {
    // Act + Assert
    should(fencedBy(FENCE, path)).equal(home);
  });

  it.each([[`${ASSETS}/CLAUDE.md`], [ASSETS], ['/home/me/notes/CLAUDE.md'], ['/home/me/.ferretry-other/x'], ['/']])(
    'should leave %s open',
    path => {
      // Act + Assert
      should(fencedBy(FENCE, path)).be.undefined();
    },
  );
});

describe('componentSourceProblem', () => {
  it.each([
    ['~/.ferretry/api-token'],
    ['$HOME/.ferretry/state/secrets.key'],
    [`${HOME}/api-token`],
    ['../../api-token'],
    ['~/.ferretry'],
  ])('should refuse %s, which names the state home', reference => {
    // Act
    const problem = componentSourceProblem(RULE, reference);

    // Assert
    should(problem).match(/inside this daemon's state home \(\/home\/me\/\.ferretry\)/u);
    should(problem).containEql(`"${reference}"`);
  });

  it.each([['CLAUDE.md'], ['./instructions/main.md'], ['~/notes/CLAUDE.md'], ['/etc/hosts'], [`${ASSETS}/x.md`]])(
    'should allow %s',
    reference => {
      // Act + Assert
      should(componentSourceProblem(RULE, reference)).be.undefined();
    },
  );
});
