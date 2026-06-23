# MVP Roadmap

## Stage 0: Corpus-only skeleton

Implement manifest loading, corpus file loading, exact equivalence, subprocess runner, timeout capture, and witness output.

Operations:

- `domain-exclusion`
- simplest `return-failure`
- simplest `distinction-collision`

No shrinking yet.

Exit condition:

> Backpath can find a real witness from two JSON corpus files and replay it.

## Stage 1: Stable witness format

Implement witness schema validation, replay command, manifest digest, contract digest, human-readable report, and stable replay checks.

## Stage 2: Local shrinking

Implement simple object-field deletion shrinker, array shrinker, scalar shrinker, pair-aware shrinker for Distinction Collision, and classification-preserving shrinkers.

## Stage 3: Path engine

Implement named path execution, intermediate artifact capture, and `compare-paths`.

## Stage 4: Loss localization

Implement linear pipeline replay and first collision edge detection.

## Stage 5: Schema-aware generation

Add JSON Schema validation, basic generation, corpus mutation, and finite enumeration where possible.

## Stage 6: Equivalence expansion

Add structural ignore paths, unordered paths, normalizers, canonicalizer commands, predicate commands, and sampled equivalence-law checks.
