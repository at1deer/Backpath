# Operation 004: Path Divergence

## Operational statement

Find the smallest valid source state for which two declared transformation routes to a common target domain produce meaningfully different terminal states.

Given paths \(P\) and \(Q\):

\[
P(x) \not\sim_Z Q(x)
\]

where \(Z\) is the terminal target domain.

## Witness predicate

```text
valid_source(x)
path_A(x) succeeds as z_A
valid_terminal(z_A)
path_B(x) succeeds as z_B
valid_terminal(z_B)
not terminal_equivalent(z_A, z_B)
```

## Use cases

- Direct converter versus multi-step converter.
- Two migration branches reaching the same version.
- Export/import route versus native migration route.
- Normalization before validation versus validation before normalization.

## Relationship to Loss Localization

Path Divergence says the routes disagree. Loss Localization can later identify the earliest edge or edge-pair where the disagreement appears.
