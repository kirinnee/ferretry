import { createHash } from 'node:crypto';
import type { AcceptedConfigFiles, ConfigFileText } from '@ferretry/fleet';
import type {
  ConfigConfirmResult,
  ConfigFilePutResult,
  ConfigFileView,
  ConfigIssue,
  ConfigPending,
  ConfigStatusView,
} from '@ferretry/protocol';
import type { IConfigFiles, IConfigGateway, IConfigInput, IConfigOutput } from '../../../src/lib/config/ports';

export const DIRECTORY = '/home/me/.ferretry/config';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export class FakeConfigFiles implements IConfigFiles {
  readonly directory = DIRECTORY;
  constructor(
    private readonly found: readonly ConfigFileText[] = [],
    private readonly notRead: readonly string[] = [],
    private readonly record: AcceptedConfigFiles = {},
  ) {}

  list() {
    return Promise.resolve({ files: this.found, unreadable: this.notRead });
  }

  accepted() {
    return Promise.resolve(this.record);
  }
}

export class FakeConfigGateway implements IConfigGateway {
  readonly confirms: { path: string; etag: string }[] = [];
  readonly reads: string[] = [];
  readonly writes: { path: string; text: string; ifMatch: string | undefined }[] = [];
  /** What `file()` answers. */
  fileView: ConfigFileView = fileView();
  /** What `write()` answers, unless `writeFailure` is set. */
  putResult: ConfigFilePutResult = { path: 'machine.yaml', etag: 'etag-new', outcome: 'applied' };
  writeFailure: unknown;
  constructor(
    private readonly view: ConfigStatusView,
    private readonly confirmed = true,
  ) {}

  status() {
    return Promise.resolve(this.view);
  }

  file(path: string) {
    this.reads.push(path);
    return Promise.resolve(this.fileView);
  }

  write(path: string, text: string, ifMatch: string | undefined): Promise<ConfigFilePutResult> {
    this.writes.push({ path, text, ifMatch });
    return this.writeFailure === undefined ? Promise.resolve(this.putResult) : Promise.reject(this.writeFailure);
  }

  confirm(path: string, etag: string): Promise<ConfigConfirmResult> {
    this.confirms.push({ path, etag });
    return Promise.resolve({ path, confirmed: this.confirmed });
  }
}

/** Standard input, already read. */
export class FakeConfigInput implements IConfigInput {
  reads = 0;
  constructor(private readonly text = '') {}

  read() {
    this.reads += 1;
    return Promise.resolve(this.text);
  }
}

export class FakeConfigOutput implements IConfigOutput {
  readonly lines: string[] = [];
  exitCode: number | undefined;

  success(message: string): void {
    this.lines.push(message);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export const issue = (overrides: Partial<ConfigIssue> = {}): ConfigIssue => ({
  path: 'machine.yaml',
  line: 3,
  column: 7,
  severity: 'error',
  message: 'not a thing',
  fix: 'make it a thing',
  ...overrides,
});

export const pending = (overrides: Partial<ConfigPending> = {}): ConfigPending => ({
  path: 'warden.yaml',
  etag: 'etag-1',
  changes: ['the Warden may now spend on AI investigations'],
  ...overrides,
});

export const statusView = (overrides: Partial<ConfigStatusView> = {}): ConfigStatusView => ({
  directory: DIRECTORY,
  files: [{ path: 'machine.yaml', kind: 'machine', schema: 'machine', state: 'ok' }],
  issues: [],
  pending: [],
  checkedAt: '2026-10-16T00:00:00.000Z',
  ...overrides,
});

export const fileView = (overrides: Partial<ConfigFileView> = {}): ConfigFileView => ({
  path: 'machine.yaml',
  absolutePath: `${DIRECTORY}/machine.yaml`,
  kind: 'machine',
  schema: 'machine',
  exists: true,
  text: 'agentPermissions: auto\n',
  etag: 'etag-1',
  state: 'ok',
  issues: [],
  ...overrides,
});
