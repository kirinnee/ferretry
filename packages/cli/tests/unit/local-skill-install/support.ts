import type {
  LocalSkillInstall,
  LocalSkillInstalled,
  LocalSkillInstallList,
  LocalSkillInstallRequest,
  LocalSkillPreview,
  LocalSkillPreviewRequest,
  LocalSkillRemoved,
  CatalogInstallScope,
} from '@ferretry/protocol';
import type {
  ILocalSkillInstallGateway,
  ILocalSkillInstallOutput,
  ILocalSkillInstallPrompt,
} from '../../../src/lib/local-skill-install/ports.ts';

export const INSTALL_ID = `lsi_${'n'.repeat(22)}` as LocalSkillInstall['installId'];
export const PREVIEW_ID = `lsp_${'v'.repeat(22)}` as LocalSkillPreview['previewId'];
const AT = '2026-11-02T09:00:00.000Z';

const origin: LocalSkillInstall['origin'] = {
  kind: 'account',
  owner: 'claude-work',
  harness: 'claude',
  path: '/home/a/.claude/skills/pdf-tools/SKILL.md',
};

export const previewOf = (overrides: Partial<LocalSkillPreview> = {}): LocalSkillPreview => ({
  previewId: PREVIEW_ID,
  expiresAt: AT,
  name: 'pdf-tools',
  origin,
  provenance: {
    publisher: `fy_daemon_${'0'.repeat(43)}` as LocalSkillPreview['provenance']['publisher'],
    publisherName: 'This machine',
    catalogId: `cat_${'0'.repeat(22)}` as LocalSkillPreview['provenance']['catalogId'],
    catalogName: 'Skills on this machine',
    itemId: `itm_${'a'.repeat(22)}` as LocalSkillPreview['provenance']['itemId'],
    kind: 'skill',
    name: 'pdf-tools',
    version: 1,
    digest: `sha256:${'a'.repeat(64)}` as LocalSkillPreview['provenance']['digest'],
  },
  target: { scope: 'project', projectRoot: '/work/repo', harness: 'claude' },
  destination: '/work/repo/.claude/skills/pdf-tools/ (1 file)',
  review: [
    { label: 'Starts', text: 'acme', document: false },
    { label: 'Skill file SKILL.md', text: 'line one\nline two', document: true },
  ],
  skipped: [],
  warnings: [],
  ...overrides,
});

export const installOf = (scope: CatalogInstallScope = 'project'): LocalSkillInstall => ({
  installId: INSTALL_ID,
  installedAt: AT,
  name: 'pdf-tools',
  origin,
  target:
    scope === 'project'
      ? { scope: 'project', projectRoot: '/work/repo', harness: 'claude' }
      : { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
  destination: scope === 'project' ? '/work/repo/.claude/skills/pdf-tools/ (1 file)' : 'the skill pdf-tools',
  files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64) }],
});

export class FakeGateway implements ILocalSkillInstallGateway {
  readonly previews: { scope: CatalogInstallScope; request: LocalSkillPreviewRequest }[] = [];
  readonly applies: { scope: CatalogInstallScope; request: LocalSkillInstallRequest }[] = [];
  readonly removes: { scope: CatalogInstallScope; installId: string }[] = [];
  preview: LocalSkillPreview = previewOf();
  installs: LocalSkillInstall[] = [];
  notes: string[] = [];
  failure: Error | undefined;

  async previewLocalSkillInstall(scope: CatalogInstallScope, request: LocalSkillPreviewRequest) {
    this.previews.push({ scope, request });
    if (this.failure !== undefined) throw this.failure;
    return this.preview;
  }

  async applyLocalSkillInstall(
    scope: CatalogInstallScope,
    request: LocalSkillInstallRequest,
  ): Promise<LocalSkillInstalled> {
    this.applies.push({ scope, request });
    if (this.failure !== undefined) throw this.failure;
    return { install: installOf(scope), notes: this.notes };
  }

  async localSkillInstalls(): Promise<LocalSkillInstallList> {
    return { installs: this.installs };
  }

  async removeLocalSkillInstall(scope: CatalogInstallScope, installId: string): Promise<LocalSkillRemoved> {
    this.removes.push({ scope, installId });
    if (this.failure !== undefined) throw this.failure;
    return { installId: INSTALL_ID, name: 'pdf-tools', destination: 'gone' };
  }
}

export class FakeOutput implements ILocalSkillInstallOutput {
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

export class FakePrompt implements ILocalSkillInstallPrompt {
  readonly asked: string[] = [];
  constructor(private readonly answers: string[] = []) {}
  async ask(message: string): Promise<string> {
    this.asked.push(message);
    return this.answers.shift() ?? '';
  }
}
