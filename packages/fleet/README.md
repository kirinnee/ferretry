# fleet

The account model as a library: machine, credentials, components, profiles and runtimes, plus the
launch wrappers and the per-harness config each runtime gets. The contract is
[docs/account-model.md](../../docs/account-model.md).

A runtime's config directory is `<FY_HOME>/fleet/homes/<runtime id>` (normally
`~/.ferretry/fleet/homes/<runtime id>`), so every runtime stays beneath Ferretry. Materialising one
links its single-source assets (instructions, skills) in from `<FY_HOME>/fleet/assets` and generates
the files that merge several layers (settings, MCP servers), so editing a component changes every
runtime that uses it.

A `config.yaml` that is not `version: 2` is refused, never converted; see
[the contract](../../docs/account-model.md#version-1-is-retired).
