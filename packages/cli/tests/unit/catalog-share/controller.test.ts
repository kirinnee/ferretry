import { describe, it } from 'bun:test';
import should from 'should';
import { ShareController, type ShareMintOptions } from '../../../src/lib/catalog-share/controller';
import { CapturingOutput, CATALOG_ID, OTHER_CATALOG_ID, ScriptedPrompt } from '../catalog/fixtures';
import { FixedTerminalSize, StubQrEncoder } from '../pair/fixtures';
import {
  CapturingShareScreen,
  FakeCatalogs,
  FakeSharing,
  KEY_ID,
  LINK,
  MEMBER_ID,
  memberView,
  mintResponse,
  OTHER_KEY_ID,
  OTHER_MEMBER_ID,
  SHARE_CODE,
  SHARE_ID,
  shareView,
} from './fixtures';

const QR = '█▀█\n█▄█';

function build(
  options: {
    answers?: readonly string[];
    interactive?: boolean;
    columns?: number | undefined;
    sharing?: FakeSharing;
  } = {},
) {
  const sharing = options.sharing ?? new FakeSharing();
  const catalogs = new FakeCatalogs();
  const out = new CapturingOutput();
  const screen = new CapturingShareScreen();
  const qr = new StubQrEncoder(QR);
  const prompt = new ScriptedPrompt(options.answers ?? []);
  const controller = new ShareController({
    sharing,
    catalogs,
    out,
    screen,
    qr,
    terminal: new FixedTerminalSize('columns' in options ? options.columns : 80),
    prompt,
    interactive: options.interactive ?? false,
    binaryName: 'fy',
  });
  return { controller, sharing, catalogs, out, screen, qr, prompt };
}

const forSam: ShareMintOptions = { member: 'Sam', expires: '1h' };

describe('ShareController.share validation', () => {
  it('should ask for a catalog before anything else', async () => {
    const { controller, sharing, catalogs } = build();
    await should(controller.share([], forSam)).rejectedWith('say which catalog to share');
    should(sharing.calls).have.length(0);
    should(catalogs.listed).equal(0);
  });

  it('should need exactly one of --member and --to', async () => {
    const { controller, sharing } = build();
    const message = /say who it is for: --member <new name> for a new person, or --to <id or name>/u;
    await should(controller.share(['Team tools'], { expires: '1h' })).rejectedWith(message);
    await should(controller.share(['Team tools'], { expires: '1h', member: 'Sam', to: 'Alex' })).rejectedWith(message);
    should(sharing.calls).have.length(0);
  });

  it('should need --multi for --cap', async () => {
    const { controller, sharing } = build();
    await should(controller.share(['Team tools'], { ...forSam, cap: '5' })).rejectedWith('--cap needs --multi');
    should(sharing.calls).have.length(0);
  });

  it('should need --member for --multi, since a many-person link makes its own member', async () => {
    const { controller, sharing } = build();
    await should(controller.share(['Team tools'], { to: 'Sam', expires: '1h', multi: true })).rejectedWith(
      'a link for many people makes its own member: name it with --member',
    );
    should(sharing.calls).have.length(0);
  });

  it('should refuse a missing or unknown --expires, listing the choices', async () => {
    const { controller, sharing } = build();
    const message = 'say how long the link lives: --expires 15m|1h|3h|8h|1d';
    await should(controller.share(['Team tools'], { member: 'Sam' })).rejectedWith(message);
    await should(controller.share(['Team tools'], { member: 'Sam', expires: '2d' })).rejectedWith(message);
    should(sharing.calls).have.length(0);
  });

  it('should refuse a --cap that is not a whole number from 2 to 200', async () => {
    const { controller, sharing } = build();
    for (const cap of ['abc', '1', '0', '201', '2.5', '']) {
      await should(controller.share(['Team tools'], { ...forSam, multi: true, cap })).rejectedWith(
        '--cap is a whole number from 2 to 200',
      );
    }
    should(sharing.calls.filter(call => call.call === 'mint')).have.length(0);
  });

  it('should refuse a catalog this machine does not have, and mint nothing', async () => {
    const { controller, sharing } = build();
    await should(controller.share(['Nope'], forSam)).rejectedWith('no catalog "Nope"');
    should(sharing.calls).have.length(0);
  });

  it('should refuse a person who has not joined, and mint nothing', async () => {
    const { controller, sharing } = build();
    await should(controller.share(['Team tools'], { to: 'Nobody', expires: '1h' })).rejectedWith('no person "Nobody"');
    should(sharing.calls.some(call => call.call === 'mint')).be.false();
  });
});

describe('ShareController.share minting', () => {
  it('should mint for a new person, single use, and draw the link once on the screen', async () => {
    const { controller, sharing, out, screen, qr } = build();
    await controller.share(['Team tools'], forSam);
    should(sharing.calls).eql([
      {
        call: 'mint',
        request: {
          catalogIds: [CATALOG_ID],
          member: { kind: 'new', label: 'Sam' },
          expiresIn: '1h',
          uses: { kind: 'single' },
        },
      },
    ]);
    should(screen.writes).have.length(1);
    should(screen.text).containEql('Share link for Sam: Team tools');
    should(screen.text).containEql(LINK);
    should(screen.text).containEql('█▀█');
    should(screen.text).not.containEql('WARNING');
    should(qr.requests).eql([{ value: LINK, size: 'compact' }]);
    should(out.lines).have.length(0);
  });

  it('should trim the new person’s name and the catalog reference', async () => {
    const { controller, sharing } = build();
    await controller.share(['  Team tools '], { member: '  Sam  ', expires: '15m' });
    should(sharing.calls[0]).match({
      call: 'mint',
      request: { member: { kind: 'new', label: 'Sam' }, expiresIn: '15m', catalogIds: [CATALOG_ID] },
    });
  });

  it('should share several catalogs by name or id, each once', async () => {
    const { controller, sharing } = build();
    await controller.share(['Team tools', CATALOG_ID, 'side tools'], forSam);
    should(sharing.calls[0]).match({ request: { catalogIds: [CATALOG_ID, OTHER_CATALOG_ID] } });
  });

  it('should share to a person who has joined, by name, and warn what the link opens', async () => {
    const { controller, sharing, screen } = build();
    await controller.share(['Team tools'], { to: 'sam', expires: '3h', yes: true });
    should(sharing.calls.map(call => call.call)).eql(['members', 'mint']);
    should(sharing.calls[1]).match({
      call: 'mint',
      request: { member: { kind: 'existing', memberId: MEMBER_ID }, expiresIn: '3h', uses: { kind: 'single' } },
    });
    should(screen.text).containEql(
      'WARNING: Whoever opens this link can read everything Sam can read, on top of what you are sharing now.',
    );
    should(screen.text).containEql('can read everything Sam can read');
  });

  it('should share to a person by id', async () => {
    const { controller, sharing } = build();
    await controller.share(['Team tools'], { to: MEMBER_ID, expires: '8h', yes: true });
    should(sharing.calls[1]).match({ request: { member: { kind: 'existing', memberId: MEMBER_ID }, expiresIn: '8h' } });
  });

  it('should ask, with the warning in the question, BEFORE it makes a link for a person who has joined', async () => {
    const { controller, sharing, prompt } = build({ interactive: true, answers: ['y'] });
    await controller.share(['Team tools'], { to: 'sam', expires: '1h' });
    should(prompt.asked).eql([
      'Whoever opens this link can read everything Sam can read, on top of what you are sharing now. Make the link for Sam? [y/N]',
    ]);
    should(sharing.calls.map(call => call.call)).eql(['members', 'mint']);
  });

  it('should make no link when the owner declines the question', async () => {
    const { controller, sharing, screen } = build({ interactive: true, answers: ['n'] });
    await should(controller.share(['Team tools'], { to: 'sam', expires: '1h' })).rejectedWith(
      'cancelled — nothing was changed',
    );
    should(sharing.calls.map(call => call.call)).eql(['members']);
    should(screen.writes).have.length(0);
  });

  it('should need --yes off a terminal, and make no link without it', async () => {
    const { controller, sharing, prompt } = build({ interactive: false });
    await should(controller.share(['Team tools'], { to: 'sam', expires: '1h' })).rejectedWith(
      'nobody to ask on this terminal — pass --yes to go ahead',
    );
    should(prompt.asked).have.length(0);
    should(sharing.calls.map(call => call.call)).eql(['members']);
  });

  it('should not ask when --yes is given, or when the person is new', async () => {
    const yes = build({ interactive: true });
    await yes.controller.share(['Team tools'], { to: 'sam', expires: '1h', yes: true });
    should(yes.prompt.asked).have.length(0);
    const fresh = build({ interactive: true });
    await fresh.controller.share(['Team tools'], forSam);
    should(fresh.prompt.asked).have.length(0);
  });

  it('should not warn when the person is new', async () => {
    const { controller, screen } = build();
    await controller.share(['Team tools'], forSam);
    should(screen.text).not.containEql('can read everything');
  });

  it('should mint a multi-use link with the default cap, and with a chosen one', async () => {
    const first = build();
    await first.controller.share(['Team tools'], { ...forSam, multi: true });
    should(first.sharing.calls[0]).match({ request: { uses: { kind: 'multi', cap: 50 } } });
    const second = build();
    await second.controller.share(['Team tools'], { ...forSam, expires: '1d', multi: true, cap: '7' });
    should(second.sharing.calls[0]).match({ request: { uses: { kind: 'multi', cap: 7 }, expiresIn: '1d' } });
    const top = build();
    await top.controller.share(['Team tools'], { ...forSam, multi: true, cap: '200' });
    should(top.sharing.calls[0]).match({ request: { uses: { kind: 'multi', cap: 200 } } });
    const bottom = build();
    await bottom.controller.share(['Team tools'], { ...forSam, multi: true, cap: '2' });
    should(bottom.sharing.calls[0]).match({ request: { uses: { kind: 'multi', cap: 2 } } });
  });

  it('should print one JSON payload to stdout and draw no QR', async () => {
    const { controller, out, screen, qr } = build();
    await controller.share(['Team tools'], { ...forSam, json: true });
    should(out.lines).have.length(1);
    should(JSON.parse(out.text)).eql(JSON.parse(JSON.stringify(mintResponse())));
    should(JSON.parse(out.text).link).equal(LINK);
    should(screen.writes).have.length(0);
    should(qr.requests).have.length(0);
    should(out.warnings).have.length(0);
    should(out.diagnostics).have.length(0);
  });
});

describe('ShareController.share QR', () => {
  it('should ask the encoder for the large QR on --large', async () => {
    const { controller, qr } = build();
    await controller.share(['Team tools'], { ...forSam, large: true });
    should(qr.requests).eql([{ value: LINK, size: 'large' }]);
  });

  it('should withhold a QR wider than the terminal, say so, and still print the link', async () => {
    const { controller, screen } = build({ columns: 4 });
    await controller.share(['Team tools'], forSam);
    should(screen.text).not.containEql('█▀█');
    should(screen.text).containEql('The QR needs 5 columns and this window has 4, so it is not drawn');
    should(screen.text).containEql(LINK);
  });

  it('should draw the QR when the terminal cannot say how wide it is', async () => {
    const { controller, screen } = build({ columns: undefined });
    await controller.share(['Team tools'], forSam);
    should(screen.text).containEql('█▀█');
    should(screen.text).not.containEql('The QR needs');
  });

  it('should draw the QR when it just fits', async () => {
    const { controller, screen } = build({ columns: 5 });
    await controller.share(['Team tools'], forSam);
    should(screen.text).containEql('█▀█');
  });
});

describe('the link is printed once, and only by the mint', () => {
  it('should leave neither a code nor a link in any other output', async () => {
    const { controller, out, screen } = build({ interactive: true, answers: ['y', 'y', 'y'] });
    await controller.share(['Team tools'], forSam);
    const afterMint = { lines: out.lines.length, writes: screen.writes.length };
    await controller.shares({});
    await controller.shares({ json: true });
    await controller.members({});
    await controller.members({ json: true });
    await controller.unshare(SHARE_ID, {});
    await controller.unshare(SHARE_ID, { json: true });
    await controller.rename('Sam', 'Samuel', {});
    await controller.rename('Sam', 'Samuel', { json: true });
    await controller.revoke('Sam', {});
    await controller.forgetKey('Sam', KEY_ID, {});
    await controller.take('Sam', 'Team tools', {});
    await controller.revoke('Sam', { yes: true, json: true });
    const later = [
      ...out.lines.slice(afterMint.lines),
      ...out.warnings,
      ...out.diagnostics,
      ...screen.writes.slice(afterMint.writes),
    ];
    should(later.length).be.above(10);
    for (const text of later) {
      should(text).not.containEql('fy_share_');
      should(text).not.containEql('/join#');
    }
    should(screen.writes).have.length(1);
    should(screen.text.split(SHARE_CODE).length - 1).equal(1);
  });
});

describe('ShareController.shares and members', () => {
  it('should list shares with catalog names, reading the catalogs once', async () => {
    const { controller, out, catalogs } = build();
    await controller.shares({});
    should(out.text).containEql(`${SHARE_ID} · Sam (${MEMBER_ID}) · live until`);
    should(out.text).containEql('Team tools · single use');
    should(catalogs.listed).equal(1);
  });

  it('should print the shares payload as JSON without reading the catalogs', async () => {
    const { controller, out, catalogs } = build();
    await controller.shares({ json: true });
    should(JSON.parse(out.text).shares[0].shareId).equal(SHARE_ID);
    should(catalogs.listed).equal(0);
  });

  it('should list members with their browsers', async () => {
    const { controller, out, catalogs } = build();
    await controller.members({});
    should(out.text).containEql(`Sam (${MEMBER_ID}) · since`);
    should(out.text).containEql('reads: Team tools');
    should(out.text).containEql(`Firefox on a Mac (${KEY_ID})`);
    should(catalogs.listed).equal(1);
  });

  it('should print the members payload as JSON without reading the catalogs', async () => {
    const { controller, out, catalogs } = build();
    await controller.members({ json: true });
    should(JSON.parse(out.text).members[0].memberId).equal(MEMBER_ID);
    should(catalogs.listed).equal(0);
  });
});

describe('ShareController.unshare and rename', () => {
  it('should end a share by its trimmed id', async () => {
    const { controller, sharing, out } = build();
    await controller.unshare(`  ${SHARE_ID} `, {});
    should(sharing.calls).eql([{ call: 'endShare', shareId: SHARE_ID }]);
    should(out.text).equal(`Ended share ${SHARE_ID} for Sam. Its code no longer works.`);
  });

  it('should print the ended share as JSON', async () => {
    const { controller, out } = build();
    await controller.unshare(SHARE_ID, { json: true });
    should(JSON.parse(out.text).state).equal('ended');
  });

  it('should rename a person found by name, with the label trimmed', async () => {
    const { controller, sharing, out } = build();
    await controller.rename('SAM', '  Samuel ', {});
    should(sharing.calls).eql([{ call: 'members' }, { call: 'renameMember', memberId: MEMBER_ID, label: 'Samuel' }]);
    should(out.text).equal(`${MEMBER_ID} is now called Samuel.`);
  });

  it('should print the renamed person as JSON', async () => {
    const { controller, out } = build();
    await controller.rename(MEMBER_ID, 'Samuel', { json: true });
    should(JSON.parse(out.text)).match({ memberId: MEMBER_ID, label: 'Samuel' });
  });

  it('should refuse to rename a person who has not joined', async () => {
    const { controller, sharing } = build();
    await should(controller.rename('Nobody', 'X', {})).rejectedWith('no person "Nobody"');
    should(sharing.calls.some(call => call.call === 'renameMember')).be.false();
  });
});

describe('ShareController.revoke', () => {
  it('should ask first, naming the person and their browsers, then remove them on y', async () => {
    const { controller, sharing, out, prompt } = build({ interactive: true, answers: ['y'] });
    await controller.revoke('Sam', {});
    should(prompt.asked).eql([`Remove Sam (${MEMBER_ID}), sign out their 1 browser(s) and end their shares? [y/N]`]);
    should(sharing.calls.at(-1)).eql({ call: 'revokeMember', memberId: MEMBER_ID });
    should(out.text).equal(`Removed Sam (${MEMBER_ID}): 2 browsers signed out, 1 share ended.`);
  });

  it('should accept yes in any case and with spaces', async () => {
    for (const answer of ['yes', 'YES', ' Yes ', 'Y']) {
      const { controller, sharing } = build({ interactive: true, answers: [answer] });
      await controller.revoke('Sam', {});
      should(sharing.calls.some(call => call.call === 'revokeMember')).be.true();
    }
  });

  it('should leave everything alone on a declined or empty answer', async () => {
    for (const answer of ['n', 'no', '', 'yep', 'maybe']) {
      const { controller, sharing } = build({ interactive: true, answers: [answer] });
      await should(controller.revoke('Sam', {})).rejectedWith('cancelled — nothing was changed');
      should(sharing.calls.some(call => call.call === 'revokeMember')).be.false();
    }
  });

  it('should refuse to guess when nobody can be asked', async () => {
    const { controller, sharing, prompt } = build({ interactive: false });
    await should(controller.revoke('Sam', {})).rejectedWith('nobody to ask on this terminal — pass --yes to go ahead');
    should(prompt.asked).have.length(0);
    should(sharing.calls.some(call => call.call === 'revokeMember')).be.false();
  });

  it('should go ahead on --yes without asking, even when not on a terminal', async () => {
    const { controller, sharing, prompt } = build({ interactive: false });
    await controller.revoke('Sam', { yes: true });
    should(prompt.asked).have.length(0);
    should(sharing.calls.at(-1)).eql({ call: 'revokeMember', memberId: MEMBER_ID });
  });

  it('should print what was removed as JSON', async () => {
    const { controller, out } = build();
    await controller.revoke('Sam', { yes: true, json: true });
    should(JSON.parse(out.text)).eql({ memberId: MEMBER_ID, keysRemoved: 2, sharesEnded: 1 });
  });

  it('should refuse a person who has not joined', async () => {
    const { controller } = build();
    await should(controller.revoke('Nobody', { yes: true })).rejectedWith('no person "Nobody"');
  });

  it('should find the right person among several', async () => {
    const sharing = new FakeSharing({
      members: [memberView(), memberView({ memberId: OTHER_MEMBER_ID, label: 'Alex' })],
      shares: [shareView()],
      mint: mintResponse(),
    });
    const { controller } = build({ sharing });
    await controller.revoke('alex', { yes: true });
    should(sharing.calls.at(-1)).eql({ call: 'revokeMember', memberId: OTHER_MEMBER_ID });
  });
});

describe('ShareController.forgetKey', () => {
  const twoBrowsers = (): FakeSharing =>
    new FakeSharing({
      members: [
        memberView({
          keys: [
            { keyId: KEY_ID, clientName: 'Firefox on a Mac', joinedAt: '2026-10-31T09:00:00.000Z', passkeys: 1 },
            { keyId: OTHER_KEY_ID, clientName: 'Safari', joinedAt: '2026-10-31T09:00:00.000Z', passkeys: 0 },
          ],
        }),
      ],
      shares: [],
      mint: mintResponse(),
    });

  it('should ask, naming the browser and the person, then remove only that browser', async () => {
    const { controller, sharing, out, prompt } = build({ sharing: twoBrowsers(), interactive: true, answers: ['y'] });
    await controller.forgetKey('Sam', 'safari', {});
    should(prompt.asked).eql([`Remove Safari (${OTHER_KEY_ID}) from Sam? [y/N]`]);
    should(sharing.calls.at(-1)).eql({ call: 'removeKey', memberId: MEMBER_ID, keyId: OTHER_KEY_ID });
    should(out.text).equal(`Removed browser ${OTHER_KEY_ID} of Sam. Their other browsers still work.`);
  });

  it('should find a browser by its id', async () => {
    const { controller, sharing } = build({ sharing: twoBrowsers() });
    await controller.forgetKey(MEMBER_ID, KEY_ID, { yes: true });
    should(sharing.calls.at(-1)).eql({ call: 'removeKey', memberId: MEMBER_ID, keyId: KEY_ID });
  });

  it('should leave the browser alone on a declined answer or without a terminal', async () => {
    const declined = build({ sharing: twoBrowsers(), interactive: true, answers: ['no'] });
    await should(declined.controller.forgetKey('Sam', 'Safari', {})).rejectedWith('cancelled — nothing was changed');
    const silent = build({ sharing: twoBrowsers() });
    await should(silent.controller.forgetKey('Sam', 'Safari', {})).rejectedWith(/pass --yes/u);
    for (const run of [declined, silent]) should(run.sharing.calls.some(call => call.call === 'removeKey')).be.false();
  });

  it('should refuse an unknown browser', async () => {
    const { controller, sharing } = build({ sharing: twoBrowsers() });
    await should(controller.forgetKey('Sam', 'Opera', { yes: true })).rejectedWith('no browser of Sam "Opera"');
    should(sharing.calls.some(call => call.call === 'removeKey')).be.false();
  });

  it('should print the removal as JSON', async () => {
    const { controller, out } = build();
    await controller.forgetKey('Sam', KEY_ID, { yes: true, json: true });
    should(JSON.parse(out.text)).eql({ memberId: MEMBER_ID, keyId: KEY_ID });
  });
});

describe('ShareController.take', () => {
  it('should ask, naming the catalog and the person, then take it by name', async () => {
    const { controller, sharing, out, prompt } = build({ interactive: true, answers: ['y'] });
    await controller.take('Sam', 'team TOOLS', {});
    should(prompt.asked).eql([`Stop Sam reading Team tools (${CATALOG_ID})? [y/N]`]);
    should(sharing.calls.at(-1)).eql({ call: 'removeCatalog', memberId: MEMBER_ID, catalogId: CATALOG_ID });
    should(out.text).equal(`Sam (${MEMBER_ID}) can no longer read Team tools (${CATALOG_ID}).`);
  });

  it('should take a catalog by the id the person holds', async () => {
    const { controller, sharing, out } = build();
    await controller.take('Sam', `  ${CATALOG_ID} `, { yes: true });
    should(sharing.calls.at(-1)).eql({ call: 'removeCatalog', memberId: MEMBER_ID, catalogId: CATALOG_ID });
    should(out.text).containEql('Team tools');
  });

  it('should take a held catalog this machine no longer has, naming it by its id', async () => {
    const gone = `cat_${'z'.repeat(22)}`;
    const sharing = new FakeSharing({
      members: [memberView({ catalogIds: [gone] })],
      shares: [],
      mint: mintResponse(),
    });
    const { controller, out } = build({ sharing });
    await controller.take('Sam', gone, { yes: true });
    should(sharing.calls.at(-1)).eql({ call: 'removeCatalog', memberId: MEMBER_ID, catalogId: gone });
    should(out.text).equal(`Sam (${MEMBER_ID}) can no longer read ${gone} (${gone}).`);
  });

  it('should refuse a catalog the person does not hold, even one the owner has', async () => {
    const { controller, sharing } = build();
    await should(controller.take('Sam', 'Side tools', { yes: true })).rejectedWith('no catalog "Side tools"');
    await should(controller.take('Sam', OTHER_CATALOG_ID, { yes: true })).rejectedWith(/no catalog/u);
    should(sharing.calls.some(call => call.call === 'removeCatalog')).be.false();
  });

  it('should leave the catalog alone on a declined answer or without a terminal', async () => {
    const declined = build({ interactive: true, answers: ['n'] });
    await should(declined.controller.take('Sam', 'Team tools', {})).rejectedWith('cancelled — nothing was changed');
    const silent = build();
    await should(silent.controller.take('Sam', 'Team tools', {})).rejectedWith(/pass --yes/u);
    for (const run of [declined, silent])
      should(run.sharing.calls.some(call => call.call === 'removeCatalog')).be.false();
  });

  it('should print the removal as JSON', async () => {
    const { controller, out } = build();
    await controller.take('Sam', 'Team tools', { yes: true, json: true });
    should(JSON.parse(out.text)).eql({ memberId: MEMBER_ID, catalogId: CATALOG_ID });
  });
});
