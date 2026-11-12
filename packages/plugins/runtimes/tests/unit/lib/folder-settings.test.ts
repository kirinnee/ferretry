/**
 * #1587, the half a `--settings` pin cannot cover: a variable the login leaves to the process environment (it names
 * `${secret:}`, or it is a bare `$OTHER` reference) loses to a repository's own `.claude/settings*.json` `env`, so the
 * runtime would start signed out. The start is refused instead, naming the file and the key and never a value; a folder
 * whose layout cannot be proved refuses too, with the reason.
 *
 * NO REAL CREDENTIAL APPEARS HERE. Every value is a fixture string.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  assertFolderLeavesLoginAlone,
  type FolderCheckedAccount,
  FolderSettingsOverrideError,
  FolderSettingsUnreadableError,
  type FolderSettingsVariables,
} from '../../../daemon/lib/folder-settings.ts';

const folder = (...files: { file: string; names: readonly string[] }[]): FolderSettingsVariables => ({
  variables: async () => files,
});

const secretBacked: FolderCheckedAccount = {
  runtime: 'claude-loge',
  kind: 'claude',
  secretEnvNames: ['ANTHROPIC_AUTH_TOKEN'],
};

const refusal = async (run: Promise<void>): Promise<Error | undefined> =>
  await run.then(
    () => undefined,
    (error: unknown) => error as Error,
  );

describe('assertFolderLeavesLoginAlone', () => {
  it('should refuse the start, naming the file and the key but never a value', async () => {
    // Act
    const refused = await refusal(
      assertFolderLeavesLoginAlone({
        account: secretBacked,
        cwd: '/work/pe',
        folderSettings: folder({
          file: '.claude/settings.local.json',
          names: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
        }),
      }),
    );

    // Assert
    should(refused).be.instanceOf(FolderSettingsOverrideError);
    should(refused?.message).containEql('.claude/settings.local.json');
    should(refused?.message).containEql('ANTHROPIC_AUTH_TOKEN');
    should(refused?.message).containEql('claude-loge');
    should(refused?.message).not.containEql('ANTHROPIC_BASE_URL');
  });

  it('should refuse a folder that blanks a variable the login takes from the environment by bare reference', async () => {
    // Act
    const refused = await refusal(
      assertFolderLeavesLoginAlone({
        account: {
          runtime: 'claude-loge',
          kind: 'claude',
          secretEnvNames: [],
          referencedEnv: ['ANTHROPIC_AUTH_TOKEN'],
        },
        cwd: '/work/pe/child',
        folderSettings: folder({ file: '/work/.claude/settings.local.json', names: ['ANTHROPIC_AUTH_TOKEN'] }),
      }),
    );

    // Assert
    should(refused).be.instanceOf(FolderSettingsOverrideError);
    should(refused?.message).containEql('/work/.claude/settings.local.json');
    should(refused?.message).containEql('ANTHROPIC_AUTH_TOKEN');
  });

  it('should refuse the start, with the reason, when the folder’s settings cannot be looked for', async () => {
    // Act
    const refused = await refusal(
      assertFolderLeavesLoginAlone({
        account: secretBacked,
        cwd: '/work/pe',
        folderSettings: {
          variables: async () => {
            throw new FolderSettingsUnreadableError('looking for the repository failed at /work/.git (EACCES)');
          },
        },
      }),
    );

    // Assert
    should(refused).be.instanceOf(FolderSettingsUnreadableError);
    should(refused?.name).equal('FolderSettingsUnreadableError');
    should(refused?.message).containEql('EACCES');
  });

  it('should start when the folder sets only variables the login pins itself', async () => {
    // Act / Assert
    await assertFolderLeavesLoginAlone({
      account: secretBacked,
      cwd: '/work/pe',
      folderSettings: folder({ file: '.claude/settings.json', names: ['ANTHROPIC_BASE_URL'] }),
    });
  });

  it('should start when the folder sets only other variables than the referenced ones', async () => {
    // Act / Assert
    await assertFolderLeavesLoginAlone({
      account: { runtime: 'claude-loge', kind: 'claude', secretEnvNames: [], referencedEnv: ['ANTHROPIC_AUTH_TOKEN'] },
      cwd: '/work/pe',
      folderSettings: folder({ file: '.claude/settings.json', names: ['SOMETHING_ELSE'] }),
    });
  });

  it('should not look at a folder for an account that leaves nothing to the process environment', async () => {
    // Arrange
    let looked = false;
    const watching: FolderSettingsVariables = {
      variables: async () => {
        looked = true;
        return [{ file: '.claude/settings.json', names: ['ANTHROPIC_AUTH_TOKEN'] }];
      },
    };

    // Act
    await assertFolderLeavesLoginAlone({
      account: { runtime: 'claude-default', kind: 'claude', secretEnvNames: [] },
      cwd: '/work/pe',
      folderSettings: watching,
    });

    // Assert
    should(looked).be.false();
  });

  it('should not look at a folder for a Codex runtime, a launch with no folder, or no reader', async () => {
    // Arrange
    const clash = folder({ file: '.claude/settings.json', names: ['ANTHROPIC_AUTH_TOKEN'] });

    // Act / Assert
    await assertFolderLeavesLoginAlone({
      account: { ...secretBacked, kind: 'codex' },
      cwd: '/work/pe',
      folderSettings: clash,
    });
    await assertFolderLeavesLoginAlone({ account: secretBacked, cwd: undefined, folderSettings: clash });
    await assertFolderLeavesLoginAlone({ account: secretBacked, cwd: '/work/pe', folderSettings: undefined });
  });
});
