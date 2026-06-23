# Recommended Build Order

1. Implement manifest validation against `schemas/backpath-manifest.v1.schema.json`.
2. Implement black-box command runner with JSON stdin/stdout.
3. Implement corpus loading and exact equivalence.
4. Implement `domain-exclusion`.
5. Implement `return-failure`.
6. Implement `distinction-collision`.
7. Implement witness output and replay.
8. Add local shrinking.
9. Add `compare-paths`.
10. Add `locate-loss`.
11. Add JSON Schema validation/generation.
12. Add structural/canonical/predicate equivalence.
