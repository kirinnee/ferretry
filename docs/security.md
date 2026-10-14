# How Ferretry keeps your machines safe

This page explains Ferretry's security model in plain words: what protects you, what each layer
stops, what to do when something goes wrong, and what is **not** protected.

**Status labels.** Most of this is on `main`. A few parts are still in open pull requests. Those are
marked **(landing in #464)** (passkeys and least privilege) or **(landing in #461)** (audit log and
alerts). Items marked **(planned)** are designed but not built yet.

The detailed contracts live elsewhere. This page links to them and does not replace them:
[zero-trust design](design/zero-trust.md) · [pairing](pairing.md) · [grants](grants.md) ·
[relay protocol](relay-protocol.md) · [signed releases](pwa-release-signing.md) ·
[secrets](secrets.md) · audit log (`docs/audit.md`, landing in #461).

## The short version

- **Your phone holds a key that can't be copied.** No password or token is stored or sent anywhere.
- **Every connection is encrypted end to end**, between the app and your machine. The relay in the
  middle can't read it.
- **Dangerous actions need Face ID, Touch ID or a PIN** on the device you are using (landing in #464).
- **A new device can only read and chat** until you give it more (landing in #464).
- **Each machine is separate.** A hacked machine can't sign in to your other machines.
- **The real weak spots** are a hacked computer, code running inside the open app, and a hacked
  web deploy the first time you open the app. They are listed honestly [below](#what-this-does-not-protect).

## Words used on this page

| Word               | Meaning                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **machine**        | A computer running the Ferretry daemon (`fyd`). It runs your agents.                                     |
| **daemon**         | The Ferretry background program on a machine.                                                            |
| **app**            | The Ferretry web app (PWA) in your browser or on your home screen.                                       |
| **device**         | One browser or phone that is paired with a machine.                                                      |
| **relay**          | A server that passes encrypted traffic between your phone and a machine that has no public address.      |
| **carrier**        | How the app reaches a machine: **direct** (straight to it) or **relay**.                                 |
| **passkey**        | A login key kept by your phone's or computer's password manager, unlocked with your face, finger or PIN. |
| **step-up**        | Confirming with your passkey before a dangerous action.                                                  |
| **at the machine** | Using the `fy` command on the machine itself (landing in #464: only this counts).                        |

## The layers

Each row is one protection. Read across to see what it stops.

| Layer                                              | What it is                                                                                                                                                                                                                 | What it stops                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Device key**                                     | When you pair, the app makes a key the browser **won't let anyone export**. The machine keeps only the public half. One key per machine.                                                                                   | A copied browser profile, backup or stolen storage can't sign in. A key never works on a different machine.  |
| **Mutual handshake**                               | Every connection, direct or relayed, starts with both sides proving who they are. The machine proves it matches the fingerprint in the pairing QR code. Your device proves it holds its key.                               | Someone pretending to be your machine. A captured message can't be replayed in another connection.           |
| **Encrypted channel**                              | After the handshake, everything is encrypted between the app and the machine.                                                                                                                                              | The relay, Cloudflare, or anyone on your Wi-Fi reading or changing your traffic.                             |
| **Access lease + silent renewal**                  | A connection's permission lasts **15 minutes**. The device renews it quietly by signing a fresh challenge.                                                                                                                 | A connection living on after you revoke the device. Each renewal re-checks that the device is still allowed. |
| **12-hour cap**                                    | No single connection lasts longer than **12 hours**. Then it opens a new one with a fresh proof.                                                                                                                           | One long-lived connection that never proves itself again.                                                    |
| **Idle expiry**                                    | A device that **nobody used for 30 days** is removed and must pair again. "Used" means a real person touched it. An open tab doesn't count.                                                                                | A forgotten laptop or old phone keeping access forever.                                                      |
| **Instant revoke**                                 | Removing a device closes every connection it has, at once.                                                                                                                                                                 | A lost device staying connected.                                                                             |
| **Pairing code**                                   | `fy pair` shows a QR code that lasts **2 minutes** and works **once**. It is only sent after the machine has proved itself.                                                                                                | Guessing or reusing a code. Sending a code to the wrong machine.                                             |
| **Passkey step-up** (landing in #464)              | Dangerous actions need a passkey confirmation. One confirmation covers **15 minutes**, in this open copy of the app. Closing the page ends it. The **machine** checks the passkey, not the app.                            | A thief with your unlocked phone opening a terminal, using a secret, or changing settings.                   |
| **Least privilege per device** (landing in #464)   | A new device gets **read and chat only**. Terminal, files, browser, secrets and settings start switched off. You turn them on at the machine (`fy device grant`), or from a device that already has them.                  | A newly paired device, or a stranger's device, doing anything dangerous by default.                          |
| **"At the machine" = only `fy`** (landing in #464) | Only the `fy` command on the machine itself skips the rules. It proves itself with a token file that only someone on the machine can read. A browser on the machine is treated like any other device.                      | A tunnel or proxy to the machine (`ssh -L`, `cloudflared`, `tailscale serve`) being mistaken for you.        |
| **Audit log + alerts** (landing in #461)           | The machine keeps a log of pairings, removals, settings changes, terminals and secrets used. It records names and ids, never codes, keys or secret values. When a device is paired, your other devices get a notification. | A new device sneaking in unnoticed. Not knowing what happened after the fact.                                |
| **Signed app releases**                            | Every app release is signed. The installed app checks the signature before it updates.                                                                                                                                     | A hacked web deploy silently replacing an app you already installed.                                         |
| **Relay sees nothing inside**                      | The relay only passes sealed messages. It sees addresses, timing and sizes — not content.                                                                                                                                  | The relay operator reading chats, keystrokes, codes or keys.                                                 |
| **Secrets are used, never read**                   | An agent names a secret. Ferretry runs a command with the value in that command only. No screen or API ever shows the value.                                                                                               | An agent or a device ever holding your credentials. See [secrets](secrets.md) for its limits.                |

### Which actions need a passkey (landing in #464)

From any device, a passkey step-up is needed to:

- open or type into a **terminal**
- **write files** or register a project
- **use, add or delete a secret**
- **change the fleet** (apply a change, sign in an account, setup, clone)
- **change permissions** (grants), for the machine or for a device
- **pair a new device** or **remove a device**
- control the **browser**, or change the **warden** (the supervising agent)

Reading the fleet, chatting with sessions, and your own tasks, pins and attention items do **not**
need a step-up.

**Today on `main`**, before #464 lands, permissions are machine-wide only, a browser on the
machine counts as "at the machine", and an optional operator password guards changes. #464 removes
the password and replaces it with passkeys.

## Threats, and what happens

| If…                                                                                     | What the attacker can do                                                                                                                          | What they can't do                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Your phone is stolen, and it's locked**                                               | Nothing.                                                                                                                                          | Use the app's key — it only works in the unlocked browser.                                                                                                                             |
| **Your phone is stolen, unlocked, app open**                                            | Read and chat on your machines, as long as that device is allowed to. **Chatting with an agent that has tools can run commands** on that machine. | Open a terminal, use a secret or change settings without your face/finger/PIN (landing in #464). Add their own passkey after the first 10 minutes (landing in #464). Outlast a revoke. |
| **Someone copies your browser storage or a backup**                                     | Nothing.                                                                                                                                          | Sign in. The device key can't be exported, so a copy is useless.                                                                                                                       |
| **The relay or Cloudflare is hacked**                                                   | See when you connect, from which IP, for how long, and message sizes and timing (keystroke rhythm on a terminal). Drop or delay traffic.          | Read or change anything you send. Pretend to be your machine. Learn your device id, codes or keys.                                                                                     |
| **The app's web deploy is poisoned**                                                    | If you have **never installed** the app, or the deploy ships a **new service worker**, run its own code in the app (see below).                   | Silently replace an app you already installed with different files: the signed release check refuses it.                                                                               |
| **A malicious website**                                                                 | Nothing special. It is a different site.                                                                                                          | Read the app's keys or storage. Embed the app (it refuses to be framed). Use your passkey (passkeys are tied to the app's address).                                                    |
| **A local tunnel or proxy to the machine** (`ssh -L`, `cloudflared`, `tailscale serve`) | Reach the machine as an ordinary **device**: it must pair and is limited like any device (landing in #464).                                       | Count as "at the machine". Only the `fy` token file does that (landing in #464). **Before #464**, it arrives as a local browser, which the operator password unlocks.                  |
| **One of your machines is hacked**                                                      | See [below](#if-one-machine-is-hacked).                                                                                                           | See below.                                                                                                                                                                             |
| **You lose your passkey** (landing in #464)                                             | Nothing — this is a lockout, not an attack. Reading and chatting still work.                                                                      | —                                                                                                                                                                                      |

### If one machine is hacked

Say machine **A** is taken over, and you also use machines **B** and **C** from the same phone.

**A hacked machine CAN:**

- Do anything on **itself**: read its sessions, run commands, read its own secrets.
- See whatever **you send to it**: chats, files, and any setup you clone **into** it.
- **Lie to you** about its own content: fake transcripts, fake names, fake messages.
- **Plant commands on B if you clone from A to B.** Clone copies hooks, MCP servers and settings,
  which run on B. Today the preview shows only counts, so you can't see the commands. **Don't clone
  from a machine you don't trust.** (A fix is proposed.)
- **Fake notifications**, in one case: all your machines share one notification subscription on the
  phone, and only the first machine you turned notifications on for can send to it. If that is A, it
  can show any text, including a fake "new device paired with B", and B's real alerts don't arrive.
  (A fix is proposed.)

**A hacked machine CANNOT:**

- **Sign in to B or C as your phone.** Each machine has its own device key on your phone, and every
  proof is tied to one connection with one machine.
- **Use your passkey on B or C.** B's passkey challenge only travels inside your encrypted connection
  with B, and B only accepts it from your B device key.
- **Copy any key off your phone.** Keys can't be exported.
- **Change your phone's record or key for B.** Each is stored under B's own fingerprint, which A
  can't fake.
- **Read your B or C traffic on the relay.** It's encrypted end to end.
- **Run code in the app** with the data it sends. The app blocks inline scripts, shows text as text,
  and runs drawings and HTML previews in locked-down frames. No path was found.

**Why the last point matters:** the app is one website for all your machines. If code ever did run
inside the open app (a poisoned deploy, or a bug), it could use **every** machine's key while the tab
is open — read and chat on all of them, and use any passkey step-up you confirmed in the last 15
minutes. It still can't copy the keys, and it loses everything when the page closes.

## What to do when something goes wrong

### Lost or stolen phone

1. **Revoke the device.** From another device: Settings › Daemons, open the machine, find the
   device in its list and tap **Revoke**. This closes its connections at once.
2. If you have no other device: **at the machine**, switch its permissions off with
   `fy device grant <device> <capability>` (landing in #464). There is no `fy` command to remove a
   device yet. Instead, pair a new device with `fy pair --full`, add its passkey, and revoke the old
   one from it.
3. Check **Settings › Security** (the audit log) for what it did (landing in #461), or run
   `fy daemon audit` at the machine.
4. If the thief could have chatted with an agent that runs tools, check that machine's sessions.

### A device you don't recognise was paired

1. Tap **Remove it** on the in-app notice, or revoke it from the machine's device list (landing in #461).
2. Look at the audit log for when and over which carrier it was paired (landing in #461).
3. Ask who had access to the machine: pairing needs `fy pair` at the machine, or a device allowed
   to pair others.

### You lost your passkey (landing in #464)

1. At the machine, run `fy passkey window <device>`. This re-opens that device's passkey sign-up for
   **10 minutes, for one passkey**.
2. On the device, open Settings › Daemons › Security and tap **Add a passkey**.

### One machine was hacked

1. **Stop using it from the app** and take it offline.
2. On your phone, **remove that machine** from the app (Settings › Daemons). This deletes its device
   key from the phone.
3. **Turn off notifications** for it. Because the phone has one shared notification subscription,
   this turns them off for every machine. Turn them back on from a machine you trust.
4. **Don't clone from it.** If you already cloned from it to another machine, check that machine's
   hooks, MCP servers and settings by hand.
5. Rotate any secrets and accounts that machine held. Treat everything on it as exposed.
6. Rebuild it, install Ferretry fresh, and pair again.

### The app's signing key or deploy was compromised

Follow [If the key is compromised](pwa-release-signing.md#if-the-key-is-compromised). In short:
remove the secret, make a new key, deploy, then on each device clear the site's data and reinstall.

### The relay is misbehaving

Nothing to rotate: the relay never holds a key or code. Use the **direct** carrier if you can reach
the machine, or [run your own relay](cloudflare-relay-self-hosting.md).

## What this does not protect

Said plainly, because "zero trust" sounds like more than it is:

- **A hacked machine.** Everything ends on the machine. Malware running as your user can read the
  daemon's state, its token file and its secrets.
- **Code running inside the open app.** It can _use_ every machine's key while the tab is open and
  raise passkey prompts. **Only accept a passkey prompt you expected.** It ends when the page closes.
- **The first time you open the app.** Your browser trusts whatever the site serves at that moment.
  A deploy that ships a new service worker can replace the checker; this is only sometimes detected.
- **An unlocked phone with the app open**, for anything that needs no passkey: reading and chatting.
  Chatting with an agent that has tools can run commands. **Remove the device first.**
- **Someone at the machine.** `fy` with the token file is never limited (landing in #464 it is the
  only thing that isn't). Anyone at an unlocked keyboard has the machine.
- **The 30-day idle window.** A device used once a month never expires. Remove devices you stopped
  using.
- **Relay metadata.** The relay sees your machine's fingerprint, IP addresses, timing and sizes.
- **Being cut off.** A relay or network can drop your traffic.
- **Device health.** Nothing checks your phone's OS version, screen lock or disk encryption.
- **Clone from a machine you don't trust** — see above.

## Known gaps

| Gap                                                                                      | State            |
| ---------------------------------------------------------------------------------------- | ---------------- |
| Clone preview doesn't show the hook / MCP / settings commands it will copy               | fix proposed     |
| All machines share one notification subscription; only the first machine can deliver     | fix proposed     |
| Turning notifications off for one machine turns them off for every machine               | fix proposed     |
| The passkey prompt names the machine but not the action                                  | fix proposed     |
| No `fy` command removes a device at the machine                                          | fix proposed     |
| Per-machine security settings (passkey window, key rotation, idle days)                  | (planned)        |
| A refusal before a route runs (no credential, switched-off grant) isn't in the audit log | declared in #461 |
| A real authenticator's passkey ceremony is tested only with software authenticators      | declared in #464 |
