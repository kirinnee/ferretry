import { describe, it } from 'bun:test';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import { type ApiResponse } from '@ferretry/kernel/contract';
import should from 'should';
import {
  type FileBrowserDeps,
  sessionFilesystemRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-filesystem.ts';
import { AGENT_READ_FENCE, SessionFilesystem } from '../../../../../daemon/lib/session/filesystem/index.ts';
import { jsonOf, requestOf } from '../../support/requests.ts';
import { refusalOf } from '../../support/calls.ts';
import { FakeRootPinner, FakeSessionGit, textFile, treeOf } from '../../session/filesystem/support.ts';

/**
 * F-0327: `GET /v1/ferrets/:ferretId/fs/file?scope=media` reads the ferret's MEDIA folder, not its working tree.
 *
 * Two pinners stand for the two trees: a read of the working tree must never reach the media pinner and a media read
 * must never reach the working tree, and the media folder is chosen by `scope=media` alone, never by a path a caller
 * sends.
 */

const FILE = 'GET /v1/ferrets/:ferretId/fs/file';
const WORK_CWD = '/work/ferretry';

const person: FileBrowserDeps['reach'] = async context => ({
  id: context.params.get('ferretId') ?? '',
  cwd: WORK_CWD,
});

const agent: FileBrowserDeps['reach'] = async context => ({
  id: context.params.get('ferretId') ?? '',
  cwd: WORK_CWD,
  fence: AGENT_READ_FENCE,
});

function fixture(reach: FileBrowserDeps['reach'] = person, mediaBound = true) {
  const work = new FakeRootPinner({ tree: treeOf(['chart.png', textFile('work tree bytes\n')]) });
  const media = new FakeRootPinner({ tree: treeOf(['chart.png', textFile('media bytes\n')]) });
  const git = new FakeSessionGit({ isTracked: () => true });
  const mediaFerrets: string[] = [];
  const routes = sessionFilesystemRoutes({
    filesystem: new SessionFilesystem(work, git),
    ...(mediaBound
      ? {
          media: (ferret: string) => {
            mediaFerrets.push(ferret);
            return new SessionFilesystem(media, git);
          },
        }
      : {}),
    reach,
    redaction: new FakeRedaction(new Map()),
  });
  const ask = async (query: Record<string, string>, ferretId = 's1'): Promise<ApiResponse> =>
    await routes[FILE](requestOf({ query, params: { ferretId } }));
  return { work, media, mediaFerrets, ask };
}

describe('the media folder read (scope=media)', () => {
  it('should read the file from the ferret media folder and never from its working tree', async () => {
    // Arrange
    const { work, media, mediaFerrets, ask } = fixture();

    // Act
    const response = await ask({ path: 'chart.png', scope: 'media' });

    // Assert
    should(response.status).eql(200);
    should(jsonOf(response)).have.property('content', 'media bytes\n');
    should(media.pinnedCwds).have.length(1);
    should(work.pinnedCwds).eql([]);
    should(mediaFerrets).eql(['s1']);
  });

  it('should still read the working tree when no scope is asked for', async () => {
    // Arrange
    const { work, media, mediaFerrets, ask } = fixture();

    // Act
    const response = await ask({ path: 'chart.png' });

    // Assert
    should(jsonOf(response)).have.property('content', 'work tree bytes\n');
    should(work.pinnedCwds).eql([WORK_CWD]);
    should(media.pinnedCwds).eql([]);
    should(mediaFerrets).eql([]);
  });

  it('should serve the media folder to an agent behind the same fence as the working tree', async () => {
    // Arrange
    const { media, ask } = fixture(agent);

    // Act
    const response = await ask({ path: 'chart.png', scope: 'media', format: 'base64' });

    // Assert
    should(response.status).eql(200);
    should(jsonOf(response)).have.property('base64', Buffer.from('media bytes\n').toString('base64'));
    should(media.pinnedCwds).have.length(1);
  });

  it('should answer 404 when this daemon keeps no media folder', async () => {
    // Arrange
    const { work, ask } = fixture(person, false);

    // Act
    const refusal = await refusalOf(ask({ path: 'chart.png', scope: 'media' }));

    // Assert
    should(refusal).eql({ status: 404, code: 'not_found' });
    should(work.pinnedCwds).eql([]);
  });

  it('should refuse a revision of the media folder, which has no history', async () => {
    // Arrange
    const { media, ask } = fixture();

    // Act
    const refusal = await refusalOf(ask({ path: 'chart.png', scope: 'media', rev: 'head' }));

    // Assert
    should(refusal).eql({ status: 400, code: 'invalid_rev' });
    should(media.pinnedCwds).eql([]);
  });

  it('should refuse any scope but media', async () => {
    // Arrange
    const { ask } = fixture();

    // Act
    const refusal = await refusalOf(ask({ path: 'chart.png', scope: 'home' }));

    // Assert
    should(refusal).eql({ status: 400, code: 'invalid_scope' });
  });
});
