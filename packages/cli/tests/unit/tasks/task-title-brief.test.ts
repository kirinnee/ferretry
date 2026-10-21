import { describe, it } from 'bun:test';
import should from 'should';
import { titleFromReferencedBrief } from '../../../src/lib/tasks/task-title.ts';

const POINTER = 'You are a Ferretry implementer. Read /tmp/brief.md and follow it exactly.';

describe('titleFromReferencedBrief', () => {
  it('should title a pointer brief from the heading of the file it points at', async () => {
    // Arrange
    const reads: string[] = [];
    const read = async (path: string): Promise<string> => {
      reads.push(path);
      return '# Fix the login redirect\n\nDetails follow.';
    };

    // Act
    const title = await titleFromReferencedBrief(POINTER, read);

    // Assert
    should(title).equal('Fix the Login Redirect');
    should(reads).eql(['/tmp/brief.md']);
  });

  it('should leave a brief that names its own work alone, without reading anything', async () => {
    // Arrange
    const read = async (): Promise<string> => {
      throw new Error('must not read');
    };

    // Act
    const title = await titleFromReferencedBrief('Fix the login redirect bug', read);

    // Assert
    should(title).be.undefined();
  });

  it('should return nothing when the brief points at no file', async () => {
    // Act
    const title = await titleFromReferencedBrief('You are a reviewer. Read carefully.', async () => '# X');

    // Assert
    should(title).be.undefined();
  });

  it('should return nothing when the file cannot be read or says nothing readable', async () => {
    // Act
    const unreadable = await titleFromReferencedBrief(POINTER, async () => Promise.reject(new Error('gone')));
    const empty = await titleFromReferencedBrief(POINTER, async () => '   \n');

    // Assert
    should(unreadable).be.undefined();
    should(empty).be.undefined();
  });
});
