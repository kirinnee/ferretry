/**
 * The hand-over's own answers: a component whose document could not be made is refused without asking its owner, and an
 * owner's sentence is masked and bounded.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { ComponentWriter } from '../../../daemon/lib/account/owner-components.ts';
import { handOver, type OwnedComponents } from '../../../daemon/lib/service/owner-hand-over.ts';

const MODEL = parseAccountModel({ version: 1 });
const applied = { model: MODEL, documents: [] };

describe('handOver', () => {
  it('should refuse a component with no document without asking its owner, and say why', async () => {
    // Arrange
    let asked = 0;
    const writer: ComponentWriter = {
      put: async () => {
        asked += 1;
        return { outcome: 'written' };
      },
    };
    const owners: OwnedComponents = {
      writes: [
        {
          kind: 'settings',
          name: 'a',
          reference: 'settings/a',
          harness: 'claude',
          file: 'claude-code/settings/a.yaml',
          problem: 'the settings this was made from could not be read',
        },
      ],
      rebuild: async () => applied,
    };

    // Act
    const answer = await handOver({ writer, owners, applied, secretValues: [] });

    // Assert
    should(asked).equal(0);
    should(answer.sentences).eql([
      'Not written: claude-code/settings/a.yaml (the settings this was made from could not be read).',
    ]);
  });

  it('should mask a secret value in the owner sentence and bound its length', async () => {
    // Arrange
    const writer: ComponentWriter = {
      put: async () => ({ outcome: 'refused', reason: `${'x'.repeat(300)} s3cr3t-value` }),
    };
    const owners: OwnedComponents = {
      writes: [{ kind: 'mcp', name: 'a', reference: 'mcp/a', file: 'mcp/a.yaml', text: '{}' }],
      rebuild: async () => applied,
    };

    // Act
    const [sentence] = (await handOver({ writer, owners, applied, secretValues: ['s3cr3t-value', ''] })).sentences;

    // Assert
    should(sentence).not.containEql('s3cr3t-value');
    should(sentence?.length).be.below(300);
    should(sentence).containEql('…');
  });
});

describe('handOver warnings', () => {
  it('should say a file was written with a warning, masking any secret in it', async () => {
    // Arrange
    const writer: ComponentWriter = {
      put: async write => ({
        outcome: write.kind === 'mcp' ? 'written' : 'held',
        warnings: ['command "x" is not on this machine'],
      }),
    };
    const owners: OwnedComponents = {
      writes: [
        { kind: 'mcp', name: 'a', reference: 'mcp/a', file: 'mcp/a.yaml', text: '{}' },
        { kind: 'skills', name: 'b', reference: 'skills/b', file: 'skills/b.yaml', text: '{}' },
      ],
      rebuild: async () => applied,
    };

    // Act
    const { sentences } = await handOver({ writer, owners, applied, secretValues: [] });

    // Assert
    should(sentences).containEql(
      'Written with a warning: mcp/a.yaml (command "x" is not on this machine); skills/b.yaml (command "x" is not on this machine).',
    );
  });
});
