# Changelog

## v0.8.1

- Added release hygiene for active search, CI, public README updates, package metadata, and security documentation.

## v0.8

- Added active source search with corpus, finite exhaustive enumerator, bounded generator, and corpus-mutation modes.
- Added epistemically honest search metadata and `proven_within_domain` only for completed finite exhaustive no-witness searches.

## v0.7

- Added declared retained memory for `return-failure`.
- Added reverse input envelopes for retained-memory reconstruction and explicit retained-memory failure diagnostics.

## v0.6

- Added built-in structural equivalence with ignored paths, unordered arrays, and simple normalizers.
- Kept exact equivalence as the default.

## v0.5

- Added local witness shrinking for `domain-exclusion`, `return-failure`, and `distinction-collision`.
- Added minimality metadata for shrunk witnesses.

## v0.4

- Added `locate-loss` as `loss_localization` for linear distinction-collision localization.
- Added replay support for loss-localization witnesses.

## v0.3

- Added `compare-paths` as `path_divergence`.
- Added path evidence, terminal mismatch, route failure handling, and replay support.

## v0.2

- Added contract fidelity with Ajv manifest/source/target validation.
- Improved command evidence, return-failure boundaries, domain-exclusion classifications, and replay portability.

## v0.1

- Added the core CLI prototype with `validate`, `check`, and `replay`.
- Added corpus mode, exact equivalence, and core operations for domain exclusion, distinction collision, and return failure.
