# Catalogs, made simple: the Sharing page, skill rows, versions and links

Status: **Approved 2026-11-01, all ten recommendations (§11).** Built in slices 3a–3f (§10); a slice is
done when its row there says so. What exists today is [../catalogs.md](../catalogs.md), which wins where the
two differ. The catalogs design this extends is [catalogs.md](catalogs.md). Card: &F240.

## In one screen

- **Sharing gets its own place:**
  - **Phone:** under **More**.
  - **Desktop:** in the top bar's row of places, and in the sidebar footer next to Settings.
  - It has four tabs: _My catalogs_, _Shared with me_, _People_, _Skills_.
- **Every skill row gets buttons on the side**: **Share**, **Add**, and `⋯` for the rest.
- **Share one skill as a link, two kinds:**
  - **One-time install:** the first person to open it installs it, then it stops working.
  - **Public link:** anyone with the link can install it, until you turn it off or it expires.

  Neither link exposes your machine or any other skill.

- **Share with a person (membership):** that person gets updates later, as today.
- **Versions are visible everywhere:**
  - _Publish update_ makes a new version, and you see what changed first.
  - Installs stay pinned to a version.
  - The person who installed it chooses when to move up, down, or stay.
- **A default catalog** makes Add one tap.
- **One data structure covers both the simple and the structured case.** Each skill is stored once with its versions,
  and catalogs and links point at it.
- **Today's protections stay:** signing, review before install, and your passkey on every share.

---

## 1. What is wrong today (measured)

| Task                                                 | Today                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Reach Catalogs                                       | Settings › machine › **Machine** tab › Catalogs: 4 taps (5 on a phone). Not in the palette.       |
| Share one skill with a new person                    | about **17–19 taps**, 2 typed names, 1 passkey. The add sheet has no Share button.                |
| Share a skill as just a file/link                    | impossible: a share always makes the person a member of a catalog                                 |
| Add a 2nd skill                                      | 8–9 taps                                                                                          |
| Give someone you already share with one more catalog | a NEW link, which they must open                                                                  |
| See who can see a catalog                            | only in a machine-wide "People and codes" list                                                    |
| "Shared with me"                                     | only from the connection picker or the setup guide                                                |
| Versions                                             | "Publish update" exists, but there is no version list, no "what changed", and no way to roll back |

---

## 2. Where Sharing goes, exactly

**Phone**

- Bottom bar today: _Sessions · Inbox · Board · Find · More_. It stays as it is: five slots is the comfortable most.
- **Sharing goes in the More sheet, right after Projects**: _Projects · Sharing · Insights · Settings_.
- It is also reachable from:
  - the palette (Find): "Sharing", "Shared with me", "Share a skill…";
  - every skill row's **Share** button, which opens the share sheet in place, so you don't need the page at all.

**Desktop**

- **Top bar, row of places:** _Sessions · Inbox · Board · Projects · **Sharing** · Analytics · Warden · Learning ·
  Settings_.
- **Sidebar footer:** today _Projects · Insights · Settings_; it becomes _Projects · **Sharing** · Insights · Settings_.
- **The narrow icon rail:** a Share icon next to the Settings gear.
- **Palette:** the same three entries as on the phone.

**Both**

- Settings › Machine › Catalogs stays, as a one-line link to the Sharing page.
- When someone shares with you, a dot appears on Sharing.

```
 Sharing                                      [ kirin-box ▾ ]   ← the app's own machine selection, not a second switcher
 ┌──────────────┬────────────────┬──────────┬──────────┐
 │ My catalogs  │ Shared with me │ People   │ Skills   │
 └──────────────┴────────────────┴──────────┴──────────┘
 Kirin's skills · default        12 items · 3 people          [ Share ] [ ⋯ ]
 Writing kit                      4 items · 1 person           [ Share ] [ ⋯ ]
 Links
   pdf-tools   public link · v3 · 41 installs · expires in 6 d [ Copy ] [ ⋯ ]
   acme-mcp    one-time link · v1 · unused · expires in 52 m  [ Copy ] [ ⋯ ]
 [ + New catalog ]   [ Add from a link ]
```

**One page for all your machines.** Catalogs belong to one machine, because that is where they are signed. The page
shows the machine you are on and follows the app's existing machine selection; it adds no switcher of its own.

---

## 3. Skill rows: buttons on the side

```
 /pdf-tools   User   v3                          [ ↗ Share ] [ ＋ Add ] [ ⋯ ]
 Split, merge and OCR PDFs
 /acme        Project   v2 · from Ines · update to v3           [ ↗ Share ] [ ⋯ ]
```

- **A compact row:** name, scope chip, the **version** (once shared), and a one-line description.
- **Share** and **Add** are always visible: labelled icon buttons, 44 px tall on a phone, no hover needed.
- **The `⋯` menu holds:**
  - Open SKILL.md
  - Add to another catalog…
  - Versions…
  - Stop sharing
  - Remove (only for skills installed from someone)
- **Rows appear in two places:** the context rail (Skills and MCP), and the new **Skills** tab in Sharing. The tab lets
  you share without opening a session; it mounts the existing `skills-surface.tsx` over the machine's own skills (`GET /v1/skills`).

---

## 4. Ways to share one skill

Tapping **Share** on a row opens one sheet with three choices. The first is preselected.

```
 Share pdf-tools (v3)
 (•) One-time install link     the first person who opens it installs it; then it stops
 ( ) Public link               anyone with the link installs it, until you turn it off
 ( ) A person                  they join, see it in Shared with me, and get updates
 Expires in   [ 1 hour ▾ ]     (public: 1 day · 7 days · 30 days · no expiry)
 [ Make link ]                 → your passkey → link + QR, Copy
```

|                   | One-time install link               | Public link                                           | A person (member)                        |
| ----------------- | ----------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| Who can use it    | the first to open it                | anyone holding the link                               | that person, on their browsers           |
| How many installs | 1                                   | unlimited (optional cap)                              | theirs                                   |
| Recipient needs   | the app + their own machine         | the same                                              | the app, a member passkey, their machine |
| Updates later     | no: they get a copy of that version | yes: the link always serves the version you set it to | yes: "Update to v4"                      |
| Can you stop it   | yes, until it is used               | yes, at any time (new installs stop)                  | yes: revoke                              |
| Shows a counter   | used / unused                       | installs so far                                       | their browsers                           |
| Expiry            | 15 min – 1 day                      | 1 / 7 / 30 days or none                               | the link: 15 min – 1 day                 |

**On the recipient's side, both links work the same way:**

1. Open the link in the app.
2. See _who signed it_, the skill, its version and the full review (hidden characters marked, warnings).
3. Pick a machine and a place.
4. Confirm with your own passkey.
5. Installed, pinned to that version.

**No membership and no member passkey are needed.**

---

## 5. Public and one-time links: how they work, and the threat model

### 5.1 How they work

1. You tap **Make link**. Your machine builds a **link bundle**, which is exactly ONE item at ONE version:
   - the files of that version;
   - a small manifest naming the item, its version and its digest;
   - all of it **signed with the machine's key** under a new label, `ferretry-catalog-link-v1`, so it can never be
     confused with a catalog manifest.
2. It encrypts the bundle with a fresh random key and uploads the ciphertext to Ferretry's hosted link store. This
   runs on the same Cloudflare account as the hosted relay. Uploads are signed by your machine and limited per
   machine.
3. The link is `https://<app>/get#v1;b=<bundle id>;k=<key>;fp=<your machine's fingerprint>`.
   - Everything after `#` stays in the browser: it is never sent to any server.
   - So the store holds an unreadable blob and never learns the key.
4. The recipient's app downloads the blob, decrypts it with `k`, and checks the signature against `fp`. Then it
   shows the review, and installs through the recipient's own machine with their passkey, exactly like a catalog
   install today.

- **One-time:** the store hands out the blob once (an atomic "fetch and delete"), so two people racing get one
  success and one "This link was already used".
- **Public:** the store serves it until you turn it off or it expires, and counts downloads.
- **Updating a public link:** you choose _Move this link to v4_. Your machine uploads a new bundle under the same
  link id. The link always says which version and date it serves.

**Why a hosted store and not your machine?**

- Your machine is never contacted by link users, so it is never exposed to anyone with the link.
- The link works while your machine is off.

The alternative is decision D8.

### 5.2 Threat model

**What we protect**

- your machine;
- your other skills and catalogs;
- the shared skill's integrity;
- the recipient's machine;
- your privacy.

**Who might attack**

- anyone the link reaches: it may be forwarded, pasted in a public channel, or indexed;
- the link store's operator;
- the network;
- someone who tampers with a link;
- a malicious publisher (from the recipient's side).

| #   | Threat                                           | What stops it                                                                                                                                                                                                                                    | What is left                                                                                                                                                                                                           |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The link spreads further than you meant          | That is what a public link is: **treat it as public**. The sheet says "Anyone with this link can install it." You can turn it off, set an expiry and an install cap, and watch the counter.                                                      | Copies already installed stay installed. Turning off stops new installs, never existing ones. The sheet says so.                                                                                                       |
| 2   | A link user reaches your machine                 | The link holds no machine address, and the bundle is fetched from the store. **There is no route on your machine for link users.**                                                                                                               | None.                                                                                                                                                                                                                  |
| 3   | A link reveals other skills                      | The bundle holds exactly one item. Bundle ids are 128-bit random and unrelated to each other. The store has no listing, and one key opens one bundle.                                                                                            | None.                                                                                                                                                                                                                  |
| 4   | The store or the network changes the skill       | Every bundle is signed by your machine's key, and the recipient checks it against `fp` in the link before showing anything. The store cannot read the bundle (it lacks `k`) and cannot forge it (it lacks your key).                             | The store could withhold a bundle, or serve an _older_ signed version of the same link. The app always shows the signed version and date, and refuses a version older than one this browser already saw for that link. |
| 5   | The key leaks through logs or Referer            | The key is in the `#` part, which browsers never send. `/get` gets `no-store` and `Referrer-Policy: no-referrer` (as `/join` does today). The daemon never logs links.                                                                           | Whoever sees the full link has the key. That is the point of a link.                                                                                                                                                   |
| 6   | The link identifies your machine                 | The link carries your machine's fingerprint, so anyone holding two of your links can tell they come from the same machine.                                                                                                                       | Decision D9: keep it (recommended: recipients see it is you, and trust carries over), or sign each link with its own key and lose that.                                                                                |
| 7   | A malicious skill harms the recipient            | The same review as catalog installs (hidden characters marked, warnings, the file and size limits) and the recipient's own passkey before anything is written. Nothing auto-updates.                                                             | Same as catalogs today: the recipient decides.                                                                                                                                                                         |
| 8   | Secrets leak inside the bundle                   | Today's add rules apply: secret bindings are placeholders, never values, and the review lists every file.                                                                                                                                        | You can still choose to share a file containing a secret. The review flags secret-looking content (new check).                                                                                                         |
| 9   | Someone abuses the store as free hosting         | Only a paired daemon can upload, with signed requests. Per-machine quota (e.g. 50 links, 2 MiB each, matching the skill cap). Expiry. Rate limits per link and per IP.                                                                           | The operator can see sizes, download counts and IPs, but never contents.                                                                                                                                               |
| 10  | A one-time link is raced or replayed             | Fetch-and-delete is atomic in the store (one Durable Object per link). A replay gets the generic "already used".                                                                                                                                 | None.                                                                                                                                                                                                                  |
| 11  | A turned-off link keeps working                  | Turning it off deletes the blob first, then marks the link ended. The store answers 410 with the same sentence as "expired".                                                                                                                     | A browser that already downloaded it can still install that copy.                                                                                                                                                      |
| 12  | Unlike share codes, the link must be shown again | A public link has to be copyable later, so the machine keeps `k` in its secret store, encrypted at rest. It is never in an API answer except the owner's own "Copy link" (behind the device unlock). One-time links are shown once and not kept. | A stolen machine state holds your public links. They are public anyway.                                                                                                                                                |

**What a link never does**

- give membership;
- let anyone read your catalogs;
- reach your machine;
- update an install by itself.

---

## 6. Versions, made explicit

**For the owner (each shared item)**

- **Versions…** in the `⋯` menu, and on the item's page in Sharing. It shows:
  - `v3 · current · 2 days ago · 4 files · 12 KB` and so on;
  - who and what uses each version: catalogs, links, how many installs (members' installs are known, link installs
    are counted).
- **Publish update:**
  - **Before:** the row shows _Source changed_ when the file on disk is not the current version.
  - **First:** tap Publish update to see **What changed**: files added, removed and changed, with a line diff and
    new commands highlighted.
  - **Then:** confirm, and it becomes v4. Catalogs that hold the item list v4; each link stays on the version it
    serves until you move it.
- **Roll back:** _Make v2 current_. It moves the catalogs back to v2 as a new signed revision; nothing is deleted.
  Members on v3 see "The publisher moved back to v2".
- **Retire a version:** stop offering it to new installs; existing installs keep working.

**For the person who installed it**

- Each install shows its pin: `pdf-tools · v2 · from Kirin`.
- **When a newer version exists:**
  - you see _Update to v3_;
  - tap _See changes_ to get the diff computed by your own machine against the bytes it really has (design §2.6);
  - then **Update**, **Stay on v2** (stop asking for v3) or **Skip this version**.
- **Move to version…:** go to any version the publisher still offers, including back down. The design already
  allows older versions only when you ask.
- **If you edited your copy locally:** the update offers "keep my edits" or "replace".
- **Never automatic.**
- **Link installs:** they are pinned like the rest. A public link's newer version shows up when you open the link
  again; there is no background check.

---

## 7. The data structure

```
SharedItem    one skill or MCP server this machine shares, stored ONCE
              { itemId, kind, name, summary, source, versions[{ version, digest, size, publishedAt, retired? }],
                current, sourceState }

Catalog       a named, signed list of items, given to people
              { catalogId, name, description, role: 'default' | 'collection', itemIds[], withdrawn[], revision }

Link          one item, one version, as a link; no person involved
              { linkId, itemId, version, kind: 'one-time' | 'public', expiresAt?, installCap?, installs,
                state: 'live' | 'used' | 'expired' | 'ended', bundleId, keyRef? }

Member        a person, and the catalogs they can read                      (unchanged)
Share         an invitation link for a person to one or more catalogs     (unchanged; already 1–64 catalogs)
```

- **The simple case:**
  - _Share this skill_ creates a `Link` for one-time or public, or invites a person to a catalog.
  - _Add_ puts the item in the `default` catalog.
  - You never name anything.
- **The structured case:** named `collection` catalogs, members, and multi-catalog shares, as today.
- **One item, many places:** an item can sit in several catalogs and links, and its versions are kept once. So:
  - an update is published once;
  - a member who sees it twice sees it once;
  - install pins (`itemId` + version + digest) stay valid.
- **No hidden single catalogs.** The owner wants "just the file, with a link", so a Link is its own small record
  and not a fake catalog. **Membership stays catalog-based.**
- **Members are unchanged.** They still read one signed manifest per catalog. Links use their own signed bundle and
  their own label.
- **Default catalog:**
  - made on the first Add, named "‹you›'s skills", renamable;
  - any catalog can be made the default;
  - one per machine.
- **Limits:**
  - kept: 200 live items per catalog, 128 members;
  - new: 256 catalogs per machine (none today);
  - new: 50 live links per machine;
  - new: each bundle within the skill cap (2 MiB).
- **Migration:**
  - existing items move 1:1 into the item table, with no merging;
  - existing catalogs become `collection`;
  - no default exists until the first Add.

---

## 8. The flows, tap by tap

| Task                                | Today                     | Proposed                                                                  |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| Share one skill as a one-time link  | impossible                | **Share › Make link › passkey › Copy: 3 taps**                            |
| Share one skill as a public link    | impossible                | **Share › Public › Make link › passkey › Copy: 4 taps**                   |
| Share one skill with a person       | 17–19 taps, 2 names       | **Share › A person › name › Make link › passkey › Copy: 4 taps + 1 name** |
| Add a skill to your default catalog | 8–9 taps                  | **Add: 1 tap** (any warning opens the review)                             |
| More access for someone already in  | a new link they must open | **Give access › passkey: 2 taps, no link**                                |
| Publish an update                   | Settings path, no diff    | **row ⋯ › Publish update › see changes › confirm**                        |
| Reach Sharing                       | 4–5 taps through Settings | **1 tap** (desktop) or **More › Sharing** (phone)                         |

---

## 9. Unchanged, or needs a review

**Unchanged:**

- catalog manifest signing and verification order;
- member sessions, share codes (single use, hashed, `#fragment`);
- the `share-catalog` passkey;
- the installer's `catalog-install` passkey and review;
- ferrets refused on every owner route.

**New, so each gets the independent security review:**

- one-tap Add (D1);
- Give access (D4);
- the item table migration;
- **links**: the bundle format and label, the hosted link store, its upload authentication, its quotas, and the
  one-time fetch-and-delete.

Links need the relay owner's review too, because they add a hosted service next to the relay.

## 10. Build plan (small slices; each PR gets phone + desktop, light + dark shots and a review)

| Slice  | What                                                                                             | Risk                                              |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **3a** | The Sharing page (More / top bar / sidebar footer / rail / palette), 4 tabs, the Settings link   | app only. **Built.**                              |
| **3b** | Compact skill/MCP rows with Share / Add / ⋯ and the version chip; the Skills tab                 | app only                                          |
| **3c** | Item table, default catalog, one-tap Add, store migration                                        | owner API + store; security review                |
| **3d** | Versions: list, What changed, roll back, retire; the installer's Update / Stay / Move to version | owner + installer API; security review            |
| **3e** | Share sheet: a person, multi-catalog, Give access                                                | owner API; security review                        |
| **3f** | Links: bundle, hosted link store, one-time + public, counter, expiry, turn off                   | new hosted service; relay-owner + security review |

- **3a and 3b** fix "buried" and "too many clicks to reach" with no risk.
- **3f** is the largest: it is new infrastructure.
- The old phase 3 (offline library) becomes phase 4.

---

## 11. Decisions (all approved as recommended)

1. **D1: one-tap Add.** Freeze right away (with Undo) when the review finds nothing to warn about. _Recommend: yes._
2. **D2: default catalog.** One per machine, made on the first Add, renamable. _Recommend: yes._
3. **D3: placement.** Phone: in More, after Projects (the bottom bar stays at 5 slots). Desktop: the top bar's row of
   places, the sidebar footer and the rail. _Recommend: yes._ The alternative, Sharing in the phone's bottom
   bar in place of Board, was not chosen.
4. **D4: Give access without a link** to someone already in, guarded by your passkey. _Recommend: yes._
5. **D5: store each item once with its versions**, and make versions explicit as in §6. _Recommend: yes._
6. **D6: the page's name.** "Sharing", "Catalogs" or "Library"? _Recommend: "Sharing"._
7. **D7: both link kinds.** One-time install and public. _Recommend: both, behind one Share sheet._ One-time is the
   default: it is safer.
8. **D8: where links are served from.**
   - **(a) Hosted link store, encrypted. Recommended:** it never exposes your machine, and links work while it is off.
   - **(b) Your own machine, through the relay:** no new service, but link users reach your machine and it must be on.
9. **D9: links carry your machine's fingerprint.** _Recommend: yes._ Recipients see it is from you, and updates are
   trusted. The cost is that your public links can be tied to one another.
10. **D10: public link defaults.** Expiry 7 days (options 1 / 7 / 30 days or none), no install cap unless you set one.
    _Recommend: yes._
