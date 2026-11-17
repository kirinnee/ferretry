## What and why

## Outside files

<!--
One feature lives in its own plugin folder. A pull request into rebuild/5.0-after that changes a file outside its
home folder (another plugin, packages/core/*, packages/app, root configs, scripts, docs) names each one here, with a
reason, one line per file or glob. Leave this section empty when everything is inside your folder.
  - packages/core/kernel/src/x.ts: the new port has to be registered here
Home is the package with the most changed lines; to name it yourself, put `Home: <package>` on a line of the body.
-->

## Contract change

<!--
A feature adds files and lines; it never rewrites shared code. A pull request that edits a file a package declares in its
composition.tsv (a manifest literal, a wiring index.ts, a contract barrel, a big service class) names each one here with its
full path and a one-line reason. Leave this section empty when you edit none. Not needed for one new line in its sorted place
in a registry, or for lines closed in a ports-pending.json ledger.
  - packages/core/ferrets/contract/port.ts: new `restart` member of FerretsApi
-->
