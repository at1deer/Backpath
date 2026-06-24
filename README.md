# Backpath

Backpath finds what a transformation makes unrecoverable.

Backpath is currently a v0.9 public release candidate.

Backpath is a CLI for finding replayable witnesses of transition loss across black-box transformations. A manifest declares source states, local commands, validation schemas, equivalence contracts, and a search budget. Backpath runs the declared checks and emits JSON evidence that can be replayed.

Backpath reports witnesses, not scores.

## Quickstart

```bash
npm install
npm test
node bin/backpath.js check examples/manifests/distinction-collision.approval.json
node bin/backpath.js check examples/manifests/return-failure.approval.json
node bin/backpath.js check examples/manifests/compare-paths.role.json
node bin/backpath.js check examples/manifests/locate-loss.account-type.json
```

A distinction collision witness starts like this:

```json
{
  "operation": "distinction_collision",
  "status": "witnessed",
  "classification": "distinction_collision"
}
```

## Witness Types

- Domain Exclusion: a valid source state cannot cross.
- Distinction Collision: two distinct source states become equivalent after transformation.
- Return Failure: a source state cannot return through the declared reverse path.
- Path Divergence: two declared routes from the same source reach non-equivalent terminal states.
- Loss Localization: the pipeline edge where a distinction first collapses.

## Demo

The approval example has two distinct source states:

```json
{ "approval": "manual" }
```

and:

```json
{ "approval": "automatic" }
```

Both transform to:

```json
{ "approved": true }
```

Run the check:

```bash
node bin/backpath.js check examples/manifests/distinction-collision.approval.json
```

The emitted witness means the declared transform collapses the distinction between manual and automatic approval under the target equivalence contract.

Replay a checked-in sample witness:

```bash
node bin/backpath.js replay examples/witnesses/sample-distinction-collision.approval.json
```

The CLI does not currently support `--out`; use shell redirection if you want to save a newly emitted witness.

## Epistemic Honesty

Backpath reports witnesses, not scores.

A finite exhaustive enumerator may support `proven_within_domain`.

A bounded generator or corpus-mutation search can only support `not_found_within_budget` when no witness is found.

## Current Features

- JSON manifests and JSON witnesses.
- Ajv validation for manifests and declared source/target schemas.
- `argv`-array command execution with `shell: false`, command evidence, and replay.
- Corpus, exhaustive enumerator, generator, and corpus-mutation source search.
- Exact and built-in structural equivalence contracts.
- Declared retained-memory return checks with `memory.mode="declared"` and `reverseEnvelope=true`.
- Local witness shrinking for `domain-exclusion`, `return-failure`, and `distinction-collision`.

## Limitations

- Backpath executes local commands and is not a sandbox.
- Do not run untrusted manifests or transforms.
- Exact and structural equivalence are implemented.
- Canonical and predicate equivalence are not implemented yet.
- Automatic JSON Schema generation is not implemented yet.
- YAML manifests are not implemented yet.
- Path/loss shrinking is not implemented yet.
- Retained-memory binding checks `requireBinding=true` are not implemented yet.
- Retained memory is implemented for `return-failure` only.
- `memory.reverseEnvelope=false` is not supported.
- Loss localization currently supports linear distinction-collision localization only.

## Development

```bash
npm test
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md).
