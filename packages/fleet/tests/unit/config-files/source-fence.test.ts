import { describe, it } from 'bun:test';
import should from 'should';
import { checkConfigFile, type ConfigCheckContext } from '../../../src/lib/config-files/check.ts';
import { evaluateConfigFiles } from '../../../src/lib/config-files/evaluate.ts';
import { acceptedOf, digest, FLEET_FILES, file } from './support.ts';

const HOME = '/home/me/.ferretry';
const CONTEXT: ConfigCheckContext = {
  componentSources: {
    fence: { homes: [HOME, `${HOME}/state`, `${HOME}/config`], open: [`${HOME}/fleet/assets`] },
    userHome: '/home/me',
    assetsDirectory: `${HOME}/fleet/assets`,
  },
};

describe('checkConfigFile: a component source inside the state home', () => {
  it.each([
    ['components/instructions/main.yaml', 'file: ~/.ferretry/api-token\n', 'file'],
    ['components/hooks/scripts.yaml', 'harness: claude\ndirectory: ~/.ferretry\n', 'directory'],
    ['components/settings/base.yaml', 'harness: claude\nfile: ../../state/secrets.key\n', 'file'],
  ])('should refuse %s as an error at the field that names it', (path, text, field) => {
    // Act
    const checked = checkConfigFile(path, text, CONTEXT);

    // Assert
    should(checked.ok).be.false();
    should(checked.issues).have.length(1);
    const issue = checked.issues[0];
    should(issue?.severity).equal('error');
    should(issue?.message).startWith(`${field}: `);
    should(issue?.message).containEql("inside this daemon's state home");
    should(issue?.line).equal(text.startsWith('harness') ? 2 : 1);
  });

  it('should accept a source outside the home and one in the asset tree', () => {
    // Act
    const outside = checkConfigFile('components/instructions/main.yaml', 'file: ~/notes/CLAUDE.md\n', CONTEXT);
    const asset = checkConfigFile('components/instructions/main.yaml', 'file: instructions/main.md\n', CONTEXT);

    // Assert
    should(outside.ok).be.true();
    should(asset.ok).be.true();
  });

  it('should check only what the file decides when no machine context is given', () => {
    // Act
    const checked = checkConfigFile('components/instructions/main.yaml', 'file: ~/.ferretry/api-token\n');

    // Assert
    should(checked.ok).be.true();
  });
});

describe('evaluateConfigFiles: a fenced component source never comes into effect', () => {
  it('should keep the last good version in effect when an edit names the state home', () => {
    // Arrange
    const accepted = acceptedOf(FLEET_FILES);
    const files = FLEET_FILES.map(entry =>
      entry.path === 'components/instructions/main.yaml' ? file(entry.path, 'file: ~/.ferretry/api-token\n') : entry,
    );

    // Act
    const evaluation = evaluateConfigFiles({ files, accepted, digest, context: CONTEXT });

    // Assert
    should(evaluation.effective.model.components.instructions.main?.file).equal('instructions/main.md');
    should(evaluation.issues.some(issue => issue.severity === 'error' && issue.message.startsWith('file: '))).be.true();
  });

  it('should retire an accepted version that names the state home, rather than keep it in effect', () => {
    // Arrange: an older daemon accepted it before the fence existed.
    const fenced = FLEET_FILES.map(entry =>
      entry.path === 'components/instructions/main.yaml' ? file(entry.path, 'file: ~/.ferretry/api-token\n') : entry,
    );

    // Act
    const evaluation = evaluateConfigFiles({ files: fenced, accepted: acceptedOf(fenced), digest, context: CONTEXT });

    // Assert
    should(evaluation.effective.model.components.instructions.main).be.undefined();
  });
});
