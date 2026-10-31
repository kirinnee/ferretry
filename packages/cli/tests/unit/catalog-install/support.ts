import type {
  CatalogInstall,
  CatalogInstalled,
  CatalogInstallList,
  CatalogInstallPreview,
  CatalogInstallPreviewRequest,
  CatalogInstallRemoved,
  CatalogInstallRequest,
  CatalogInstallScope,
} from '@ferretry/protocol';
import type {
  ICatalogFileReader,
  ICatalogInstallGateway,
  ICatalogInstallOutput,
  ICatalogInstallPrompt,
} from '../../../src/lib/catalog-install/ports.ts';

const PUBLISHER = `fy_daemon_${'p'.repeat(43)}`;
const CATALOG_ID = `cat_${'c'.repeat(22)}`;
const SKILL_ID = `itm_${'s'.repeat(22)}`;
const MCP_ID = `itm_${'m'.repeat(22)}`;
export const INSTALL_ID = `cin_${'n'.repeat(22)}` as CatalogInstall['installId'];
export const PREVIEW_ID = `cip_${'v'.repeat(22)}` as CatalogInstallPreview['previewId'];
const DIGEST = `sha256:${'a'.repeat(64)}`;
const AT = '2026-10-31T09:00:00.000Z';

export const skillItem = (name = 'pdf-tools', itemId = SKILL_ID) => ({
  format: 'ferretry-catalog-item' as const,
  version: 1 as const,
  publisher: PUBLISHER,
  catalogId: CATALOG_ID,
  itemId,
  itemVersion: 1,
  name,
  summary: 'Split PDFs',
  kind: 'skill' as const,
  skill: { files: [{ path: 'SKILL.md', content: '# pdf\n' }] },
});

export const mcpItem = (name = 'acme-mcp', itemId = MCP_ID) => ({
  format: 'ferretry-catalog-item' as const,
  version: 1 as const,
  publisher: PUBLISHER,
  catalogId: CATALOG_ID,
  itemId,
  itemVersion: 1,
  name,
  summary: 'Talk to Acme',
  kind: 'mcp' as const,
  mcp: {
    transport: 'command' as const,
    command: 'acme-mcp',
    args: [],
    env: { ACME_TOKEN: '${secret:ACME_TOKEN}' },
  },
});

type Item = ReturnType<typeof skillItem> | ReturnType<typeof mcpItem>;

/** The text of a catalog file that passes `readSharedCatalogFile` (its signature is not checked there). */
export const catalogFileText = (items: readonly Item[]): string =>
  JSON.stringify({
    format: 'ferretry-catalog-file',
    version: 1,
    exportedAt: AT,
    signedManifest: {
      manifest: {
        format: 'ferretry-catalog-manifest',
        version: 1,
        publisher: PUBLISHER,
        publisherName: 'kirin-box',
        catalogId: CATALOG_ID,
        name: "Kirin's catalog",
        description: '',
        visibility: 'members',
        revision: 1,
        issuedAt: AT,
        items: items.map(item => ({
          itemId: item.itemId,
          kind: item.kind,
          name: item.name,
          summary: item.summary,
          version: item.itemVersion,
          digest: DIGEST,
          size: 100,
          publishedAt: AT,
        })),
        withdrawn: [],
      },
      spki: 'A'.repeat(59),
      sig: 'B'.repeat(86),
    },
    items,
  });

const provenance = (name = 'pdf-tools'): CatalogInstall['provenance'] => ({
  publisher: PUBLISHER as CatalogInstall['provenance']['publisher'],
  publisherName: 'kirin-box',
  catalogId: CATALOG_ID as CatalogInstall['provenance']['catalogId'],
  catalogName: "Kirin's catalog",
  itemId: SKILL_ID as CatalogInstall['provenance']['itemId'],
  kind: 'skill',
  name,
  version: 2,
  digest: DIGEST as CatalogInstall['provenance']['digest'],
});

export const previewOf = (overrides: Partial<CatalogInstallPreview> = {}): CatalogInstallPreview => ({
  previewId: PREVIEW_ID,
  expiresAt: AT,
  provenance: provenance(),
  publisher: {
    daemonId: PUBLISHER as CatalogInstallPreview['publisher']['daemonId'],
    name: 'kirin-box',
    firstSeen: false,
  },
  target: { scope: 'project', projectRoot: '/work/repo', harness: 'claude' },
  destination: '/work/repo/.claude/skills/pdf-tools/ (1 file)',
  review: [
    { label: 'Starts', text: 'acme-mcp', document: false },
    { label: 'Skill file SKILL.md', text: 'line one\nline two', document: true },
  ],
  secrets: [],
  warnings: [],
  ...overrides,
});

export const installOf = (
  scope: CatalogInstallScope = 'project',
  bindings: CatalogInstall['secretBindings'] = {},
): CatalogInstall => ({
  installId: INSTALL_ID,
  installedAt: AT,
  provenance: provenance(),
  target:
    scope === 'project'
      ? { scope: 'project', projectRoot: '/work/repo', harness: 'claude' }
      : { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
  destination:
    scope === 'project'
      ? '/work/repo/.claude/skills/pdf-tools/ (1 file)'
      : 'the skill pdf-tools in runtime claude-work',
  secretBindings: bindings,
});

export class FakeGateway implements ICatalogInstallGateway {
  readonly previews: { scope: CatalogInstallScope; request: CatalogInstallPreviewRequest }[] = [];
  readonly applies: { scope: CatalogInstallScope; request: CatalogInstallRequest }[] = [];
  readonly removes: { scope: CatalogInstallScope; installId: string }[] = [];
  preview: CatalogInstallPreview = previewOf();
  installs: CatalogInstall[] = [];
  notes: string[] = [];
  failure: Error | undefined;

  async previewCatalogInstall(scope: CatalogInstallScope, request: CatalogInstallPreviewRequest) {
    this.previews.push({ scope, request });
    if (this.failure !== undefined) throw this.failure;
    return this.preview;
  }

  async applyCatalogInstall(scope: CatalogInstallScope, request: CatalogInstallRequest): Promise<CatalogInstalled> {
    this.applies.push({ scope, request });
    if (this.failure !== undefined) throw this.failure;
    return { install: installOf(scope, request.secretBindings), notes: this.notes };
  }

  async catalogInstalls(): Promise<CatalogInstallList> {
    return { installs: this.installs };
  }

  async removeCatalogInstall(scope: CatalogInstallScope, installId: string): Promise<CatalogInstallRemoved> {
    this.removes.push({ scope, installId });
    if (this.failure !== undefined) throw this.failure;
    return { installId: INSTALL_ID, provenance: provenance(), destination: 'gone' };
  }
}

export class FakeOutput implements ICatalogInstallOutput {
  readonly reports: string[] = [];
  readonly successes: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly diagnostics: string[] = [];
  exitCode = 0;
  report(message: string): void {
    this.reports.push(message);
  }
  success(message: string): void {
    this.successes.push(message);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
  diagnostic(message: string): void {
    this.diagnostics.push(message);
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

export class FakePrompt implements ICatalogInstallPrompt {
  readonly asked: string[] = [];
  constructor(private readonly answers: string[] = []) {}
  async ask(message: string): Promise<string> {
    this.asked.push(message);
    return this.answers.shift() ?? '';
  }
}

export class FakeFiles implements ICatalogFileReader {
  constructor(
    private readonly text: string,
    private readonly sizeOverride?: number | Error,
    private readonly readFailure?: Error,
  ) {}
  async size(): Promise<number> {
    if (this.sizeOverride instanceof Error) throw this.sizeOverride;
    return this.sizeOverride ?? this.text.length;
  }
  async read(): Promise<string> {
    if (this.readFailure !== undefined) throw this.readFailure;
    return this.text;
  }
}
