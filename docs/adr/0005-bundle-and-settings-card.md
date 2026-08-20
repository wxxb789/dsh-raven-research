---
status: accepted
---

# Ship Raven as a Profile Bundle on the Host plane, with a browser settings card

Raven was installable only by hand-editing an Agent Preset, and it was invisible in the Web settings UI. Both are fixed by declaring what the Harness already reads.

A Bundle is not a plugin and has no code surface: it is an npm package whose manifest declares `dsh.bundle.patch`, pointing at a YAML patch of plugin rows. Declaring it is the entire contract, and it is what makes `dsh plugin add dsh-raven-research` append the package to a profile's bundle list without the user editing a composition.

The row goes on the Host plane. Raven publishes no Service, so the usual host-plane criterion does not apply; two of the things it registers are process-wide anyway. Its settings namespace can only be offered by a configuration surface while something is serving it — mounted inside a preset, `raven-research` would appear in the settings UI exactly while a session using that preset happened to be alive, and vanish between sessions. Its `tools/code-dispatch-log` waterfall carries the durable record of a Task step taken from inside `run_code`. Because `tools` and `system-prompt` are layered registries, a host row lands in the global layer and every agent sees `raven_task`, which is the intended meaning of installing Raven. The preset-scoped row stays documented for a deployment that wants Raven in one preset only; doing both registers the tool twice into two different layers.

A host-only plugin is invisible in the Web settings UI — not listed as unconfigurable, simply absent. Every settings page is hand-written React and the only namespace-aware surface dispatches the keyed `settings.plugin.item` slot, whose key is the settings namespace precisely so a plugin distributed outside the Harness repository can contribute a card. Raven therefore ships a browser half whose only contribution is that card: the Task itself stays a Host concern, and a browser half mirroring any of it would be a second copy of the truth.

Two costs are accepted knowingly. The Harness card chrome and staged-form model cannot be imported across the client bundle-purity boundary, so they are reimplemented — with every rule in a pure module, because a reimplementation is exactly what drifts and purity is what makes it testable without a browser. And the published copy of the slot's declaring package lags the running Harness, changing `kind: 'list'` to `kind: 'keyed'` between them; a card registered under the older shape compiles and never renders, with nothing logged, so the targeted augmentation is restated locally and the release gate asserts it against the Harness checkout under test.
