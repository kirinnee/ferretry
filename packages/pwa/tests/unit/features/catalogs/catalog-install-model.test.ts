import { describe, it } from 'bun:test';
import { SHARED_CATALOG_FILE_MAX_BYTES, type SecretList } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import {
  bindableSecretNames,
  bindingNote,
  fileItemRows,
  fileSizeProblem,
  fileSummary,
  heldHint,
  installedFromLine,
  installRefusal,
  installRequest,
  installsFor,
  installState,
  openCatalogFile,
  pickBinding,
  previewDisagreement,
  PREVIEW_DISAGREES,
  previewRequest,
  targetProblem,
  toTarget,
  unchosenPlaceholders,
  unpickBinding,
  withdrawnNote,
} from '../../../../src/features/catalogs/catalog-install-model.ts';
import { crypto, mcpItem, newIdentity, signedFile, skillItem, SKILL_ITEM_ID } from '../../../support/catalog-files.ts';
import { installPreview, installRecord, PREVIEW_ID } from '../../../support/catalog-views.ts';

describe('the machine and the file agree', () => {
  it('shows the review only when it names the publisher, catalog and item the verified file does', async () => {
    const identity = await newIdentity();
    const skill = skillItem(identity.daemonId);
    const result = await openCatalogFile(JSON.stringify(await signedFile(identity, [skill])), crypto);
    if (!result.ok) throw new Error(result.sentence);
    const entry = result.opened.manifest.items[0];
    if (entry === undefined) throw new Error('no entry');
    const base = installPreview();
    const agreeing = installPreview({
      provenance: {
        ...base.provenance,
        publisher: identity.daemonId,
        catalogName: "Kirin's catalog",
        itemId: entry.itemId,
        kind: entry.kind,
        name: entry.name,
        version: entry.version,
        digest: entry.digest,
      },
      publisher: { ...base.publisher, daemonId: identity.daemonId },
    });
    const check = (preview: typeof agreeing, itemId = entry.itemId) =>
      previewDisagreement(result.opened, itemId, preview);
    should(check(agreeing)).be.null();
    const other = installPreview({
      provenance: { ...agreeing.provenance },
      publisher: { ...agreeing.publisher, daemonId: base.publisher.daemonId },
    });
    should(check(other)).equal(PREVIEW_DISAGREES);
    const provenanceChange = (change: Record<string, unknown>) =>
      installPreview({ provenance: { ...agreeing.provenance, ...change }, publisher: agreeing.publisher });
    should(check(provenanceChange({ catalogName: 'Another catalog' }))).equal(PREVIEW_DISAGREES);
    // The item, too: the machine may not review a different one than the one chosen from the signed list.
    should(check(provenanceChange({ itemId: `itm_${'z'.repeat(22)}` }))).equal(PREVIEW_DISAGREES);
    should(check(provenanceChange({ kind: 'mcp' }))).equal(PREVIEW_DISAGREES);
    should(check(provenanceChange({ name: 'other-skill' }))).equal(PREVIEW_DISAGREES);
    should(check(provenanceChange({ version: entry.version + 1 }))).equal(PREVIEW_DISAGREES);
    should(check(provenanceChange({ digest: `sha256:${'1'.repeat(64)}` }))).equal(PREVIEW_DISAGREES);
    should(check(agreeing, `itm_${'y'.repeat(22)}`)).equal(PREVIEW_DISAGREES);
  });
});

describe('opening a file', () => {
  it('bounds the size before reading', () => {
    should(fileSizeProblem(SHARED_CATALOG_FILE_MAX_BYTES)).be.null();
    should(fileSizeProblem(SHARED_CATALOG_FILE_MAX_BYTES + 1)).match(/32 MB/u);
  });
  it('opens a signed file and lists its items', async () => {
    const identity = await newIdentity();
    const skill = skillItem(identity.daemonId);
    const mcp = mcpItem(identity.daemonId);
    const file = await signedFile(identity, [skill, mcp], [skill]);
    const result = await openCatalogFile(JSON.stringify(file), crypto);
    if (!result.ok) throw new Error(result.sentence);
    should(fileSummary(result.opened)).equal("Kirin's catalog · 2 items");
    const rows = fileItemRows(result.opened);
    should(rows.map(row => row.unavailable)).eql([null, 'This file does not carry this item.']);
    should(withdrawnNote(result.opened)).be.null();
  });
  it('counts what the publisher withdrew', async () => {
    const identity = await newIdentity();
    const skill = skillItem(identity.daemonId);
    const mcp = mcpItem(identity.daemonId);
    const file = await signedFile(identity, [skill, mcp], [skill], [mcp.itemId]);
    const result = await openCatalogFile(JSON.stringify(file), crypto);
    if (!result.ok) throw new Error(result.sentence);
    should(withdrawnNote(result.opened)).equal('1 item withdrawn by the publisher, so not listed.');
  });
  it('refuses text that is not a catalog file', async () => {
    const result = await openCatalogFile('{"nope":1}', crypto);
    should(result).containEql({ ok: false, sentence: 'This is not a catalog file.' });
  });
  it('refuses a file whose item was changed after signing', async () => {
    const identity = await newIdentity();
    const skill = skillItem(identity.daemonId);
    const file = await signedFile(identity, [skill]);
    const edited = {
      ...file,
      items: [{ ...skill, skill: { files: [{ path: 'SKILL.md', content: '# changed\n' }] } }],
    };
    const result = await openCatalogFile(JSON.stringify(edited), crypto);
    if (result.ok) throw new Error('should refuse');
    should(result.sentence).match(/Nothing was installed/u);
    should(result.sentence).match(/not the one its signed list describes/u);
  });
  it('refuses a file signed by somebody else', async () => {
    const identity = await newIdentity();
    const skill = skillItem(identity.daemonId);
    const file = await signedFile(identity, [skill]);
    const forged = {
      ...file,
      signedManifest: { ...file.signedManifest, manifest: { ...file.signedManifest.manifest, name: 'Forged' } },
    };
    const result = await openCatalogFile(JSON.stringify(forged), crypto);
    if (result.ok) throw new Error('should refuse');
    should(result.sentence).match(/not signed by the machine it names/u);
  });
});

describe('the wire request', () => {
  it('carries the signed list, the item and the target', async () => {
    const identity = await newIdentity();
    const skill = skillItem(identity.daemonId);
    const result = await openCatalogFile(JSON.stringify(await signedFile(identity, [skill])), crypto);
    if (!result.ok) throw new Error(result.sentence);
    const target = { scope: 'runtime', runtime: 'box', profile: 'default' } as const;
    const request = previewRequest(result.opened, SKILL_ITEM_ID, target, false);
    should(request?.item.itemId).equal(SKILL_ITEM_ID);
    should(request).not.have.property('allowOlder');
    should(previewRequest(result.opened, SKILL_ITEM_ID, target, true)).containEql({ allowOlder: true });
    should(previewRequest(result.opened, 'itm_missing', target, false)).be.null();
  });
});

describe('target', () => {
  const options = {
    projects: [{ root: '/work/app', label: 'app' }],
    runtimes: [{ runtime: 'box', profiles: ['default', 'work'] }],
  };
  it('asks for each part in turn', () => {
    should(targetProblem(null, options)).match(/where/u);
    should(targetProblem({}, options)).match(/where/u);
    should(targetProblem({ scope: 'project' }, options)).equal('Pick a project.');
    should(targetProblem({ scope: 'project', projectRoot: '/other' }, options)).equal('Pick a project.');
    should(targetProblem({ scope: 'project', projectRoot: '/work/app' }, options)).match(/Claude or Codex/u);
    should(targetProblem({ scope: 'project', projectRoot: '/work/app', harness: 'codex' }, options)).be.null();
    should(targetProblem({ scope: 'runtime' }, options)).equal('Pick a runtime.');
    should(targetProblem({ scope: 'runtime', runtime: 'box' }, options)).equal('Pick a profile.');
    should(targetProblem({ scope: 'runtime', runtime: 'box', profile: 'nope' }, options)).equal('Pick a profile.');
    should(targetProblem({ scope: 'runtime', runtime: 'box', profile: 'work' }, options)).be.null();
  });
  it('builds the wire target only from a whole pick', () => {
    should(toTarget({ scope: 'project', projectRoot: '/work/app', harness: 'claude' })).eql({
      scope: 'project',
      projectRoot: '/work/app',
      harness: 'claude',
    });
    should(toTarget({ scope: 'project', projectRoot: '/work/app' })).be.null();
    should(toTarget({ scope: 'project', harness: 'claude' })).be.null();
    should(toTarget({ scope: 'runtime', runtime: 'box', profile: 'work' })).eql({
      scope: 'runtime',
      runtime: 'box',
      profile: 'work',
    });
    should(toTarget({ scope: 'runtime', runtime: 'box' })).be.null();
    should(toTarget({ scope: 'runtime', profile: 'work' })).be.null();
    should(toTarget({})).be.null();
  });
});

describe('secrets', () => {
  const list = (health: 'ready' | 'damaged', names: readonly string[]): SecretList =>
    ({ v: 1, health, secrets: names.map(name => ({ name })), references: [] }) as unknown as SecretList;
  it('offers this machine’s own names, sorted, and no sign-in tokens', () => {
    should(bindableSecretNames(null)).eql([]);
    should(bindableSecretNames(list('damaged', ['A']))).eql([]);
    const names = bindableSecretNames(list('ready', ['ZED', 'ALPHA', 'FY_MCP_OAUTH_TOKEN_x']));
    should(names).containEql('ALPHA');
    should(names.indexOf('ALPHA')).be.below(names.indexOf('ZED'));
  });
  it('starts with no choice and counts what is left', () => {
    const preview = installPreview();
    should(unchosenPlaceholders(preview, {})).eql(['ACME_TOKEN', 'ACME_REGION']);
    const one = pickBinding({}, 'ACME_TOKEN', 'MY_TOKEN');
    should(unchosenPlaceholders(preview, one)).eql(['ACME_REGION']);
    const both = pickBinding(one, 'ACME_REGION', null);
    should(unchosenPlaceholders(preview, both)).eql([]);
    should(unchosenPlaceholders(preview, unpickBinding(both, 'ACME_REGION'))).eql(['ACME_REGION']);
  });
  it('words a choice and leaves an empty one silent', () => {
    should(bindingNote(undefined)).be.null();
    should(bindingNote('MY_TOKEN')).equal('This program will receive your secret MY_TOKEN.');
    should(bindingNote(null)).match(/Left unbound/u);
  });
  it('hints that a name is held only when the daemon said so', () => {
    should(heldHint(undefined)).be.null();
    should(heldHint(false)).be.null();
    should(heldHint(true)).match(/not used unless you pick it/u);
  });
});

describe('Install', () => {
  const preview = installPreview();
  it('is disabled until a preview is read and every placeholder has a choice', () => {
    should(installState(null, {}, false)).containEql({ enabled: false });
    const waiting = installState(preview, {}, false);
    should(waiting.enabled).be.false();
    should(waiting.reason).match(/ACME_TOKEN, ACME_REGION/u);
    const chosen = { ACME_TOKEN: 'MY', ACME_REGION: null };
    should(installState(preview, chosen, false)).eql({ enabled: true, reason: null });
    should(installState(preview, chosen, true).enabled).be.false();
  });
  it('is enabled at once for an item with nothing to bind', () => {
    should(installState(installPreview({ secrets: [] }), {}, false).enabled).be.true();
  });
  it('builds the apply request with every placeholder, null for unbound', () => {
    should(installRequest(preview, { ACME_TOKEN: 'MY' })).be.null();
    should(installRequest(preview, { ACME_TOKEN: 'MY', ACME_REGION: null })).eql({
      previewId: PREVIEW_ID,
      secretBindings: { ACME_TOKEN: 'MY', ACME_REGION: null },
    });
  });
});

describe('installRefusal', () => {
  const refuse = (code: string, message = 'because') => installRefusal(new FyHttpError(message, 409, code));
  it('offers a new preview when it is gone or ran out', () => {
    should(refuse('catalog_preview_unknown').previewAgain).be.true();
    should(refuse('catalog_preview_expired').previewAgain).be.true();
    should(refuse('catalog_preview_expired').sentence).match(/10 minutes/u);
    should(refuse('catalog_signature_invalid').previewAgain).be.false();
  });
  it('offers the older version only for a downgrade', () => {
    should(refuse('catalog_downgrade').olderOffered).be.true();
    should(refuse('catalog_item_mismatch').olderOffered).be.false();
  });
  it('adds the daemon’s reason where it names one', () => {
    should(refuse('catalog_install_conflict', 'SKILL.md was edited').sentence).match(/SKILL\.md was edited/u);
    should(refuse('catalog_install_conflict', '  ').sentence).not.match(/ {2}$/u);
    should(refuse('catalog_signature_invalid', 'detail').sentence).not.match(/detail/u);
  });
  it('words every refusal the installer can answer', () => {
    for (const code of [
      'catalog_signature_invalid',
      'catalog_item_mismatch',
      'catalog_publisher_changed',
      'catalog_revision_older',
      'catalog_downgrade',
      'catalog_item_invalid',
      'catalog_not_installable',
      'catalog_target_unknown',
      'catalog_bindings_invalid',
      'catalog_install_unknown',
    ])
      should(refuse(code, 'zzz').sentence).not.equal('zzz');
  });
  it('asks for a new passkey when it was not confirmed', () => {
    should(installRefusal(new FyHttpError('x', 403, 'grant_step_up_required')).sentence).match(
      /each install needs its own passkey/iu,
    );
  });
  it('falls back for anything else', () => {
    should(refuse('weird').sentence.length).be.above(0);
    should(installRefusal(new Error('x')).previewAgain).be.false();
  });
});

describe('installed items', () => {
  it('reads where an install came from', () => {
    should(installedFromLine(installRecord())).equal('From Team skills (kirin-box)');
  });
  it('matches installs to a row by kind and name', () => {
    const installs = [
      installRecord('skill', 'pdf-tools'),
      installRecord('mcp', 'pdf-tools'),
      installRecord('skill', 'other'),
    ];
    should(installsFor(installs, 'skill', 'pdf-tools')).have.length(1);
    should(installsFor(installs, 'mcp', 'pdf-tools')).have.length(1);
    should(installsFor(installs, 'mcp', 'nope')).have.length(0);
  });
});
