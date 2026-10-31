/**
 * `fy catalog install | installs | uninstall` through the real composition root.
 *
 * Like every journey in this tier it drives the shipped wiring against a small daemon double, so what it
 * proves is what the CLI READS, SENDS and SAYS: the file is read here and sent for a preview, the review is
 * printed before anything is asked, and nothing is applied without a yes. That the REAL daemon verifies the
 * signature, pins the publisher and writes only what it recorded is
 * `packages/daemon/tests/unit/catalog-installs/` and its integration tests — a double cannot prove it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { catalogFileText, installOf, mcpItem, previewOf, skillItem } from '../unit/catalog-install/support.ts';
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

const ADMIN_TOKEN = 'sit-admin-token';

/** The preview, apply, list and remove routes, answering as the daemon does, and recording what they got. */
class FakeInstallDaemon {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
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
    const path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? await request.json() : undefined;
    this.requests.push({ method: request.method, path, body });
    if (request.method === 'POST' && path.endsWith('/preview')) return Response.json(previewOf());
    if (request.method === 'POST') return Response.json({ install: installOf('project'), notes: [] });
    if (request.method === 'GET') return Response.json({ installs: [installOf('project')] });
    return Response.json({
      installId: installOf('project').installId,
      provenance: installOf('project').provenance,
      destination: installOf('project').destination,
    });
  }
}

let driver: CliDriver;
let daemon: FakeInstallDaemon;
let folder: string;
let file: string;

const cli = (args: string[]): Promise<CliResult> =>
  driver.run(args, { FY_URL: daemon.baseUrl, FY_TOKEN: ADMIN_TOKEN, FY_SESSION_ID: '' });

beforeAll(async () => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
  daemon = new FakeInstallDaemon();
  folder = await mkdtemp(join(tmpdir(), 'fy-catalog-sit-'));
  file = join(folder, 'kirin.fycatalog.json');
  await writeFile(file, catalogFileText([skillItem(), mcpItem()]));
});

afterAll(async () => {
  daemon.stop();
  await rm(folder, { recursive: true, force: true });
});

describe(`catalog install (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should be mounted and explain itself in --help', async () => {
    const actual = await driver.run(['catalog', 'install', '--help'], { FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' });
    should(actual.code).equal(0);
    should(actual.out).containEql('--project').and.containEql('--bind').and.containEql('--yes');
  });

  it('should ask for exactly one target and send nothing without it', async () => {
    const before = daemon.requests.length;
    const actual = await cli(['catalog', 'install', file, '--item', 'pdf-tools', '--yes']);
    should(actual.code).equal(1);
    should(actual.err.length).be.above(0);
    should(daemon.requests).have.length(before);
  });

  it('should refuse off a terminal without --yes, after showing the review, and apply nothing', async () => {
    const before = daemon.requests.length;
    const actual = await cli([
      'catalog',
      'install',
      file,
      '--item',
      'pdf-tools',
      '--project',
      folder,
      '--harness',
      'claude',
    ]);
    should(actual.code).equal(1);
    should(actual.err).containEql('--yes');
    const sent = daemon.requests.slice(before);
    should(sent.map(request => request.path)).eql(['/v1/catalog-installs/project/preview']);
  });

  it('should preview, then apply exactly that preview with the bindings given, carrying the host credential', async () => {
    const before = daemon.requests.length;
    const actual = await cli([
      'catalog',
      'install',
      file,
      '--item',
      'pdf-tools',
      '--project',
      folder,
      '--harness',
      'claude',
      '--yes',
    ]);
    should(actual.code).equal(0, actual.err);
    should(actual.out).containEql('pdf-tools');
    const sent = daemon.requests.slice(before);
    should(sent.map(request => `${request.method} ${request.path}`)).eql([
      'POST /v1/catalog-installs/project/preview',
      'POST /v1/catalog-installs/project',
    ]);
    should(sent[1]?.body).eql({ previewId: previewOf().previewId, secretBindings: {} });
  });

  it('should list what is installed', async () => {
    const actual = await cli(['catalog', 'installs']);
    should(actual.code).equal(0, actual.err);
    should(actual.out).containEql('pdf-tools').and.containEql(installOf('project').installId);
  });

  it('should remove an install by id, in the scope it was installed in', async () => {
    const before = daemon.requests.length;
    const actual = await cli(['catalog', 'uninstall', installOf('project').installId, '--yes']);
    should(actual.code).equal(0, actual.err);
    const sent = daemon.requests.slice(before).map(request => `${request.method} ${request.path}`);
    should(sent).eql([
      'GET /v1/catalog-installs',
      `DELETE /v1/catalog-installs/project/${installOf('project').installId}`,
    ]);
  });

  it('should say a file that is not a catalog file is not, and send nothing', async () => {
    const junk = join(folder, 'junk.json');
    await writeFile(junk, '{"nope":true}');
    const before = daemon.requests.length;
    const actual = await cli(['catalog', 'install', junk, '--project', folder, '--harness', 'claude', '--yes']);
    should(actual.code).equal(1);
    should(daemon.requests).have.length(before);
  });
});
