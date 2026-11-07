/**
 * Asks' half of confirming a held configuration change (docs/agenda.md § Confirming a configuration change), over the
 * config seam: raising a card that names a held edit, and acting on the owner's answer to it. The config files, the
 * security log and the grant rule (`heldEditRefusal`) are the config port's, so here they are a fake whose refusal a
 * case chooses; their own tests go with that port.
 */
import { describe, it } from 'bun:test';
import { type ApiResponse, errorResponse } from '@ferretry/kernel/contract';
import should from 'should';
import type { AgendaConfigPort, ConfigPending, HeldEditAct } from '../../../../daemon/lib/routes/agenda-confirms.ts';
import { agendaRoutes } from '../../../../daemon/lib/routes/agenda.ts';
import { agendaService, agentIn, device, human, jsonBody, NO_HELD_REPLIES, routeDispatcher, warden } from './support.ts';

const PATH = 'warden.yaml';
const CHANGES = ['the Warden may now spend on AI investigations'];

const RAISE = {
  action: 'add',
  title: 'Turn on AI investigations',
  subject: 'Allow the Warden to spend on AI investigations?',
  why: 'investigations need the LLM layer on',
  context: 'The work waits on this answer.',
  howToResolve: 'Allow, Deny or Discard change',
  confirms: PATH,
} as const;

const choose = (choice: string) => ({ action: 'resolve', id: 'A1', response: { kind: 'multiple-choice', choice } });

/** The held edits as the config port keeps them, and every act asked of it. */
class FakeConfig {
  held: ConfigPending | undefined = { path: PATH, etag: 'etag-1', changes: CHANGES };
  readonly acts: string[] = [];
  refused: ApiResponse | undefined;
  spent = 0;

  async confirm(path: string, etag: string): Promise<boolean> {
    this.acts.push(`confirm ${path} ${etag}`);
    return this.held?.etag === etag;
  }
  async discard(path: string, etag: string): Promise<boolean> {
    this.acts.push(`discard ${path} ${etag}`);
    return this.held?.etag === etag;
  }
  async record(_context: unknown, act: HeldEditAct, path: string, outcome: 'succeeded' | 'refused'): Promise<void> {
    this.acts.push(`record ${act} ${path} ${outcome}`);
  }
  refusal(): ApiResponse | undefined {
    return this.refused;
  }
  spendProof(): void {
    this.spent += 1;
  }
}

function world(config: FakeConfig | null = new FakeConfig()) {
  const port: AgendaConfigPort | undefined =
    config === null
      ? undefined
      : {
          held: async () => config.held,
          confirm: (path, etag) => config.confirm(path, etag),
          discard: (path, etag) => config.discard(path, etag),
          record: (context, act, path, outcome) => config.record(context, act, path, outcome),
          refusal: () => config.refusal(),
          spendProof: () => config.spendProof(),
        };
  const dispatch = routeDispatcher(agendaRoutes(agendaService(), NO_HELD_REPLIES, undefined, port));
  const post = async (body: unknown, headers = human) =>
    await dispatch({ method: 'POST', path: '/v1/ferrets/s1/agenda', headers, body: JSON.stringify(body) });
  const item = async () => {
    const board = jsonBody(await dispatch({ path: '/v1/ferrets/s1/agenda', headers: human })) as {
      items: { id: string; confirms?: unknown; premise?: string; ask?: unknown }[];
      resolved: { id: string }[];
    };
    return { open: board.items.find(each => each.id === 'A1'), closed: board.resolved.find(each => each.id === 'A1') };
  };
  // A case that wires no port never reads it.
  return { config: config as FakeConfig, post, item };
}

describe('raising a card that confirms a held change (fy agenda add --confirms)', () => {
  it("should record the held edit's digest and words, and the daemon's premise", async () => {
    // Arrange
    const { post, item } = world();

    // Act
    const raised = await post(RAISE, agentIn('s1'));

    // Assert
    should(raised.status).equal(200);
    const { open } = await item();
    should(open?.confirms).deepEqual({ path: PATH, etag: 'etag-1', changes: CHANGES });
    should(open?.premise).equal(`- ${CHANGES[0]}\n- Allow applies this change to ${PATH}.`);
  });

  it('should refuse a file with no held change, and raise nothing', async () => {
    // Arrange
    const config = new FakeConfig();
    config.held = undefined;
    const { post, item } = world(config);

    // Act
    const raised = await post(RAISE, agentIn('s1'));

    // Assert
    should(raised.status).equal(400);
    should((await item()).open).be.undefined();
  });

  it('should refuse --confirms where no config port is wired', async () => {
    // Arrange
    const { post } = world(null);

    // Act
    const raised = await post(RAISE, agentIn('s1'));

    // Assert
    should([raised.status, jsonBody(raised).error]).deepEqual([
      400,
      'this daemon cannot confirm configuration changes from the agenda',
    ]);
  });
});

describe("the owner's answer to a confirmation", () => {
  it('should confirm the held change on Allow from the host, record it, and close the card', async () => {
    // Arrange
    const { config, post, item } = world();
    await post(RAISE, agentIn('s1'));

    // Act
    const answered = await post(choose('Allow'));

    // Assert
    should(answered.status).equal(200);
    should(config.acts).deepEqual([`confirm ${PATH} etag-1`, `record config-confirm ${PATH} succeeded`]);
    should(config.spent).equal(1);
    should((await item()).open).be.undefined();
  });

  it("should answer with the config port's refusal, record it, and change nothing", async () => {
    // Arrange
    const config = new FakeConfig();
    const { post, item } = world(config);
    await post(RAISE, agentIn('s1'));
    config.refused = errorResponse(403, 'confirm with your passkey', 'step_up_required');

    // Act
    const answered = await post(choose('Allow'), device('phone'));

    // Assert
    should([answered.status, jsonBody(answered).code]).deepEqual([403, 'step_up_required']);
    should(config.acts).deepEqual([`record config-confirm ${PATH} refused`]);
    should((await item()).open?.confirms).not.be.undefined();
  });

  it('should leave the change held on Deny, recording nothing', async () => {
    // Arrange
    const { config, post } = world();
    await post(RAISE, agentIn('s1'));

    // Act
    const answered = await post(choose('Deny'), device('phone'));

    // Assert
    should(answered.status).equal(200);
    should(config.acts).deepEqual([]);
  });

  it('should discard the held change on Discard change, spending no passkey proof', async () => {
    // Arrange
    const { config, post } = world();
    await post(RAISE, agentIn('s1'));

    // Act
    const answered = await post(choose('Discard change'));

    // Assert
    should(answered.status).equal(200);
    should(config.acts).deepEqual([`discard ${PATH} etag-1`, `record config-discard ${PATH} succeeded`]);
    should(config.spent).equal(0);
  });

  it('should confirm nothing when the held change moved on, restate the card, and confirm the restated one next', async () => {
    // Arrange
    const config = new FakeConfig();
    const { post, item } = world(config);
    await post(RAISE, agentIn('s1'));
    config.held = { path: PATH, etag: 'etag-2', changes: ['the Warden may now restart ferrets'] };

    // Act
    const first = await post(choose('Allow'));
    const restated = (await item()).open?.confirms;
    const second = await post(choose('Allow'));

    // Assert
    should([first.status, jsonBody(first).code]).deepEqual([409, 'config_changed']);
    should(restated).containDeep({ path: PATH, etag: 'etag-2', changes: ['the Warden may now restart ferrets'] });
    should(second.status).equal(200);
  });

  it('should close the card and say so when no change waits any more', async () => {
    // Arrange
    const config = new FakeConfig();
    const { post, item } = world(config);
    await post(RAISE, agentIn('s1'));
    config.held = undefined;

    // Act
    const answered = await post(choose('Allow'));

    // Assert
    should([answered.status, jsonBody(answered).code]).deepEqual([409, 'config_changed']);
    should((await item()).closed).not.be.undefined();
  });
});

describe('a ferret or a warden can never confirm', () => {
  it("should refuse a ferret's Allow and Deny on its own card, touching neither the file nor the card", async () => {
    // Arrange
    const { config, post, item } = world();
    await post(RAISE, agentIn('s1'));

    // Act
    const allow = await post(choose('Allow'), agentIn('s1'));
    const deny = await post(choose('Deny'), agentIn('s1'));

    // Assert
    should([allow.status, deny.status]).deepEqual([403, 403]);
    should(config.acts).deepEqual([]);
    should((await item()).open?.confirms).not.be.undefined();
  });

  it("should refuse a warden's Allow", async () => {
    // Arrange
    const { config, post } = world();
    await post(RAISE, agentIn('s1'));

    // Act
    const allow = await post(choose('Allow'), warden);

    // Assert
    should(allow.status).equal(403);
    should(config.acts).deepEqual([]);
  });

  it('should still let the ferret close its own card without answering it', async () => {
    // Arrange
    const { config, post } = world();
    await post(RAISE, agentIn('s1'));

    // Act
    const dismissed = await post({ action: 'dismiss', id: 'A1' }, agentIn('s1'));

    // Assert
    should(dismissed.status).equal(200);
    should(config.acts).deepEqual([]);
  });
});
