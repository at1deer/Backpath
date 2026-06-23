# Operation 001: Distinction Collision

## Operational statement

Find the smallest pair of meaningfully distinct valid source states that a transformation maps into meaningfully equivalent valid target states.

Formally, find \(x_a,x_b \in X\) such that:

\[
x_a \not\sim_X x_b
\]

and:

\[
F(x_a) \sim_Y F(x_b)
\]

## Witness predicate

```text
valid_source(A)
valid_source(B)
not source_equivalent(A, B)
forward(A) succeeds as target_A
forward(B) succeeds as target_B
valid_target(target_A)
valid_target(target_B)
target_equivalent(target_A, target_B)
```

## What does not count

- One input is rejected. That is Domain Exclusion.
- Source states are equivalent under the source contract.
- Outputs only look similar to a human but are not target-equivalent.
- The transformation is unstable across replays.
- Both inputs fall into the same failure sink.

## Search procedure

For exact or canonical target equivalence:

1. Generate or load source states.
2. Validate each source.
3. Run forward transform.
4. Validate each target.
5. Canonicalize or hash target equivalence class.
6. Bucket source states by target equivalence class.
7. Inside each bucket, compare source equivalence classes.
8. Emit witness when one target bucket contains multiple source classes.

## Shrinking

Distinction Collision requires paired shrinking. The shrinker must preserve:

```text
A remains valid
B remains valid
A and B remain source-distinct
F(A) and F(B) succeed
F(A) and F(B) remain target-equivalent
```

## Classification

```text
classification: distinction_collision
```
