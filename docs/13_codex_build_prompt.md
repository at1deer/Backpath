# Codex Build Prompt: Backpath Prototype

Build a minimal Backpath CLI prototype from this documentation pack.

## Hard constraints

- Do not build a web app.
- Do not build a dashboard.
- Do not add moral scoring or preservation scores.
- Do not use shell command strings. Use argv arrays.
- Do not start with YAML. Use JSON manifests.
- Do not require JSON Schema generation in the first pass.
- Do not implement a plugin system.
- Do not claim sandbox security.

## Required commands

```bash
backpath validate manifest.json
backpath check manifest.json
backpath replay witness.json
```

## Required v0 behavior

Implement corpus mode with exact equivalence.

Support these operations:

1. `domain-exclusion`
2. `distinction-collision`
3. `return-failure`

Path operations may be stubbed behind clear `not implemented` messages.

## First commit definition of done

- Project builds.
- `backpath validate` accepts the example manifests.
- `backpath check examples/manifests/distinction-collision.approval.json` emits `classification: distinction_collision`.
- `backpath check examples/manifests/return-failure.approval.json` emits `classification: return_drift`.
- `backpath check examples/manifests/domain-exclusion.status.json` emits `classification: source_rejected`.
- `backpath replay` can rerun at least one emitted witness.
