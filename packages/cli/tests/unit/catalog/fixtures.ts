import {
  type AddCatalogItemRequest,
  type CatalogItemPreview,
  type CatalogItemPreviewRequest,
  type CreateCatalogRequest,
  type DeletedCatalog,
  type ExportCatalogRequest,
  type OwnedCatalog,
  type OwnedCatalogItem,
  type OwnedCatalogList,
  type OwnedSharedItem,
  type OwnedSharedItemList,
  type PublishCatalogVersionRequest,
  type PublishedCatalogItem,
  type SharedCatalogFile,
  SharedCatalogFileSchema,
  type UpdateCatalogRequest,
  type WithdrawnCatalogItem,
} from '@ferretry/protocol';
import type {
  ICatalogFileWriter,
  ICatalogGateway,
  ICatalogOutput,
  ICatalogPrompt,
} from '../../../src/lib/catalog/ports';

const PUBLISHER = `fy_daemon_${'P'.repeat(43)}`;
export const CATALOG_ID = `cat_${'c'.repeat(22)}`;
export const OTHER_CATALOG_ID = `cat_${'d'.repeat(22)}`;
export const SKILL_ID = `itm_${'s'.repeat(22)}`;
export const MCP_ID = `itm_${'m'.repeat(22)}`;
export const DIGEST = `sha256:${'0'.repeat(64)}`;
export const NEW_DIGEST = `sha256:${'1'.repeat(64)}`;
export const AT = '2026-10-31T09:00:00.000Z';
export const CWD = '/work/here';

export function skillItem(overrides: Partial<OwnedCatalogItem> = {}): OwnedCatalogItem {
  return {
    itemId: SKILL_ID,
    kind: 'skill',
    name: 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    source: { kind: 'skill', path: '/home/u/.claude/skills/pdf-tools/SKILL.md' },
    sourceState: 'unchanged',
    versions: [{ version: 1, digest: DIGEST, size: 120, publishedAt: AT }],
    ...overrides,
  };
}

export function mcpItem(overrides: Partial<OwnedCatalogItem> = {}): OwnedCatalogItem {
  return {
    itemId: MCP_ID,
    kind: 'mcp',
    name: 'github',
    summary: 'GitHub issues',
    source: { kind: 'mcp', id: 'mcp_1', name: 'github' },
    sourceState: 'unchanged',
    versions: [{ version: 1, digest: DIGEST, size: 80, publishedAt: AT }],
    ...overrides,
  };
}

export function catalog(overrides: Partial<OwnedCatalog> = {}): OwnedCatalog {
  return {
    id: CATALOG_ID,
    name: 'Team tools',
    description: '',
    publisherName: 'laptop',
    visibility: 'members',
    revision: 3,
    issuedAt: AT,
    createdAt: AT,
    items: [skillItem(), mcpItem()],
    ...overrides,
  };
}

export function sharedItem(overrides: Partial<OwnedSharedItem> = {}): OwnedSharedItem {
  return {
    itemId: SKILL_ID,
    kind: 'skill',
    name: 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    source: { kind: 'skill', path: '/home/u/.claude/skills/pdf-tools/SKILL.md' },
    current: 1,
    createdAt: AT,
    catalogs: [{ catalogId: CATALOG_ID, state: 'live' }],
    versions: [
      {
        version: 1,
        size: 120,
        publishedAt: AT,
        summary: 'Split, merge and OCR PDFs',
        usedBy: { catalogIds: [CATALOG_ID] },
      },
    ],
    ...overrides,
  };
}

export function catalogList(catalogs: readonly OwnedCatalog[] = [catalog()]): OwnedCatalogList {
  return { publisher: PUBLISHER, catalogs };
}

export function preview(overrides: Partial<CatalogItemPreview> = {}): CatalogItemPreview {
  return {
    catalogId: CATALOG_ID,
    kind: 'skill',
    name: 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    location: '/home/u/.claude/skills/pdf-tools/SKILL.md',
    version: 1,
    digest: NEW_DIGEST,
    size: 120,
    review: [
      { label: 'Skill file SKILL.md', text: '# pdf\nline two\n\nline four', document: true },
      { label: 'Starts', text: 'npx -y thing', document: false },
    ],
    warnings: [],
    problems: [],
    ...overrides,
  };
}

export function published(overrides: Partial<PublishedCatalogItem> = {}): PublishedCatalogItem {
  return {
    catalogId: CATALOG_ID,
    itemId: SKILL_ID,
    itemVersion: 1,
    digest: NEW_DIGEST,
    revision: 4,
    item: skillItem(),
    ...overrides,
  };
}

export function withdrawn(): WithdrawnCatalogItem {
  return { catalogId: CATALOG_ID, itemId: SKILL_ID, revision: 5, withdrawnAt: AT };
}

export function catalogFile(): SharedCatalogFile {
  return SharedCatalogFileSchema.parse({
    format: 'ferretry-catalog-file',
    version: 1,
    exportedAt: AT,
    signedManifest: {
      manifest: {
        format: 'ferretry-catalog-manifest',
        version: 1,
        publisher: PUBLISHER,
        publisherName: 'laptop',
        catalogId: CATALOG_ID,
        name: 'Team tools',
        description: '',
        visibility: 'members',
        revision: 3,
        issuedAt: AT,
        items: [
          {
            itemId: SKILL_ID,
            kind: 'skill',
            name: 'pdf-tools',
            summary: 'Split, merge and OCR PDFs',
            version: 1,
            digest: DIGEST,
            size: 120,
            publishedAt: AT,
          },
        ],
        withdrawn: [],
      },
      spki: 'A'.repeat(59),
      sig: 'B'.repeat(86),
    },
    items: [
      {
        format: 'ferretry-catalog-item',
        version: 1,
        publisher: PUBLISHER,
        catalogId: CATALOG_ID,
        itemId: SKILL_ID,
        itemVersion: 1,
        name: 'pdf-tools',
        summary: 'Split, merge and OCR PDFs',
        kind: 'skill',
        skill: { files: [{ path: 'SKILL.md', content: '# pdf\n' }] },
      },
    ],
  });
}

export class CapturingOutput implements ICatalogOutput {
  readonly lines: string[] = [];
  readonly warnings: string[] = [];
  readonly diagnostics: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  diagnostic(message: string): void {
    this.diagnostics.push(message);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export class ScriptedPrompt implements ICatalogPrompt {
  readonly asked: string[] = [];
  constructor(private readonly answers: readonly string[]) {}
  ask(message: string): Promise<string> {
    this.asked.push(message);
    return Promise.resolve(this.answers[this.asked.length - 1] ?? '');
  }
}

export class MemoryFiles implements ICatalogFileWriter {
  readonly written = new Map<string, { text: string; overwrite: boolean }>();
  constructor(private readonly present: readonly string[] = []) {}
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.present.includes(path));
  }
  write(path: string, text: string, overwrite: boolean): Promise<void> {
    this.written.set(path, { text, overwrite });
    return Promise.resolve();
  }
}

export type GatewayCall =
  | { call: 'list'; sourceState: boolean }
  | { call: 'listItems' }
  | { call: 'create'; request: CreateCatalogRequest }
  | { call: 'update'; catalogId: string; request: UpdateCatalogRequest }
  | { call: 'remove'; catalogId: string }
  | { call: 'preview'; catalogId: string; request: CatalogItemPreviewRequest }
  | { call: 'add'; catalogId: string; request: AddCatalogItemRequest }
  | { call: 'publishVersion'; catalogId: string; itemId: string; request: PublishCatalogVersionRequest }
  | { call: 'withdraw'; catalogId: string; itemId: string }
  | { call: 'export'; catalogId: string; request: ExportCatalogRequest };

/** A gateway that records every call and answers from fixtures. */
export class FakeGateway implements ICatalogGateway {
  readonly calls: GatewayCall[] = [];
  /** What the "daemon" signs: the first catalog's live items, unless a test says it signed something else. */
  signedDigest: string | undefined;

  constructor(
    private readonly state: {
      catalogs: readonly OwnedCatalog[];
      preview: CatalogItemPreview;
      shared?: readonly OwnedSharedItem[];
    } = {
      catalogs: [catalog()],
      preview: preview(),
    },
  ) {}

  list(options: { readonly sourceState: boolean } = { sourceState: false }): Promise<OwnedCatalogList> {
    this.calls.push({ call: 'list', sourceState: options.sourceState });
    return Promise.resolve(catalogList(this.state.catalogs));
  }
  listItems(): Promise<OwnedSharedItemList> {
    this.calls.push({ call: 'listItems' });
    return Promise.resolve({ publisher: PUBLISHER, items: this.state.shared ?? [sharedItem()] });
  }
  create(request: CreateCatalogRequest): Promise<OwnedCatalog> {
    this.calls.push({ call: 'create', request });
    return Promise.resolve(catalog({ name: request.name, items: [], revision: 1 }));
  }
  update(catalogId: string, request: UpdateCatalogRequest): Promise<OwnedCatalog> {
    this.calls.push({ call: 'update', catalogId, request });
    return Promise.resolve(catalog({ revision: 4 }));
  }
  remove(catalogId: string): Promise<DeletedCatalog> {
    this.calls.push({ call: 'remove', catalogId });
    return Promise.resolve({ catalogId });
  }
  preview(catalogId: string, request: CatalogItemPreviewRequest): Promise<CatalogItemPreview> {
    this.calls.push({ call: 'preview', catalogId, request });
    return Promise.resolve(this.state.preview);
  }
  add(catalogId: string, request: AddCatalogItemRequest): Promise<PublishedCatalogItem> {
    this.calls.push({ call: 'add', catalogId, request });
    return Promise.resolve(published());
  }
  publishVersion(
    catalogId: string,
    itemId: string,
    request: PublishCatalogVersionRequest,
  ): Promise<PublishedCatalogItem> {
    this.calls.push({ call: 'publishVersion', catalogId, itemId, request });
    return Promise.resolve(published({ itemVersion: 2 }));
  }
  withdraw(catalogId: string, itemId: string): Promise<WithdrawnCatalogItem> {
    this.calls.push({ call: 'withdraw', catalogId, itemId });
    return Promise.resolve(withdrawn());
  }
  export(catalogId: string, request: ExportCatalogRequest): Promise<SharedCatalogFile> {
    this.calls.push({ call: 'export', catalogId, request });
    const file = catalogFile();
    const live = (this.state.catalogs[0]?.items ?? []).filter(item => item.withdrawnAt === undefined);
    const entry = file.signedManifest.manifest.items[0];
    if (entry === undefined) throw new Error('fixture has no manifest entry');
    const items = live.map(item => ({
      ...entry,
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      version: item.versions.at(-1)?.version ?? 1,
      digest: this.signedDigest ?? item.versions.at(-1)?.digest ?? DIGEST,
    }));
    return Promise.resolve({
      ...file,
      signedManifest: { ...file.signedManifest, manifest: { ...file.signedManifest.manifest, items } },
    });
  }
}
