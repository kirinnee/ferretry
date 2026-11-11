/**
 * B190, the half pinning cannot cover: a variable bound to the secret store is process environment only
 * (it can never go in a settings file), so a repo whose own `.claude/settings*.json` sets it would start
 * the runtime signed out. The start is refused instead, naming the file and the variable.
 *
 * NO REAL CREDENTIAL APPEARS HERE. Every value is a fixture string.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { FolderSettingsOverrideError, assertFolderLeavesLoginAlone } from '../../../daemon/lib/folder-settings.ts';

const files =
  (present: Record<string, string>) =>
  async (path: string): Promise<string | undefined> =>
    present[path];

const check = (present: Record<string, string>, folders: readonly string[] = ['/work/repo']) =>
  assertFolderLeavesLoginAlone({
    runtime: 'claude-loge',
    secretEnvNames: ['ANTHROPIC_AUTH_TOKEN'],
    folders,
    read: files(present),
  });

const refusal = async (run: Promise<void>): Promise<FolderSettingsOverrideError> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof FolderSettingsOverrideError) return error;
    throw error;
  }
  throw new Error('expected the start to be refused');
};

describe('assertFolderLeavesLoginAlone', () => {
  it('should refuse a start when the folder’s local settings set a secret-backed variable', async () => {
    // Act
    const refused = await refusal(
      check({ '/work/repo/.claude/settings.local.json': JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: '' } }) }),
    );

    // Assert
    should(refused.message).equal(
      "this folder's /work/repo/.claude/settings.local.json sets ANTHROPIC_AUTH_TOKEN, which overrides runtime claude-loge's login, so it would start signed out. Remove it there, or keep that key out of the secret store.",
    );
    should(refused.variables).eql(['ANTHROPIC_AUTH_TOKEN']);
  });

  it('should read the shared settings and the git root’s as well', async () => {
    // Act
    const shared = await refusal(
      check({ '/work/repo/.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }) }),
    );
    const root = await refusal(
      check({ '/work/.claude/settings.local.json': JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }) }, [
        '/work/repo/sub',
        '/work',
      ]),
    );

    // Assert
    should(shared.file).equal('/work/repo/.claude/settings.json');
    should(root.file).equal('/work/.claude/settings.local.json');
  });

  it('should let a folder through that sets other variables, none, or unreadable settings', async () => {
    // Act / Assert
    await check({});
    await check({ '/work/repo/.claude/settings.json': JSON.stringify({ env: { OTHER: '1' }, permissions: {} }) });
    await check({ '/work/repo/.claude/settings.json': JSON.stringify({ model: 'x' }) });
    await check({ '/work/repo/.claude/settings.local.json': '{ not json' });
    await check({ '/work/repo/.claude/settings.local.json': JSON.stringify({ env: 'nope' }) });
  });

  it('should ask nothing when the runtime binds no secret', async () => {
    // Act / Assert
    await assertFolderLeavesLoginAlone({
      runtime: 'claude-host',
      secretEnvNames: [],
      folders: ['/work/repo'],
      read: async () => {
        throw new Error('nothing to read');
      },
    });
  });
});
