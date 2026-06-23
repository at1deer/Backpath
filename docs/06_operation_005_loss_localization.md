# Operation 005: Loss Localization

## Operational statement

Given a witnessed transition loss across a pipeline, identify the earliest declared edge where the relevant distinction, returnability, validity, or route agreement first fails.

Loss Localization converts a symptom into a repair location.

## Initial scope

The first implementation should support linear pipelines and collision witnesses:

```text
source pair A/B -> edge 1 -> edge 2 -> edge 3
```

Backpath evaluates the pair after each edge and finds the first edge where they become equivalent under the edge's target equivalence contract.

## Collision localization predicate

Given a source pair \((A,B)\) from Operation 001:

1. At pipeline start, \(A \not\sim_X B\).
2. After each edge, compute \(A_i, B_i\).
3. Find the first edge where:

```text
A_(i-1) and B_(i-1) are distinguishable
A_i and B_i are equivalent
```

Emit:

```text
classification: loss_localized
lossKind: distinction_collision
firstLossEdge: edge_i
```
