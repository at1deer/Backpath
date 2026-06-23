# Backpath Documentation Pack

Backpath is a transition-loss instrument.

It does not grade software, moralize migrations, or produce preservation scores. It produces concrete witnesses showing how a declared transformation excludes, merges, strands, drifts, diverges, or localizes states under explicit equivalence contracts.

The first build should be a black-box command-line tool. A user supplies JSON states, command-line transformations, validation/equivalence contracts, and a search budget. Backpath returns a reproducible witness or an honest bounded non-finding.

## Implemented operations

| Manifest operation | Witness operation |
| --- | --- |
| `domain-exclusion` | `domain_exclusion` |
| `distinction-collision` | `distinction_collision` |
| `return-failure` | `return_failure` |
| `compare-paths` | `path_divergence` |
| `locate-loss` | `loss_localization` |

## Limitations

- Corpus mode only.
- Exact and structural equivalence are implemented.
- Local shrinking is implemented for `domain-exclusion`, `return-failure`, and `distinction-collision`.
- No generation yet.
- No canonical or predicate equivalence yet.
- No retained memory support yet.
- No sandbox security claim.
- Loss localization currently supports linear distinction-collision localization only.

## Current Prototype Features

- JSON manifests and JSON witnesses.
- Ajv validation for manifests and declared source/target schemas.
- `argv`-array command execution with command evidence and replay.
- Corpus-mode checks for `domain-exclusion`, `distinction-collision`, `return-failure`, `compare-paths`, and `locate-loss`.
- Exact and built-in structural equivalence contracts.
- Local witness shrinking for `domain-exclusion`, `return-failure`, and `distinction-collision`.

## Pack contents

- `schemas/backpath-manifest.v1.schema.json` — manifest contract for all core operations.
- `schemas/backpath-witness.v1.schema.json` — machine-readable witness/report contract.
- `schemas/backpath-replay.v1.schema.json` — reproducible replay bundle contract.
- `docs/00_project_brief.md` — project boundary and invention claim.
- `docs/01_core_model.md` — transition model, domains, equivalence, statuses.
- `docs/02_operation_001_distinction_collision.md` — forward distinction loss.
- `docs/03_operation_002_return_failure.md` — returnability failure taxonomy.
- `docs/04_operation_003_domain_exclusion.md` — valid source states that cannot cross.
- `docs/05_operation_004_path_divergence.md` — different routes, different terminal states.
- `docs/06_operation_005_loss_localization.md` — locating the edge where loss first occurs.
- `docs/07_manifest_reference.md` — manifest field guide.
- `docs/08_witness_reference.md` — witness/report field guide.
- `docs/09_cli_reference.md` — proposed CLI.
- `docs/10_runner_protocol.md` — subprocess protocol and isolation rules.
- `docs/11_acceptance_suite.md` — specimen corpus and expected findings.
- `docs/12_mvp_roadmap.md` — build sequence and kill criteria.
- `docs/13_codex_build_prompt.md` — implementation prompt for a coding agent.
- `examples/` — starter manifests, toy transforms, corpus items, and sample witness.

## Not Implemented Yet

- Search generation and corpus mutation.
- Canonicalizer commands and predicate equivalence.
- Retained memory contracts.
- YAML manifests.
- Dashboards, plugins, scoring, and sandbox security.
- Return localization, path-divergence localization, and path/loss shrinking.
