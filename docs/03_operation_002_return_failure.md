# Operation 002: Return Failure

## Operational statement

Find the smallest valid source state whose forward journey either cannot return, returns ambiguously, or returns as a meaningfully non-equivalent source state.

Basic law:

\[
G(F(x)) \sim_X x
\]

Backpath searches for \(x\) where the law fails under the declared contract.

## Failure classes

- `stranded_successor`: forward succeeds and produces valid target data, but reverse rejects it.
- `invalid_return`: reverse succeeds but emits invalid source data.
- `return_drift`: forward and reverse succeed, but returned source is not equivalent to original.
- `return_ambiguity`: same successor produces multiple source-equivalence classes across reverse runs or reverse variants.
- `context_dependent_return`: round trip works only when undeclared ambient state remains available.
- `retained_memory_failure`: declared memory is missing, invalid, mismatched, or insufficient.
- `forward_excluded`: forward rejection is observed during return testing, but belongs canonically to Domain Exclusion.

## Retained memory

Backpath must treat declared retained memory as lawful. A target object may be non-injective while the transition remains reversible through an explicit sidecar.

The reverse environment should contain only target artifact, declared memory, declared files, declared environment variables, and a fresh process/clean temp directory by default.

## Shrinking

Shrink one source state while preserving the canonical failure classification.
