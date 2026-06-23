# Witness Reference

A witness is the unit of Backpath evidence.

It should be concrete, minimized when possible, replayable, contract-bound, and epistemically honest.

## Top-level fields

- `version`: currently `1`.
- `operation`: machine name of operation.
- `status`: `witnessed`, `proven_within_domain`, `not_found_within_budget`, or `indeterminate`.
- `classification`: specific finding class.
- `contractDigest`: digest of the manifest and relevant equivalence/validation contracts.
- `source`: source evidence.
- `target`: target evidence.
- `minimality`: shrinking and minimality claim.
- `reproducibility`: replay counts, seed, and replay command.
- `search`: budget, evaluated states/pairs, and exhaustive flag.

## Required philosophy of reports

Reports must say:

> Here is what happened under this contract.

They must not say:

> This migration is bad.
> This system is safe.
> This transformation preserves meaning.
