# Accounts round 1 fixes

Scope: the eight findings against `rebuild/port-accounts-a` at `cae20e1942`. Fix work is on
`fix/accounts-a-r1`; the target remains `rebuild/port-accounts-a`. No core package was edited by this fixer.

## Findings and evidence

1. **Mask sources:** Accounts declares the approved `redaction.sources` provide hook, key `source`, and supplies
   live AccountVault and staged-seed values. Saved values keep `login:<ID>:<field>` labels; staged seeds use `2fa:…`.
   `S10 supplies saved passwords and staged seeds to Vault through the declared live redaction source` drives the
   real Accounts daemon and hook with Vault's contract fake, stages and commits a seed, and checks actual masking.
   It has no skip. `I126 the owner listing exposes presence only, and saved accounts cannot resolve as Vault secrets`
   checks the separate general-secret boundary. The real Vault consumer is the lead-owned mask-source port, not yet
   on this base. Its retain-on-disappearance/throw behavior and the two real halves together belong to day-5 integration.
2. **Account defaults:** copied today's `accountDefaultsDifferences` judgement, including unattributed removals.
   The three `S79` tests in `review-r1.test.ts` use the real config-files service for raw disk edits, deletion and
   unconfirmed writes in every scope, and drive the owner removal-only route without a passkey while device additions
   still demand one. `S81 S79 should write the owner’s line through the kernel…` exercises owner writes and rename.
3. **Late recipes:** handlers resolve the recipe getter when called. Creation, replacement, list, hint and
   metadata-only replies use the checker/scrubber; a missing provider strips stored recipe texts. `I133 late-built
recipes check creation and updates, and scrub listing, hint and metadata-only replies at read time` uses daemon
   composition and adds a masked value after the recipe was saved.
4. **Passkeys and stored proofs:** Accounts now calls Access's approved `holdsPasskey`, `holds` and
   `verifyStoredProof` reads; absence or unreadability refuses. `S92 a paired passkey enables staging through the
composed Accounts daemon; a missing provider refuses` proves staging success and refusal. `S120 stored rule
validation calls Access with the registered credential and the challenge derived from the signed body` loads a
   signed rule through composition and checks verification and active status. `I193 a host admin token cannot save
a seed without a fresh proof bound to that exact account and stage` checks refusal, cross-stage binding and one-use.
   The real Access additions are lead-owned commit `65a25e6e074`; they are represented by a local TODO adapter until
   merged into 5.0, never by permanent false predicates.
5. **Owner recipe decisions and CLI:** ported the owner proposal decision route and today's show/set/clear/approve/
   decline controller, rendering and gateway operations. `I140 the owner's approve/decline route…` tests canonical
   decisions and closure of the right ask; another I140 test refuses stale proposals and ferret decisions. Every
   retained CLI operation has its own success test through the real half/controller/gateway. `I176 recipe writes
keep the daemon owner-only refusal and never retry another credential` checks the refusal path. The owned ask
   source now declares recipe-proposal refs. Asks adapters were updated to the base's per-ferret AskRef contract.
   **Pending shell hookup:** recipe set uses the approved optional `CliContext.readText(path)` (`-` means stdin).
   Until the shell supplies it, set refuses with a clear sentence; there is no plugin filesystem reader.
6. **Service audit:** Gate is a required core dependency. The sink calls `GateApi.audit` with event, actor, subject,
   outcome, detail and cause instead of logging a reduced record. `S128 damaged rules keep the service security
audit record with actor, outcome and action` checks the composition. Cause is passed through now; its
   persistence awaits the lead-approved additive Gate contract field. The S120 composed test also revokes the approving device and checks that the full suspension record reaches Gate with cause daemon.
7. **Removed readers:** deleted the account-only proposal selector, saved-login summary/list/write/hint projection
   and unused old form builders, including the direct seed body. Shared field, matching and input-card primitives
   remain. Wire recipe tests now use canonical accounts/sign-ins. `S84 rejects the removed account-only proposal
selector and direct seed body at the canonical routes` checks the remaining boundaries. Rule suggestions reject
   account-only selectors too.
8. **Guarantee tests:** S10 and S79 now exercise the actual enforcing composition/config boundary. New semantic
   tests cover observation identity resets, store-lock races, atomic card saves, stable sealed names/sign-in ids,
   exact matching and choices, malformed index seed/key layouts, sweeps, seed parsing/mismatch and stage limits.
   Existing semantic boundary tests were given the corresponding prefix where the test already proved that row.
   Coverage of the 84 specifically listed missing-prefix rows and the remaining list follow below. This does not
   claim every guarantee is complete; existing porter-report gaps remain too.

## Validation

Run `bun x tsc -p packages/plugins/accounts/tsconfig.json` and `bun scripts/gen/check.ts --package accounts`.
Before unit tests, check the shared count with `bash /tmp/claude-1000/bun-tests-running.sh`, then use
`timeout 300 bun test <changed Accounts unit test files only>`. No integration/tmux suite, network fixture, real
home, real credentials, or core source edits are part of this work.

The package check still reports the absent Vault hook offer until its reviewed branch reaches 5.0, plus four
pre-existing CLI environment/clock/wait adapters waiting on the approved CliContext ports. The new recipe file
reader uses only the approved local readText port and adds no forbidden filesystem access.

Validation before commit: 303 focused tests passed across the 16 changed unit test files; package TypeScript passed. The scoped package check ran and reports only the pending Vault hook and four existing CLI context adapters.

The final validation result and exact head are recorded on card F1893 and sent to the lead with `fy signal done`.

## Missing-prefix row audit

28 of the 84 listed rows now have an enforcing test title starting with the id:

I128 I129 I138 I145 I147 I151 I153 I159 I179 I180 I183 I191 I192 S95 S115 S129 I125 I126 I165 I176 I187 I188 I193 I231 S81 S84 S118 S134

Still without that coverage (56):

I34 I130 I136 I137 I139 I142 I143 I144 I146 I148 I149 I150 I156 I157 I158 I160 I161 I162 I163 I164 I166 I167 I168 I169 I170 I171 I172 I174 I175 I177 I178 I186 I244 S76 S86 S93 S97 S100 S102 S109 S114 S125 S135 S136 S137 S139 S140 G90 I227 I229 I230 S68 S73 S91 S98 S138

Many of the remaining input-delivery/observer rows need Vault-side composition that is outside this fixer's allowed files. Others still need dedicated UI, CLI or rule tests. None are claimed covered by unrelated tests.
