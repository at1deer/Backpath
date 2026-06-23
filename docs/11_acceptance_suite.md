# Acceptance Suite

## Operation 001: Distinction Collision

### Enum-to-boolean collapse

```json
{"approval":"manual"}
{"approval":"automatic"}
```

Both become:

```json
{"approved":true}
```

Expected:

```text
classification: distinction_collision
differencePaths: /approval
```

## Operation 002: Return Failure

### Guessed reconstruction

```text
automatic -> true -> manual
```

Expected:

```text
classification: return_drift
```

## Operation 003: Domain Exclusion

### Valid source rejected

```json
{"status":"pending_review"}
```

Expected:

```text
classification: source_rejected
```

## Operation 004: Path Divergence

### Branching migration disagreement

Path A:

```text
v1 -> v2 -> v4
```

Path B:

```text
v1 -> v3 -> v4
```

Source:

```json
{"role":null}
```

Expected:

```text
classification: path_divergence
```

## Operation 005: Loss Localization

Pair remains distinct after edge 1 and collides after edge 2.

Expected:

```text
classification: loss_localized
firstLossEdge: edge_2
```
