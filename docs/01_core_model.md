# Core Model

## Transition specimen

A Backpath specimen has the form:

\[
T = (X, Y, F, E_X, E_Y, G?, M?, C?)
\]

Where:

- \(X\): source domain.
- \(Y\): target domain.
- \(F\): forward transformation.
- \(E_X\): source equivalence.
- \(E_Y\): target equivalence.
- \(G\): optional reverse transformation.
- \(M\): optional declared retained memory.
- \(C\): optional declared context.

## Equivalence

Backpath does not decide what matters. Users declare equivalence.

Supported modes:

1. `exact` — parsed JSON structures must be equal.
2. `canonical` — values are canonicalized before comparison.
3. `structural` — paths may be ignored, unordered, or normalized.
4. `predicate` — custom two-value command returns equivalent or not.

## Epistemic statuses

- `witnessed`: a concrete counterexample was found.
- `proven_within_domain`: finite declared domain was exhaustively evaluated.
- `not_found_within_budget`: no witness was found under the stated budget. Not proof.
- `indeterminate`: execution, validation, equivalence, memory, or context was unstable.

## Cost and minimization

Preferred cost order:

1. Number of meaningful difference paths.
2. Total structural node count.
3. Maximum depth.
4. Serialized size.
5. Scalar complexity.
6. Deterministic lexical tie-break.
