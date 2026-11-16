import { describe, it } from 'bun:test';
import should from 'should';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ClientLessonsGateway } from '../../../cli/lib/gateway.ts';
import { GLOBAL_LESSONS_DOCUMENT } from '../../../contract/index.ts';

type Call = { readonly route: string; readonly init: unknown };

/** A client that records each call and answers the one value it was given. */
function gateway(answer: unknown): { subject: ClientLessonsGateway; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      return answer;
    },
  } as unknown as Pick<PluginClient, 'call'>;
  return { subject: new ClientLessonsGateway(client), calls };
}

const document = { name: GLOBAL_LESSONS_DOCUMENT, text: '- Use bun.\n', etag: 'etag-1', notes: [] };

describe('the Global document over the generated client', () => {
  it('should read the document with a GET and parse it against the wire schema', async () => {
    // Arrange
    const { subject, calls } = gateway(document);

    // Act
    const read = await subject.globalDocument();

    // Assert
    should(read).eql(document);
    should(calls).eql([{ route: 'GET /v1/lessons/global', init: undefined }]);
  });

  it('should refuse an answer that is not the document rather than hand a renderer undefined fields', async () => {
    // Arrange
    const { subject } = gateway({ error: 'nope' });

    // Act + Assert
    await should(subject.globalDocument()).be.rejected();
  });

  it('should write the document with a PUT that names the text and the etag it was read at', async () => {
    // Arrange
    const { subject, calls } = gateway({ ...document, text: '- Use bun, not Python.\n', etag: 'etag-2' });

    // Act
    const written = await subject.writeGlobalDocument('- Use bun, not Python.\n', 'etag-1');

    // Assert
    should(written.etag).equal('etag-2');
    should(calls).eql([
      {
        route: 'PUT /v1/lessons/global',
        init: { body: { text: '- Use bun, not Python.\n', etag: 'etag-1' } },
      },
    ]);
  });

  it('should refuse to send a write without the etag, so a blind overwrite never leaves the CLI', async () => {
    // Arrange
    const { subject, calls } = gateway(document);

    // Act + Assert
    await should(subject.writeGlobalDocument('- x\n', '')).be.rejected();
    should(calls).be.empty();
  });
});
