/**
 * CATALOG MEMBERS, END TO END (phase 2d): a person who is not the owner joins a publisher with a link,
 * adds a passkey, reads what was shared, installs it on a machine of their own, joins again, is
 * turned away, and leaves — in a real Chrome with a virtual authenticator, against two compiled
 * daemons, on the direct carrier and through a local rendezvous.
 *
 * Daemon A is the PUBLISHER and its owner (the owner's side is driven through the owner routes with the
 * admin token: the owner's screens are another suite's subject). Daemon B is the member's OWN machine.
 * The member's browsers are real: each is its own Chrome with its own profile and its own virtual
 * authenticator, so no browser ever shares a key, a cookie or a credential with another.
 *
 * Only skills are shared here. An MCP item with secret placeholders needs a fleet MCP component whose
 * environment holds `${secret:NAME}`, which this harness does not seed yet, so the install confirm's
 * secret pickers are reached on screen only when an item has placeholders — see the PR's gaps.
 */

import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture.ts';
import {
  addVirtualAuthenticator,
  asOwner,
  bootDaemon,
  confirmPairing,
  ensureOperatorPassword,
  launchProductBrowser,
  mintPairingLink,
  type ProductBrowser,
  type ProductPage,
  reapLeftovers,
  recordStep,
  resetSoftFailures,
  retryOnLostBrowser,
  step,
  textNow,
  type VirtualAuthenticator,
  waitUntil,
  writeDaemonConfig,
} from './support/product-harness.ts';
import {
  buildPwaBundle,
  harnessTeardown,
  type HarnessTeardown,
  type PwaOrigin,
  renderedDataAttributes,
  startDirectSinkhole,
  startPwaOrigin,
  startRelayDirectory,
  startRendezvous,
  waitForDaemonAtRendezvous,
  waitForDaemonFingerprint,
} from './support/relay-harness.ts';

type Carrier = 'direct' | 'relay';

const JOIN_REFUSED_SENTENCE = 'This link did not work: it may be used, expired or ended. Ask for a new one.';
const REDEEM_OTHER_MEMBER =
  'This link was made for someone else. It is now used up, and the owner has been told. Ask them for a link made for you.';
const REDEEM_NEW_MEMBER =
  'This link was made for a new person, but this browser is already a member here. It is now used up. Ask for a link made for you.';
const LEFT_SENTENCE = 'You left. You can join again later with a new link.';

const SKILL_TEAM = 'review-helper';
const SKILL_WORKSHOP = 'notes-helper';
const SHARE_CODE = /fy_share_[A-Za-z0-9_-]{22}/gu;
const SCAN_FILE_CAP = 16 * 1_024 * 1_024;

/** One daemon and the folders it was given. */
interface Machine {
  readonly environment: E2eEnvironment;
  readonly project: string;
}

/** One person's browser: its own Chrome, its own profile, its own platform authenticator. */
interface Person {
  readonly name: string;
  readonly browser: ProductBrowser;
  readonly page: ProductPage;
  readonly authenticator: VirtualAuthenticator;
}

interface World {
  readonly journey: string;
  readonly carrier: Carrier;
  readonly a: Machine;
  readonly b: Machine;
  readonly origin: PwaOrigin;
  readonly teardown: HarnessTeardown;
  readonly teamCatalog: string;
  readonly workshopCatalog: string;
  /** Every share code this run minted: the strings no file on either machine may ever hold. */
  readonly codes: string[];
  readonly people: Person[];
}

interface Minted {
  readonly code: string;
  readonly link: string;
  readonly memberId: string;
  readonly shareId: string;
  readonly publisherId: string;
}

const quoted = (value: string): string => JSON.stringify(value);

// ─── the owner's side ────────────────────────────────────────────────────────────────────────

/** An owner call that must answer one of `statuses`; anything else says what the daemon said. */
async function owner(
  machine: Machine,
  method: string,
  path: string,
  body: unknown,
  statuses: readonly number[] = [200, 201],
): Promise<unknown> {
  const answer = await asOwner(machine.environment, method, path, body);
  if (!statuses.includes(answer.status))
    throw new Error(
      `${method} ${path} answered ${String(answer.status)}: ${JSON.stringify(answer.body).slice(0, 400)}`,
    );
  return answer.body;
}

/** Run `attempt` until it stops throwing: a daemon that is still reading its inventory is not a failure. */
async function eventually<T>(what: string, attempt: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
      await Bun.sleep(250);
    }
  }
  throw new Error(`${what} never came true in ${String(timeoutMs)}ms: ${String((last as Error)?.message ?? last)}`);
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const directory = join(root, '.claude', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8',
  );
}

async function registerProject(machine: Machine, name: string): Promise<void> {
  await owner(machine, 'POST', '/v1/projects', { kind: 'existing-folder', path: machine.project, name }, [200, 201]);
}

/** A catalog holding one skill of the publisher's project: created, the skill previewed, then added. */
async function seedCatalog(machine: Machine, name: string, description: string, skill: string): Promise<string> {
  const created = (await owner(machine, 'POST', '/v1/catalogs', { name, description })) as { id: string };
  const source = { kind: 'skill', skill };
  const preview = await eventually(`the publisher previewing skill ${skill}`, async () => {
    return (await owner(machine, 'POST', `/v1/catalogs/${created.id}/items/preview`, { source })) as {
      digest: string;
    };
  });
  await owner(machine, 'POST', `/v1/catalogs/${created.id}/items`, { source, digest: preview.digest });
  return created.id;
}

/** The publisher's id is the `fp=` the link pins. */
function publisherOf(link: string): string {
  const pinned = /(?:^|;)fp=([^;]+)/u.exec(link.slice(link.indexOf('#') + 1))?.[1];
  if (pinned === undefined) throw new Error(`the share link pins no publisher: ${link.slice(0, 60)}`);
  return decodeURIComponent(pinned);
}

/** Mint a share the way the owner's route does, keep the code for the leak scan, re-host the link. */
async function mint(
  world: World,
  member: { kind: 'new'; label: string } | { kind: 'existing'; memberId: string },
  catalogIds: readonly string[],
): Promise<Minted> {
  const answer = (await owner(world.a, 'POST', '/v1/catalog-shares', {
    catalogIds,
    member,
    expiresIn: '1h',
    uses: { kind: 'single' },
  })) as { share: { shareId: string; memberId: string }; code: string; link: string };
  world.codes.push(answer.code);
  return {
    code: answer.code,
    link: `${world.origin.origin}/join#${answer.link.slice(answer.link.indexOf('#') + 1)}`,
    memberId: answer.share.memberId,
    shareId: answer.share.shareId,
    publisherId: publisherOf(answer.link),
  };
}

interface AuditRecord {
  readonly event: string;
  readonly subject?: string;
}

async function auditEvents(world: World): Promise<readonly AuditRecord[]> {
  const body = (await owner(world.a, 'GET', '/v1/audit', undefined, [200])) as {
    records?: AuditRecord[];
    kept?: AuditRecord[];
  };
  return [...(body.records ?? []), ...(body.kept ?? [])];
}

interface MemberView {
  readonly memberId: string;
  readonly label: string;
  readonly keys: readonly { readonly keyId: string; readonly passkeys: number }[];
}

async function membersOf(world: World): Promise<readonly MemberView[]> {
  return ((await owner(world.a, 'GET', '/v1/catalog-members', undefined, [200])) as { members: MemberView[] }).members;
}

// ─── the world ───────────────────────────────────────────────────────────────────────────────

/**
 * Two machines and the app, from nothing; torn down whole.
 *
 * Direct: A advertises its own loopback and the directory advertises no rendezvous, so nothing can be
 * carried by a relay by accident. Relay: A advertises a sinkhole as its direct address, so the only way
 * in for a member is the local rendezvous. B always advertises its own loopback and dials nothing,
 * because a pairing is always direct (docs/relay-protocol.md).
 */
async function withWorld(journey: string, carrier: Carrier, body: (world: World) => Promise<void>): Promise<void> {
  await retryOnLostBrowser(journey, async () => {
    resetSoftFailures(journey);
    await withWorldOnce(journey, carrier, body);
  });
}

async function withWorldOnce(journey: string, carrier: Carrier, body: (world: World) => Promise<void>): Promise<void> {
  const teardown = harnessTeardown();
  try {
    await withE2eEnvironment(async publisher => {
      await withE2eEnvironment(async member => {
        const directory = await startRelayDirectory();
        const rendezvous = carrier === 'relay' ? await startRendezvous(publisher.paths.root, teardown) : undefined;
        const sinkhole = carrier === 'relay' ? await startDirectSinkhole(teardown) : undefined;
        directory.publish(rendezvous?.relayUrl ?? null);
        const served = await startPwaOrigin(await buildPwaBundle(directory.origin), teardown);
        // A WebAuthn relying-party id must be a domain, so the app is opened at `localhost`, not 127.0.0.1.
        const origin: PwaOrigin = { ...served, origin: served.origin.replace('//127.0.0.1:', '//localhost:') };

        const publisherConfig = await writeDaemonConfig(join(publisher.paths.root, 'daemon.json'), {
          bindPort: publisher.ports.api,
          appOrigins: [origin.origin],
          ...(sinkhole === undefined ? {} : { publicUrl: sinkhole.origin }),
        });
        const memberConfig = await writeDaemonConfig(join(member.paths.root, 'daemon.json'), {
          bindPort: member.ports.api,
          appOrigins: [origin.origin],
          relay: false,
        });
        const publisherBoot = { configPath: publisherConfig, directoryOrigin: directory.origin };
        if (rendezvous !== undefined) {
          // First boot mints the identity and dials; the rendezvous refuses it until it is listed.
          const seen = await rendezvous.dialled();
          await bootDaemon(publisher, publisherBoot);
          const fingerprint = await waitForDaemonFingerprint(rendezvous, seen);
          await publisher.stopDaemon();
          await rendezvous.allow(fingerprint);
        }
        await bootDaemon(publisher, publisherBoot);
        if (rendezvous !== undefined) await waitForDaemonAtRendezvous(rendezvous);
        await bootDaemon(member, { configPath: memberConfig, directoryOrigin: directory.origin });

        const a: Machine = { environment: publisher, project: await realFolder(publisher, 'publisher-project') };
        const b: Machine = { environment: member, project: await realFolder(member, 'member-project') };
        await writeSkill(
          a.project,
          SKILL_TEAM,
          'Reviews a diff for the team',
          'Never touch secrets. Read the diff first.',
        );
        await writeSkill(a.project, SKILL_WORKSHOP, 'Keeps workshop notes', 'Write short notes. Never touch secrets.');
        await registerProject(a, 'Publisher project');
        await registerProject(b, 'Member project');
        const teamCatalog = await seedCatalog(a, 'Team skills', 'What the team uses', SKILL_TEAM);
        const workshopCatalog = await seedCatalog(a, 'Workshop', 'For the workshop', SKILL_WORKSHOP);

        const world: World = {
          journey,
          carrier,
          a,
          b,
          origin,
          teardown,
          teamCatalog,
          workshopCatalog,
          codes: [],
          people: [],
        };
        await recordStep({
          journey,
          step: 'world',
          status: 'PASS',
          evidence: `publisher ${publisher.httpUrl()}, member machine ${member.httpUrl()}, app ${origin.origin}, carrier ${carrier}`,
        });
        try {
          await body(world);
          for (const person of world.people) should(person.browser.pageErrors).be.empty();
          should(origin.missingAssets()).be.empty();
        } finally {
          // Before the fixture removes the roots: their tmux sockets and paths are how leftovers are found.
          await publisher.stopDaemon();
          await member.stopDaemon();
          await reapLeftovers(publisher, journey);
          await reapLeftovers(member, journey);
        }
      });
    });
  } finally {
    await teardown.closeAll();
  }
}

async function realFolder(environment: E2eEnvironment, name: string): Promise<string> {
  const path = join(environment.paths.root, 'work', name);
  await mkdir(path, { recursive: true });
  return await realpath(path);
}

// ─── a person's browser ──────────────────────────────────────────────────────────────────────

/** A new browser with a platform authenticator of its own; it has met no machine yet. */
async function newPerson(world: World, name: string): Promise<Person> {
  let browser = await launchProductBrowser(world.teardown);
  // A freshly launched Chrome that is already closed at its first navigation is relaunched once.
  const alive = await browser.page.goto(`${world.origin.origin}/`, { waitUntil: 'load', timeout: 15_000 }).then(
    () => true,
    () => false,
  );
  if (!alive) browser = await launchProductBrowser(world.teardown);
  const authenticator = await addVirtualAuthenticator(browser);
  const person: Person = { name, browser, page: browser.page, authenticator };
  world.people.push(person);
  return person;
}

const present = (selector: string): string => `document.querySelector(${quoted(selector)}) !== null`;

async function isPresent(page: ProductPage, selector: string): Promise<boolean> {
  return await page.evaluate<boolean>(present(selector));
}

/** Answer the step-up prompt when it is on screen — a first passkey, or an unlock — and wait for it to close. */
async function answerStepUp(page: ProductPage): Promise<boolean> {
  if (!(await isPresent(page, '[data-step-up-dialog] [data-step-up-confirm]'))) return false;
  await page.click('[data-step-up-dialog] [data-step-up-confirm]');
  await page.waitForSelector('[data-step-up-dialog]', { state: 'detached', timeout: 30_000 }).catch(async () => {
    throw new Error(`the step-up prompt did not close: ${String(await textNow(page, '[data-step-up-dialog]'))}`);
  });
  return true;
}

/** Wait for one of `selectors`, answering a step-up prompt on the way; answer the one that appeared. */
async function reachAny(
  person: Person,
  selectors: readonly string[],
  what: string,
  timeoutMs = 30_000,
): Promise<string> {
  const { page } = person;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) if (await isPresent(page, selector)) return selector;
    await answerStepUp(page);
    await Bun.sleep(200);
  }
  throw new Error(
    `${person.name} never saw ${what} (${selectors.join(' | ')}) at ${page.url()}. ` +
      `Alerts: ${String(await textNow(page, '[role="alert"]'))}. ` +
      `Rendered: ${(await renderedDataAttributes(page as never)).slice(0, 1_200)}. ` +
      `Errors: ${person.browser.pageErrors.join(' | ') || 'none'}`,
  );
}

async function reach(person: Person, selector: string, what: string, timeoutMs = 30_000): Promise<void> {
  await reachAny(person, [selector], what, timeoutMs);
}

async function reachSentence(person: Person, sentence: string, timeoutMs = 30_000): Promise<void> {
  try {
    await waitUntil(
      person.page,
      `(document.body.textContent ?? '').replace(/\\s+/g, ' ').includes(${quoted(sentence)})`,
      timeoutMs,
      `"${sentence.slice(0, 60)}…"`,
    );
  } catch (error) {
    throw new Error(
      `${(error as Error).message}. The page says: ${String(await textNow(person.page, 'main'))}. ` +
        `Rendered: ${(await renderedDataAttributes(person.page as never)).slice(0, 800)}`,
    );
  }
}

/** Open a link as a person does: a fresh page load, never a fragment change on the page already open. */
async function open(person: Person, url: string): Promise<void> {
  await person.page.goto('about:blank');
  await person.page.goto(url, { waitUntil: 'load', timeout: 30_000 });
}

/** Move to `path` inside the open document, as the app's own links do. */
async function inApp(person: Person, path: string): Promise<void> {
  await person.page.evaluate(
    `(() => { history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate')); })()`,
  );
}

/** Set a `<select>` the way a person's choice does, and let the app hear it. */
async function choose(person: Person, selector: string, value: string): Promise<void> {
  await reach(person, selector, `the ${selector} choice`);
  await waitUntil(
    person.page,
    `[...document.querySelector(${quoted(selector)}).options].some(o => o.value === ${quoted(value)})`,
    30_000,
    `the choice ${value} in ${selector}`,
  ).catch(async (error: unknown) => {
    const offered = await person.page.evaluate<string>(
      `JSON.stringify([...document.querySelector(${quoted(selector)}).options].map(o => o.value))`,
    );
    throw new Error(`${(error as Error).message}. Offered: ${offered}`);
  });
  await person.page.evaluate(`(() => {
    const select = document.querySelector(${quoted(selector)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${quoted(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

// ─── the member's journey, one screen at a time ──────────────────────────────────────────────

/**
 * §2.2: open the link, join, add the member passkey inside the window, unlock, and land on
 * "Shared with me" with the catalogs the link carried.
 */
async function joinWithLink(
  world: World,
  person: Person,
  minted: Minted,
  catalogIds: readonly string[],
): Promise<void> {
  const { journey } = world;
  await step(journey, `${person.name}:open-link`, async () => {
    await open(person, minted.link);
    await reach(person, '[data-join-facts]', 'the join facts');
    return { value: undefined, evidence: `facts: ${String(await textNow(person.page, '[data-join-facts]'))}` };
  });
  await step(journey, `${person.name}:join`, async () => {
    await person.page.click('[data-join-button]');
    await reach(person, '[data-passkey-step="add"]', 'the add-a-passkey step');
    await reach(person, '[data-passkey-countdown]', 'the passkey window countdown');
    return {
      value: undefined,
      evidence: `window: ${String(await textNow(person.page, '[data-passkey-countdown]'))}`,
    };
  });
  await step(journey, `${person.name}:add-passkey`, async () => {
    const before = await person.authenticator.credentials();
    await person.page.click('[data-passkey-step="add"]');
    await reach(person, '[data-passkey-step="unlock"]', 'the unlock step after the passkey');
    await reach(person, '[data-passkey-added]', 'the passkey-added line');
    const after = await person.authenticator.credentials();
    should(after).equal(before + 1);
    return { value: undefined, evidence: `the authenticator holds ${String(after)} credential(s)` };
  });
  await step(journey, `${person.name}:unlock-and-see-shared`, async () => {
    await person.page.click('[data-passkey-step="unlock"]');
    await reach(person, '[data-shared-page]', 'Shared with me');
    for (const id of catalogIds) await reach(person, `[data-shared-catalog="${id}"]`, `shared catalog ${id}`);
    return {
      value: undefined,
      evidence: `publisher ${minted.publisherId.slice(0, 12)} lists ${String(catalogIds.length)} catalog(s)`,
    };
  });
}

/** Open one shared skill's full review. */
async function reviewSkill(world: World, person: Person, catalogId: string, skill: string): Promise<void> {
  await step(world.journey, `${person.name}:review-${skill}`, async () => {
    await person.page.click(`[data-shared-catalog="${catalogId}"] [data-shared-item]`);
    await reach(person, '[data-catalog-sheet="shared-item"]', 'the shared item sheet');
    await reach(person, '[data-review-body]', 'the full review');
    await reach(person, '[data-review-file$="SKILL.md"]', 'the SKILL.md in the review');
    const text = String(await textNow(person.page, '[data-catalog-sheet="shared-item"]'));
    should(text).containEql(skill);
    return { value: undefined, evidence: `the review names ${skill} and shows its SKILL.md` };
  });
}

/** Join a member the whole way, and answer the id the owner holds for them. */
async function joinNewMember(
  world: World,
  person: Person,
  label: string,
  catalogs: readonly string[],
): Promise<Minted> {
  const minted = await mint(world, { kind: 'new', label }, catalogs);
  await joinWithLink(world, person, minted, catalogs);
  return minted;
}

/** Pair this browser to the member's own machine B, through the confirm screen an owner presses. */
async function pairToMemberMachine(world: World, person: Person): Promise<string> {
  return await step(world.journey, `${person.name}:pair-own-machine`, async () => {
    await ensureOperatorPassword(world.b.environment);
    const link = await mintPairingLink(world.b.environment, world.origin.origin);
    const settled = await confirmPairing(person.page, link.url);
    const pinned = /(?:^|;)fp=([^;]+)/u.exec(link.fragment)?.[1];
    if (pinned === undefined) throw new Error('the pairing link pins no machine');
    return { value: decodeURIComponent(pinned), evidence: `paired to the member's machine: ${settled}` };
  });
}

/**
 * Back to "Shared with me" in the same browser, unlocked with the member passkey.
 *
 * A fresh load by default. Given `viaMachine`, it moves inside the open document instead: to that
 * machine's Projects page, then to `/shared`. The install sheet offers the projects this document has already
 * read from the machine, only the machine's own pages read them, and a fresh `/shared` load has read none.
 */
async function backToShared(person: Person, world: World, publisherId: string, viaMachine?: string): Promise<void> {
  if (viaMachine === undefined) await open(person, `${world.origin.origin}/shared`);
  else {
    await inApp(person, `/d/${viaMachine}/projects`);
    await waitUntil(
      person.page,
      `(document.body.textContent ?? '').includes('Member project')`,
      30_000,
      "the member machine's registered project on its Projects page",
    );
    await inApp(person, '/shared');
  }
  const seen = await reachAny(
    person,
    ['[data-shared-catalog]', '[data-publisher-unlock]', '[data-shared-offline]'],
    'the shared list, a lock or an offline note',
  );
  if (seen === '[data-publisher-unlock]') {
    await person.page.click(`[data-shared-publisher="${publisherId}"] [data-publisher-unlock]`);
    await reach(person, '[data-shared-catalog]', 'the shared catalogs after the unlock');
  } else if (seen === '[data-shared-offline]') {
    throw new Error(
      `the publisher was offline for ${person.name}: ${String(await textNow(person.page, '[data-shared-offline]'))}`,
    );
  }
}

/** §2.3: open a link in a browser that already has a key, unlock if it asks, and press the one button. */
async function redeemWithKey(person: Person, link: string): Promise<void> {
  await open(person, link);
  const seen = await reachAny(person, ['[data-known-unlock]', '[data-known-redeem]'], 'the already-a-member screen');
  if (seen === '[data-known-unlock]') {
    await person.page.click('[data-known-unlock]');
    await reach(person, '[data-known-redeem]', 'the add button after the unlock');
  }
  await person.page.click('[data-known-redeem]');
}

// ─── the leak scan ───────────────────────────────────────────────────────────────────────────

async function filesUnder(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await walk(root);
  return found;
}

/**
 * Every place either machine could have kept a code: all state, logs and audit files under both roots,
 * both daemons' own output, and what the owner routes answer. Looked for twice — the codes this run
 * minted, and anything shaped like a code at all (a code that was never minted here is a leak too).
 */
async function codeLeaks(world: World): Promise<readonly string[]> {
  const leaks: string[] = [];
  const check = (where: string, text: string): void => {
    for (const code of world.codes) if (text.includes(code)) leaks.push(`${where} holds a minted code`);
    for (const match of text.match(SHARE_CODE) ?? [])
      leaks.push(`${where} holds something shaped like a code: ${match.slice(0, 12)}…`);
  };
  let scanned = 0;
  for (const machine of [world.a, world.b]) {
    for (const path of await filesUnder(machine.environment.paths.root)) {
      const info = await lstat(path).catch(() => undefined);
      if (info === undefined || !info.isFile() || info.size > SCAN_FILE_CAP) continue;
      const text = await readFile(path, 'latin1').catch(() => undefined);
      if (text === undefined) continue;
      scanned += 1;
      check(path, text);
    }
    const output = machine.environment.daemonOutput();
    check('daemon stdout', output.out);
    check('daemon stderr', output.err);
  }
  for (const path of ['/v1/catalog-shares', '/v1/catalog-members', '/v1/audit']) {
    check(`GET ${path}`, JSON.stringify(await owner(world.a, 'GET', path, undefined, [200])));
  }
  await recordStep({
    journey: world.journey,
    step: 'leak-scan',
    status: leaks.length === 0 ? 'PASS' : 'FAIL',
    evidence: `${String(scanned)} file(s) and 2 daemon outputs searched for ${String(world.codes.length)} code(s): ${leaks.length === 0 ? 'none found' : leaks.join('; ')}`,
  });
  return leaks;
}

async function expectNoLeak(world: World): Promise<void> {
  should(await codeLeaks(world)).be.empty();
}

// ─── the journeys ────────────────────────────────────────────────────────────────────────────

/** Journey 1: a new member joins, adds a passkey, unlocks and reads what was shared. */
async function joinJourney(world: World): Promise<void> {
  const alice = await newPerson(world, 'alice');
  const minted = await joinNewMember(world, alice, 'Alice', [world.teamCatalog]);
  await reviewSkill(world, alice, world.teamCatalog, SKILL_TEAM);
  await step(world.journey, 'owner-sees-alice', async () => {
    const members = await membersOf(world);
    const found = members.find(member => member.memberId === minted.memberId);
    should(found?.label).equal('Alice');
    should(found?.keys.length).equal(1);
    should(found?.keys[0]?.passkeys).equal(1);
    return { value: undefined, evidence: 'the owner lists Alice with one browser and one passkey' };
  });
  await expectNoLeak(world);
}

/** Journey 2: the same browser installs the shared skill into a project on its own machine. */
async function installJourney(world: World): Promise<void> {
  const alice = await newPerson(world, 'alice');
  const minted = await joinNewMember(world, alice, 'Alice', [world.teamCatalog]);
  const machineId = await pairToMemberMachine(world, alice);
  await backToShared(alice, world, minted.publisherId, machineId);
  await reviewSkill(world, alice, world.teamCatalog, SKILL_TEAM);

  await step(world.journey, 'alice:install-target', async () => {
    await reach(alice, '[data-shared-install-button]', 'the install button');
    await alice.page.click('[data-shared-install-button]');
    await reach(alice, '[data-catalog-sheet="install"]', 'the install sheet');
    await choose(alice, '[data-catalog-scope]', 'project');
    await choose(alice, '[data-catalog-project]', world.b.project);
    await choose(alice, '[data-catalog-harness]', 'claude');
    await alice.page.click('[data-catalog-preview]');
    await reach(alice, '[data-catalog-confirm]', 'the install confirm');
    return {
      value: undefined,
      evidence: `confirm: ${String(await textNow(alice.page, '[data-catalog-confirm]')).slice(0, 300)}`,
    };
  });
  await step(world.journey, 'alice:install-with-passkey', async () => {
    const before = await alice.authenticator.credentials();
    await alice.page.click('[data-catalog-install]');
    await reach(alice, '[data-catalog-installed]', 'the installed result', 60_000);
    const after = await alice.authenticator.credentials();
    return {
      value: undefined,
      evidence: `installed; authenticator credentials ${String(before)} -> ${String(after)}; ${String(await textNow(alice.page, '[data-catalog-destination]'))}`,
    };
  });
  await step(world.journey, 'member-machine-holds-the-skill', async () => {
    const written = join(world.b.project, '.claude', 'skills', SKILL_TEAM, 'SKILL.md');
    const text = await readFile(written, 'utf8');
    should(text).containEql('Never touch secrets');
    const listed = (await owner(world.b, 'GET', '/v1/catalog-installs', undefined, [200])) as {
      installs: { provenance: { publisher: string; catalogId: string; kind: string; name: string } }[];
    };
    const mine = listed.installs.filter(install => install.provenance.name === SKILL_TEAM);
    should(mine.length).equal(1);
    should(mine[0]?.provenance.publisher).equal(minted.publisherId);
    should(mine[0]?.provenance.catalogId).equal(world.teamCatalog);
    return {
      value: undefined,
      evidence: `${written} exists and the install names publisher ${minted.publisherId.slice(0, 12)}`,
    };
  });
  await expectNoLeak(world);
}

/** Journey 3: a second code redeems inside the member session, another member's code is refused, a spent one is refused. */
async function joinAgainJourney(world: World): Promise<void> {
  const alice = await newPerson(world, 'alice');
  const first = await joinNewMember(world, alice, 'Alice', [world.teamCatalog]);

  await step(world.journey, 'alice:redeems-a-second-code', async () => {
    const second = await mint(world, { kind: 'existing', memberId: first.memberId }, [world.workshopCatalog]);
    await redeemWithKey(alice, second.link);
    await reach(alice, '[data-known-result="added"]', 'the added result');
    await alice.page.click('[data-join-open-shared]');
    await reach(alice, `[data-shared-catalog="${world.workshopCatalog}"]`, 'the new Workshop catalog');
    await reach(alice, `[data-shared-catalog="${world.teamCatalog}"]`, 'the Team skills catalog still there');
    return { value: undefined, evidence: 'the second code added Workshop beside Team skills, with no new join' };
  });

  const bob = await newPerson(world, 'bob');
  const bobFirst = await joinNewMember(world, bob, 'Bob', [world.teamCatalog]);

  await step(world.journey, 'alice:is-refused-bobs-code', async () => {
    const forBob = await mint(world, { kind: 'existing', memberId: bobFirst.memberId }, [world.workshopCatalog]);
    await redeemWithKey(alice, forBob.link);
    await reachSentence(alice, REDEEM_OTHER_MEMBER);
    const seen = await eventually('the owner audit naming the cross-member use', async () => {
      const events = await auditEvents(world);
      const found = events.find(event => event.event === 'catalog.share.cross-member');
      if (found === undefined) throw new Error(`audit holds: ${events.map(event => event.event).join(', ')}`);
      return found;
    });
    should(seen.subject).equal(forBob.shareId);
    // Bob did not get Workshop from it: his code was spent by Alice's attempt, not by him.
    const bobs = (await membersOf(world)).find(member => member.memberId === bobFirst.memberId);
    should(bobs?.keys.length).equal(1);
    return {
      value: undefined,
      evidence: `Alice read the Q5 sentence; the owner audit holds catalog.share.cross-member for ${forBob.shareId}`,
    };
  });

  await step(world.journey, 'alice:is-refused-a-new-person-code', async () => {
    const forSomeoneNew = await mint(world, { kind: 'new', label: 'Carol' }, [world.workshopCatalog]);
    await redeemWithKey(alice, forSomeoneNew.link);
    await reachSentence(alice, REDEEM_NEW_MEMBER);
    return {
      value: undefined,
      evidence: 'a code made for a new person is refused to a browser that is already a member',
    };
  });

  await step(world.journey, 'the-first-link-is-spent', async () => {
    // With a key: the redeem is refused with the generic sentence.
    await redeemWithKey(alice, first.link);
    await reachSentence(alice, JOIN_REFUSED_SENTENCE);
    // Without one: a browser that never met this publisher sees the same sentence under a refusal title.
    const stranger = await newPerson(world, 'stranger');
    await open(stranger, first.link);
    await reach(stranger, '[data-join-button]', 'the join button');
    await stranger.page.click('[data-join-button]');
    await reachSentence(stranger, JOIN_REFUSED_SENTENCE);
    await reachSentence(stranger, 'This link was refused');
    should(await isPresent(stranger.page, '[data-passkey-step]')).equal(false);
    return {
      value: undefined,
      evidence: 'the spent first link is refused with the generic sentence, with and without a key',
    };
  });
  await expectNoLeak(world);
}

/** Journey 4: the owner revokes Alice; her view is refused and keeps its key; Bob, still valid, leaves. */
async function revokeJourney(world: World): Promise<void> {
  const alice = await newPerson(world, 'alice');
  const aliceMinted = await joinNewMember(world, alice, 'Alice', [world.teamCatalog]);
  const bob = await newPerson(world, 'bob');
  const bobMinted = await joinNewMember(world, bob, 'Bob', [world.teamCatalog]);

  await step(world.journey, 'owner-revokes-alice', async () => {
    const revoked = (await owner(
      world.a,
      'DELETE',
      `/v1/catalog-members/${aliceMinted.memberId}`,
      undefined,
      [200],
    )) as {
      keysRemoved: number;
    };
    should(revoked.keysRemoved).equal(1);
    return { value: undefined, evidence: `Alice's ${String(revoked.keysRemoved)} browser key removed` };
  });

  await step(world.journey, 'alice-is-refused-and-keeps-her-key', async () => {
    // Her open view works until it asks: the next request is the one that is turned away.
    const deadline = Date.now() + 45_000;
    let reloaded = false;
    while (Date.now() < deadline && !(await isPresent(alice.page, '[data-access-refused]'))) {
      if (await isPresent(alice.page, '[data-shared-item]'))
        await alice.page.click('[data-shared-item]').catch(() => undefined);
      else if (!reloaded) {
        reloaded = true;
        await backToShared(alice, world, aliceMinted.publisherId).catch(() => undefined);
      }
      await answerStepUp(alice.page);
      await Bun.sleep(300);
    }
    await reach(alice, '[data-access-refused]', 'the Access refused card', 5_000);
    should(String(await textNow(alice.page, '[data-access-refused]'))).containEql('Access refused');
    // The key is kept: a reload still shows the refusal, and nothing deleted itself.
    await open(alice, `${world.origin.origin}/shared`);
    const seen = await reachAny(
      alice,
      ['[data-access-refused]', '[data-publisher-unlock]'],
      'the refused card or a lock after reload',
    );
    if (seen === '[data-publisher-unlock]') {
      await alice.page.click(`[data-shared-publisher="${aliceMinted.publisherId}"] [data-publisher-unlock]`);
    }
    await reach(alice, '[data-access-refused]', 'the Access refused card after a reload');
    should(await isPresent(alice.page, '[data-shared-empty]')).equal(false);
    return {
      value: undefined,
      evidence: 'Access refused shows after her next request and again after a reload; her key is still here',
    };
  });

  await step(world.journey, 'bob-leaves-and-forgets-his-key', async () => {
    await backToShared(bob, world, bobMinted.publisherId);
    await bob.page.click('[data-publisher-leave]');
    await bob.page.click('[data-publisher-leave-yes]');
    await reach(bob, '[data-shared-left]', 'the left note', 30_000);
    await reachSentence(bob, LEFT_SENTENCE);
    const left = await eventually('the owner holding no browser of Bob', async () => {
      const found = (await membersOf(world)).find(member => member.memberId === bobMinted.memberId);
      if (found !== undefined && found.keys.length !== 0)
        throw new Error(`Bob still has ${String(found.keys.length)} key(s)`);
      return found;
    });
    await open(bob, `${world.origin.origin}/shared`);
    await reach(bob, '[data-shared-empty]', 'the empty list: the key is forgotten');
    return {
      value: undefined,
      evidence: `Bob left (${left === undefined ? 'the owner dropped him' : 'no browser left'}); this browser forgot its key`,
    };
  });
  await expectNoLeak(world);
}

/** Journey 5: after a whole life of codes — used, spent, ended and never opened — none is anywhere on disk. */
async function leakJourney(world: World): Promise<void> {
  const alice = await newPerson(world, 'alice');
  const first = await joinNewMember(world, alice, 'Alice', [world.teamCatalog]);
  const second = await mint(world, { kind: 'existing', memberId: first.memberId }, [world.workshopCatalog]);
  await redeemWithKey(alice, second.link);
  await reach(alice, '[data-known-result="added"]', 'the added result');

  // A code the owner ended before anyone opened it, and one nobody ever opened.
  const ended = await mint(world, { kind: 'existing', memberId: first.memberId }, [world.teamCatalog]);
  await owner(world.a, 'DELETE', `/v1/catalog-shares/${ended.shareId}`, undefined, [200, 204]);
  await mint(world, { kind: 'new', label: 'Dana' }, [world.teamCatalog]);

  // A spent code opened again, which the publisher refuses by looking at the hash.
  const stranger = await newPerson(world, 'stranger');
  await open(stranger, first.link);
  await reach(stranger, '[data-join-button]', 'the join button');
  await stranger.page.click('[data-join-button]');
  await reachSentence(stranger, JOIN_REFUSED_SENTENCE);

  should(world.codes.length).equal(4);
  await expectNoLeak(world);
}

// ─── the tier ────────────────────────────────────────────────────────────────────────────────

describe('catalog members: join, passkey and install end to end in Chromium', () => {
  it('should let a new member join over the direct carrier, add a passkey, unlock and review a shared skill', async () => {
    await withWorld('members-join-direct', 'direct', joinJourney);
  });

  it('should let a new member join through the relay, add a passkey, unlock and review a shared skill', async () => {
    await withWorld('members-join-relay', 'relay', joinJourney);
  });

  it('should install a shared skill into a project on the own machine of the member with a passkey', async () => {
    await withWorld('members-install-direct', 'direct', installJourney);
  });

  it('should install a shared skill into the own machine of the member while the publisher is reached through the relay', async () => {
    await withWorld('members-install-relay', 'relay', installJourney);
  });

  it('should redeem a second code inside the member session and refuse the code of another member and a spent code', async () => {
    await withWorld('members-join-again', 'direct', joinAgainJourney);
  });

  it('should refuse a revoked member with their key kept and let a still-valid browser leave and forget its key', async () => {
    await withWorld('members-revoke', 'direct', revokeJourney);
  });

  it('should never leave a share code in any log, audit or state file on either machine', async () => {
    await withWorld('members-code-never-leaks', 'direct', leakJourney);
  });
});
