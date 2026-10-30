import { describe, it } from 'bun:test';
import { LANE_PROPOSAL_ANSWERS, laneProposalReference } from '@ferretry/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { daemonConnection, daemonId } from '../../../src/lib/daemon-connection.ts';
import { laneEditDestination } from '../../../src/lib/lane-proposal-link.ts';
import { PageHost, type PageHostSlots } from '../../../src/lib/pages/page-host.tsx';
import {
  daemonProjectLanesPath,
  parseRoute,
  type PageRoute,
  routePageKey,
  routePath,
} from '../../../src/lib/pages/routes.ts';
import { PROJECT } from '../board-support.ts';

const daemonB = daemonId('daemon-b');

describe('the project lanes address', () => {
  it('builds /d/<id>/projects/<project>/lanes for a project and for the Unfiled board', () => {
    should(daemonProjectLanesPath(daemonB, PROJECT)).equal(`/d/daemon-b/projects/${PROJECT}/lanes`);
    should(daemonProjectLanesPath(daemonB, `  ${PROJECT}  `)).equal(`/d/daemon-b/projects/${PROJECT}/lanes`);
    should(daemonProjectLanesPath(daemonB, 'unfiled')).equal('/d/daemon-b/projects/unfiled/lanes');
  });

  it('refuses an id that is not a board project id', () => {
    should(() => daemonProjectLanesPath(daemonB, 'not-a-project')).throw('projectId must be a board project id');
    should(() => daemonProjectLanesPath(daemonB, '')).throw('projectId must be a board project id');
  });

  it('parses back to the same route, keyed by daemon and project', () => {
    // Arrange
    const route = parseRoute(`/d/daemon-b/projects/${PROJECT}/lanes`);

    // Assert
    should(route).deepEqual({ kind: 'project-lanes', daemonId: daemonB, projectId: PROJECT });
    should(routePath(route)).equal(`/d/daemon-b/projects/${PROJECT}/lanes`);
    should(routePageKey(route)).equal(`project-lanes:["daemon-b","${PROJECT}"]`);
    should(parseRoute('/d/daemon-b/projects/unfiled/lanes')).deepEqual({
      kind: 'project-lanes',
      daemonId: daemonB,
      projectId: 'unfiled',
    });
  });

  it('falls back to the projects list for an id that is not a project', () => {
    should(parseRoute('/d/daemon-b/projects/nonsense/lanes')).deepEqual({ kind: 'projects', daemonId: daemonB });
  });
});

describe('the project lanes page slot', () => {
  const connection = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'secret' });
  const route = parseRoute(`/d/daemon-b/projects/${PROJECT}/lanes`) as PageRoute;
  const unused = (): never => {
    throw new Error('not rendered');
  };
  const slots = (extra: Partial<PageHostSlots>): PageHostSlots => ({
    ConnectionPicker: unused,
    Setup: unused,
    Sessions: unused,
    NewSession: unused,
    SessionChat: unused,
    Settings: unused,
    Warden: unused,
    Analytics: unused,
    Learning: unused,
    ...extra,
  });

  it('renders the slot with the matched connection and the project id', () => {
    // Act
    const html = renderToStaticMarkup(
      <PageHost
        route={route}
        connection={connection}
        slots={slots({
          ProjectLanes: ({ connection: actual, projectId }) => (
            <p data-page="lanes">{`${actual.daemonId}:${projectId}`}</p>
          ),
        })}
      />,
    );

    // Assert
    should(html).equal(`<p data-page="lanes">daemon-b:${PROJECT}</p>`);
  });

  it('refuses the route rather than render it unmounted', () => {
    should(() => renderToStaticMarkup(<PageHost route={route} connection={connection} slots={slots({})} />)).throw(
      'the project lanes route is not mounted',
    );
  });
});

describe('where Edit on a lane-proposal card goes', () => {
  const item = { sourceRef: laneProposalReference(PROJECT, 3) };
  const choose = (choice: string) =>
    ({ kind: 'respond', response: { kind: 'multiple-choice', choice } }) as Parameters<typeof laneEditDestination>[2];

  it('opens the editor for the proposal’s project on Edit', () => {
    should(laneEditDestination(daemonB, item, choose(LANE_PROPOSAL_ANSWERS.edit))).equal(
      `/d/daemon-b/projects/${PROJECT}/lanes`,
    );
  });

  it('leaves Accept to the daemon, and every other card alone', () => {
    should(laneEditDestination(daemonB, item, choose(LANE_PROPOSAL_ANSWERS.accept))).equal(undefined);
    should(laneEditDestination(daemonB, { sourceRef: 'task:abc' }, choose(LANE_PROPOSAL_ANSWERS.edit))).equal(
      undefined,
    );
    should(laneEditDestination(daemonB, { sourceRef: null }, choose(LANE_PROPOSAL_ANSWERS.edit))).equal(undefined);
  });

  it('ignores answers that are not a choice', () => {
    const text = { kind: 'respond', response: { kind: 'text', text: LANE_PROPOSAL_ANSWERS.edit } };
    should(laneEditDestination(daemonB, item, text as never)).equal(undefined);
    should(laneEditDestination(daemonB, item, { kind: 'dismiss' } as never)).equal(undefined);
  });
});
