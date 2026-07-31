import { describe, it } from 'bun:test';
import should from 'should';
import { FyTaskGateway } from '../../../src/adapters/tasks/fy-task-gateway';
import { fakeClient, taskSummary, taskView } from './fake-daemon';

const board = (sessionId: string | null) => ({
  v: 1,
  sessionId,
  tasks: [{ ...taskSummary('F1'), sessionId }],
  parseErrors: 0,
  updatedAt: '2026-01-02T00:00:00.000Z',
});

const scoped = (id = 'F1') => ({ ...taskView(id), sessionId: 'session-7' });

describe('the task gateway', () => {
  it('should POST a create to the session it was given', async () => {
    // Arrange
    const { client, transport } = fakeClient([scoped('F9')]);
    const gateway = new FyTaskGateway(() => client);

    // Act
    const actual = await gateway.create('session-7', {
      kind: 'feature',
      title: 'Rename the widget',
      description: '',
      ask: { text: 'do it', source: 'chat://1' },
      workflow: 'quick',
      dependsOn: [],
      files: [],
      status: 'todo',
      assignee: null,
      repo: null,
      links: {},
      order: null,
    });

    // Assert
    should(actual.id).equal('F9');
    should(transport.exchanges[0]?.method).equal('POST');
    should(transport.exchanges[0]?.url).equal('http://127.0.0.1:65535/v1/sessions/session-7/tasks');
    should(transport.exchanges[0]?.body).have.property('title', 'Rename the widget');
  });

  it('should escape a session id that would otherwise change the path', async () => {
    // Arrange
    const { client, transport } = fakeClient([board('a/b')]);
    const gateway = new FyTaskGateway(() => client);

    // Act
    await gateway.list({ sessionId: 'a/b' }, []);

    // Assert
    should(transport.exchanges[0]?.url).equal('http://127.0.0.1:65535/v1/sessions/a%2Fb/tasks');
  });

  it('should GET the session board with its filters as a query string', async () => {
    // Arrange
    const { client, transport } = fakeClient([board('session-7')]);
    const gateway = new FyTaskGateway(() => client);

    // Act
    const actual = await gateway.list({ sessionId: 'session-7' }, [
      ['status', 'todo'],
      ['status', 'live'],
      ['assignee', 'ada'],
    ]);

    // Assert
    should(actual.tasks).have.length(1);
    should(transport.exchanges[0]?.method).equal('GET');
    should(transport.exchanges[0]?.url).equal(
      'http://127.0.0.1:65535/v1/sessions/session-7/tasks?status=todo&status=live&assignee=ada',
    );
  });

  it('should GET the fleet board from its own route when the scope has no session', async () => {
    // Arrange
    const { client, transport } = fakeClient([board(null)]);
    const gateway = new FyTaskGateway(() => client);

    // Act
    const actual = await gateway.list({ sessionId: null }, []);

    // Assert
    should(actual.sessionId).be.null();
    should(transport.exchanges[0]?.url).equal('http://127.0.0.1:65535/v1/tasks');
  });

  it('should omit the history cursor when it is at the beginning', async () => {
    // Arrange
    const { client, transport } = fakeClient([
      { sessionId: 'session-7', task: scoped('F7'), activity: [] },
      { sessionId: 'session-7', task: scoped('F7'), activity: [] },
    ]);
    const gateway = new FyTaskGateway(() => client);

    // Act
    await gateway.show('session-7', 'F7', 0);
    await gateway.show('session-7', 'F7', 12);

    // Assert
    should(transport.exchanges[0]?.url).equal('http://127.0.0.1:65535/v1/sessions/session-7/tasks/F7');
    should(transport.exchanges[1]?.url).equal('http://127.0.0.1:65535/v1/sessions/session-7/tasks/F7?after=12');
  });

  it('should POST an action to the task route', async () => {
    // Arrange
    const { client, transport } = fakeClient([scoped('F7')]);
    const gateway = new FyTaskGateway(() => client);

    // Act
    const actual = await gateway.act('session-7', 'F7', { action: 'note', text: 'looked at it' });

    // Assert
    should(actual.id).equal('F7');
    should(transport.exchanges[0]?.method).equal('POST');
    should(transport.exchanges[0]?.url).equal('http://127.0.0.1:65535/v1/sessions/session-7/tasks/F7');
    should(transport.exchanges[0]?.body).eql({ action: 'note', text: 'looked at it' });
  });

  it('should refuse to send a payload the wire schema rejects', async () => {
    // Arrange
    const { client, transport } = fakeClient([scoped('F7')]);
    const gateway = new FyTaskGateway(() => client);

    // Act — an unknown action never reaches the daemon.
    const failure = gateway.act('session-7', 'F7', { action: 'explode' } as never);

    // Assert
    await should(failure).be.rejected();
    should(transport.exchanges).be.empty();
  });

  it('should reject a response that does not match the wire schema', async () => {
    // Arrange
    const { client } = fakeClient([{ id: 'F7' }]);
    const gateway = new FyTaskGateway(() => client);

    // Act + Assert
    await should(gateway.act('session-7', 'F7', { action: 'note', text: 'x' })).be.rejected();
  });

  it('should not connect until a command actually needs the daemon', async () => {
    // Arrange
    let connections = 0;
    const { client } = fakeClient([scoped('F7')]);
    const gateway = new FyTaskGateway(() => {
      connections += 1;
      return client;
    });

    // Assert — construction alone must not resolve FY_URL.
    should(connections).equal(0);

    // Act
    await gateway.act('session-7', 'F7', { action: 'note', text: 'x' });

    // Assert
    should(connections).equal(1);
  });
});
