/**
 * The account-model commands (docs/design/account-model.md §6.2) through the real composition root.
 *
 * `bin/**` is excluded from both coverage ledgers, so the unit tests prove each command against a
 * recording fake gateway and NOT that the composition root hands them a gateway that speaks the real
 * routes. This drives the shipped wiring against a small daemon double that answers exactly the
 * routes the commands dial, parsing every request through the shared schema the real daemon uses.
 *
 * It also pins the exit codes a script trusts: a refused unconfirmed removal, and a failed check
 * are both non-zero, and neither changes anything.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import {
  type FleetAccountChange,
  FleetAccountChangeRequestSchema,
  FleetProposalApplyRequestSchema,
} from '@ferretry/protocol';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { CHANGE_ID, changeView, committed, credential, machine, runtime } from '../unit/fleet/account-fakes';
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

/** The account-model routes, answered from fixtures; every staged change and apply is recorded. */
class FakeAccountDaemon {
  readonly staged: FleetAccountChange[] = [];
  readonly applied: string[] = [];
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.#server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => this.#handle(request) });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  stop(): void {
    this.#server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    switch (route) {
      case 'GET /v1/fleet/runtimes':
        return Response.json({ format: 'version-2', runtimes: [runtime()] });
      case 'GET /v1/fleet/machine':
        return Response.json(machine());
      case 'POST /v1/fleet/proposals': {
        const { change } = FleetAccountChangeRequestSchema.parse(await request.json());
        this.staged.push(change);
        return Response.json(changeView(change));
      }
      case `POST /v1/fleet/proposals/${CHANGE_ID}/apply`:
        FleetProposalApplyRequestSchema.parse(await request.json());
        this.applied.push(CHANGE_ID);
        return Response.json(committed());
      case 'POST /v1/fleet/credentials/codex-work/check':
        return Response.json(
          credential({
            id: 'codex-work',
            harness: 'codex',
            store: 'ferretry',
            sharedWithTerminal: false,
            status: {
              word: 'needs_sign_in',
              label: 'Needs sign-in',
              reason: 'refresh_rejected',
              explanation: 'The provider refused the refresh.',
              lastCheckInconclusive: false,
            },
          }),
        );
      default:
        return Response.json({ error: `unknown route ${route}` }, { status: 404 });
    }
  }
}

let driver: CliDriver;
let daemon: FakeAccountDaemon;

const cli = (args: string[]): Promise<CliResult> =>
  driver.run(args, { FY_URL: daemon.baseUrl, FY_TOKEN: 'sit-test-token', FY_SESSION_ID: '' });

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  daemon = new FakeAccountDaemon();
});

afterAll(() => {
  daemon.stop();
});

describe(`account model commands (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should list runtimes and add one through a previewed change, without asking', async () => {
    // Act
    const listed = await cli(['runtimes']);
    const added = await cli([
      'runtime',
      'add',
      'claude-work',
      '--credential',
      'claude-you',
      '--profile',
      'default',
      '--agent',
    ]);

    // Assert
    should(listed.code).equal(0, listed.err);
    should(listed.out).containEql('claude-default');
    should(added.code).equal(0, added.err);
    should(added.out).containEql('Add runtime claude-work').and.containEql('Done.');
    should(daemon.staged.at(-1)).eql({
      kind: 'runtime.put',
      name: 'claude-work',
      credential: 'claude-you',
      profile: 'default',
      agent: true,
      create: true,
    });
    should(daemon.applied).have.length(1);
  });

  it('should refuse an unconfirmed removal off a terminal, and apply it under --yes', async () => {
    // Act
    const refused = await cli(['runtime', 'rm', 'claude-work']);
    const appliedBefore = daemon.applied.length;
    const confirmed = await cli(['runtime', 'rm', 'claude-work', '--yes']);

    // Assert
    should(refused.code).equal(1);
    should(refused.err).containEql('--yes');
    should(appliedBefore).equal(1);
    should(confirmed.code).equal(0, confirmed.err);
    should(daemon.applied).have.length(2);
  });

  it('should exit non-zero when a check finds the login needs sign-in, naming the command', async () => {
    const checked = await cli(['credential', 'check', 'codex-work']);
    should(checked.code).equal(1);
    should(checked.err).containEql(`${binaryName} credential signin codex-work`);
  });
});
