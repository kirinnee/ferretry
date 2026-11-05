import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  STEP_UP_REQUIRED_CODE,
  VOICE_ENGINE_CODES,
  type VoiceEngineView,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { type VoiceEngineSubsystem, voiceEngineRoutes } from '../../../../src/lib/runtime/mounts/voice-engine.ts';
import { VoiceInstallError } from '../../../../src/lib/voice-install/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, fromFerret, grantSubsystem, human } from './support.ts';

const VIEW = {
  target: 'linux-x64',
  runtime: { source: 'downloaded', wrapperVersion: '2.0.1', install: { state: 'not-installed', partialBytes: 0 } },
  models: [],
  active: { batch: null, streaming: null },
  install: null,
  warnings: [],
} as const satisfies VoiceEngineView;

class FakeEngine implements VoiceEngineSubsystem {
  readonly calls: string[] = [];
  failure: unknown;
  async view() {
    return this.#answer('view');
  }
  async install(id: string) {
    return this.#answer(`install:${id}`);
  }
  async cancel() {
    return this.#answer('cancel');
  }
  async remove(id: string) {
    return this.#answer(`remove:${id}`);
  }
  async use(id: string) {
    return this.#answer(`use:${id}`);
  }
  #answer(call: string): VoiceEngineView {
    this.calls.push(call);
    if (this.failure !== undefined) throw this.failure;
    return VIEW;
  }
}

async function fixture(grants: CapabilityGrants = DEFAULT_CAPABILITY_GRANTS) {
  const engine = new FakeEngine();
  const guard = grantSubsystem({ grants });
  await guard.refresh();
  const dispatcher = new ApiDispatcher(new ApiRouter([...voiceEngineRoutes(engine)]), CREDENTIALS, guard);
  const send = async (
    method: string,
    path: string,
    options: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly loopback?: boolean;
      readonly ferret?: boolean;
    } = {},
  ): Promise<ApiResponse> => {
    const asked = request({
      method,
      path,
      headers: { 'content-type': 'application/json', ...(options.headers ?? human) },
      loopback: options.loopback ?? true,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    return await dispatcher.dispatch(options.ferret === true ? fromFerret(asked) : asked);
  };
  return { engine, send };
}

const ACTS = [
  ['POST', '/v1/voice/engine/install', '{"id":"parakeet-tdt-0.6b-v3-int8"}'],
  ['POST', '/v1/voice/engine/cancel', undefined],
  ['POST', '/v1/voice/engine/remove', '{"id":"whisper-turbo"}'],
  ['POST', '/v1/voice/engine/use', '{"id":"whisper-turbo"}'],
] as const;

describe('the owner at the machine', () => {
  it('should read the engine, install with 202, and reach every act', async () => {
    // Arrange
    const { engine, send } = await fixture();

    // Act
    const read = await send('GET', '/v1/voice/engine');
    const install = await send('POST', '/v1/voice/engine/install', { body: '{"id":"parakeet-tdt-0.6b-v3-int8"}' });
    const cancel = await send('POST', '/v1/voice/engine/cancel');
    const remove = await send('POST', '/v1/voice/engine/remove', { body: '{"id":"whisper-turbo"}' });
    const use = await send('POST', '/v1/voice/engine/use', { body: '{"id":"whisper-turbo"}' });

    // Assert
    should([read.status, install.status, cancel.status, remove.status, use.status]).deepEqual([
      200, 202, 200, 200, 200,
    ]);
    should(jsonBody(read)).deepEqual(VIEW);
    should(engine.calls).deepEqual([
      'view',
      'install:parakeet-tdt-0.6b-v3-int8',
      'cancel',
      'remove:whisper-turbo',
      'use:whisper-turbo',
    ]);
  });

  it('should refuse a body with no id, or an unknown key, before the engine is asked', async () => {
    // Arrange
    const { engine, send } = await fixture();

    // Act
    const none = await send('POST', '/v1/voice/engine/install', { body: '{}' });
    const extra = await send('POST', '/v1/voice/engine/use', { body: '{"id":"x","force":true}' });

    // Assert
    should([none.status, extra.status]).deepEqual([400, 400]);
    should(engine.calls).deepEqual([]);
  });

  it.each([
    [VOICE_ENGINE_CODES.unknownModel, 404],
    [VOICE_ENGINE_CODES.busy, 409],
    [VOICE_ENGINE_CODES.notInstalled, 409],
    [VOICE_ENGINE_CODES.noDisk, 507],
    [VOICE_ENGINE_CODES.unsupportedPlatform, 501],
  ] as const)('should answer the refusal %s as %i with its code and sentence', async (code, status) => {
    // Arrange
    const { engine, send } = await fixture();
    engine.failure = new VoiceInstallError(code, 'a sentence for a person');

    // Act
    const answer = await send('POST', '/v1/voice/engine/install', { body: '{"id":"x"}' });

    // Assert
    should(answer.status).equal(status);
    should(jsonBody(answer)).containEql({ code, error: 'a sentence for a person' });
  });

  it('should not hide a failure it does not know as a refusal', async () => {
    // Arrange
    const { engine, send } = await fixture();
    engine.failure = new Error('boom');

    // Act
    const answer = await send('GET', '/v1/voice/engine');

    // Assert
    should(answer.status).equal(500);
  });

  it('should send nothing to a shared cache', async () => {
    // Arrange
    const routes = voiceEngineRoutes(new FakeEngine());

    // Assert
    should(routes.every(route => route.noStore === true)).be.true();
  });
});

describe('a ferret', () => {
  it.each([['the admin token naming its session'], ['its own session credential']])(
    'should be refused 403 owner_only on every route by %s, with the engine never asked',
    async via => {
      // Arrange
      const { engine, send } = await fixture();
      const ferret = via.startsWith('the admin');
      const asks = [['GET', '/v1/voice/engine', undefined] as const, ...ACTS];

      // Act
      const answers: ApiResponse[] = [];
      for (const [method, path, body] of asks) {
        answers.push(
          await send(method, path, {
            ...(ferret ? { headers: agentIn('s1') } : { ferret: true }),
            // A body that would be refused as invalid proves the refusal came BEFORE the body was read.
            ...(body === undefined ? {} : { body: '{not json' }),
          }),
        );
      }

      // Assert
      should(answers.map(answer => [answer.status, jsonBody(answer).code])).deepEqual(
        asks.map(() => [403, 'owner_only']),
      );
      should(engine.calls).deepEqual([]);
    },
  );
});

describe('a governed device', () => {
  const grants = (voice: { use: boolean; configure: boolean }): CapabilityGrants => ({
    ...DEFAULT_CAPABILITY_GRANTS,
    voice,
  });

  it('should read with voice.use and be refused every act without voice.configure', async () => {
    // Arrange
    const { engine, send } = await fixture(grants({ use: true, configure: false }));

    // Act
    const read = await send('GET', '/v1/voice/engine', { loopback: false });
    const acts: ApiResponse[] = [];
    for (const [method, path, body] of ACTS) {
      acts.push(await send(method, path, { loopback: false, ...(body === undefined ? {} : { body }) }));
    }

    // Assert
    should(read.status).equal(200);
    should(acts.map(answer => answer.status)).deepEqual([403, 403, 403, 403]);
    for (const answer of acts) should(String(jsonBody(answer).error)).match(/fy daemon config set voice --configure/u);
    should(engine.calls).deepEqual(['view']);
  });

  it('should be refused even the read without voice.use', async () => {
    // Arrange
    const { engine, send } = await fixture(grants({ use: false, configure: false }));

    // Act
    const read = await send('GET', '/v1/voice/engine', { loopback: false });

    // Assert
    should(read.status).equal(403);
    should(engine.calls).deepEqual([]);
  });

  it('should need a passkey step-up for every act even when voice.configure is on', async () => {
    // Arrange
    const { engine, send } = await fixture(grants({ use: true, configure: true }));

    // Act
    const acts: ApiResponse[] = [];
    for (const [method, path, body] of ACTS) {
      acts.push(await send(method, path, { loopback: false, ...(body === undefined ? {} : { body }) }));
    }

    // Assert
    should(acts.map(answer => answer.status)).deepEqual([403, 403, 403, 403]);
    should(acts.map(answer => jsonBody(answer).code)).containDeep([STEP_UP_REQUIRED_CODE]);
    should(engine.calls).deepEqual([]);
  });

  it('should serve the owner at the machine whatever the grants say: that caller is not governed', async () => {
    // Arrange
    const { engine, send } = await fixture(grants({ use: false, configure: false }));

    // Act
    const read = await send('GET', '/v1/voice/engine', { loopback: true });

    // Assert
    should(read.status).equal(200);
    should(engine.calls).deepEqual(['view']);
  });
});
