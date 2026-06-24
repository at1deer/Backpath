# Backpath

Backpath finds what a transformation makes unrecoverable.

Backpath is a CLI for finding replayable witnesses of transition loss across black-box transformations. A user supplies JSON states, command-line transformations, validation/equivalence contracts, and a search budget. Backpath returns a concrete witness, a finite-domain proof, or an honest bounded non-finding.

It does not grade software or produce preservation scores.

## Quickstart

```bash
npm install
npm test
node bin/backpath.js check examples/manifests/distinction-collision.approval.json
node bin/backpath.js replay examples/witnesses/sample-distinction-collision.approval.json
```

## Compact Example

A distinction collision is a case where two source-distinct states become equivalent after a transformation. In the approval example:

```json
{ "approval": "manual" }
```

and

```json
{ "approval": "automatic" }
```

both transform to:

```json
{ "approved": true }
```

Backpath reports this as:

```json
{
  "operation": "distinction_collision",
  "status": "witnessed",
  "classification": "distinction_collision"
}
```

## Implemented Operations

| Manifest operation | Witness operation |
| --- | --- |
| `domain-exclusion` | `domain_exclusion` |
| `distinction-collision` | `distinction_collision` |
| `return-failure` | `return_failure` |
| `compare-paths` | `path_divergence` |
| `locate-loss` | `loss_localization` |

## Current Features

- JSON manifests and JSON witnesses.
- Ajv validation for manifests and declared source/target schemas.
- `argv`-array command execution with command evidence and replay.
- Corpus, exhaustive enumerator, generator, and corpus-mutation source search.
- `proven_within_domain` only for completed finite exhaustive enumerator searches.
- Exact and built-in structural equivalence contracts.
- Declared retained-memory return checks with `memory.mode="declared"` and `reverseEnvelope=true`.
- Local witness shrinking for `domain-exclusion`, `return-failure`, and `distinction-collision`.

## Limitations

- Backpath executes arbitrary local commands declared by manifests.
- Backpath is not a sandbox; use OS or container isolation for untrusted code.
- Source search supports corpus, enumerator, generator, and corpus-mutation modes.
- Exact and structural equivalence only.
- No canonical or predicate equivalence yet.
- No automatic JSON Schema generation yet.
- No YAML manifests yet.
- Path/loss shrinking is not implemented.
- Retained-memory binding checks with `memory.requireBinding=true` are not implemented.
- Retained memory is implemented for `return-failure` only.
- `memory.reverseEnvelope=false` is not supported.
- Loss localization currently supports linear distinction-collision localization only.

## Pack Contents

- `schemas/backpath-manifest.v1.schema.json` - manifest contract for all core operations.
- `schemas/backpath-witness.v1.schema.json` - machine-readable witness/report contract.
- `schemas/backpath-replay.v1.schema.json` - reproducible replay bundle contract.
- `docs/` - model, operation, manifest, witness, runner, and roadmap notes.
- `examples/` - starter manifests, toy transforms, generators, corpus items, and sample witnesses.

## Not Implemented Yet

- Automatic JSON Schema generation.
- Canonicalizer commands and predicate equivalence.
- Retained-memory binding checks.
- Retained-memory reverse input without an envelope.
- Retained memory for operations other than `return-failure`.
- YAML manifests.
- Dashboards, plugins, scoring, and sandbox security.
- Return localization, path-divergence localization, and path/loss shrinking.
