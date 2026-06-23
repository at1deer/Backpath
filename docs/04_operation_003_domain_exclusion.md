# Operation 003: Domain Exclusion

## Operational statement

Find the smallest valid source state that cannot cross the forward transformation as a valid target state.

\[
x \in X
\]

but:

\[
F(x) \notin Y
\]

or \(F(x)\) fails to produce a target at all.

## Witness predicate

```text
valid_source(x)
and one of:
  forward rejects x
  forward crashes
  forward times out
  forward emits malformed output
  forward emits invalid target
  forward exhausts declared resource limits
```

## Classifications

- `source_rejected`
- `transform_crash`
- `timeout`
- `malformed_output`
- `invalid_target`
- `resource_exhausted`

## What does not count

- Two states becoming equivalent. That is Distinction Collision.
- A successful forward journey that fails only on reverse. That is Return Failure.
- A target-corpus state with no known preimage. That is a later Preimage Search operation.
- A transformation intentionally refusing values outside the declared source domain.
