# Manifest Reference

The manifest is the user's declaration of the transition specimen. It should be boring, explicit, and reproducible.

## Top-level fields

- `version`: currently `1`.
- `operation`: `distinction-collision`, `return-failure`, `domain-exclusion`, `compare-paths`, or `locate-loss`.
- `source`: source domain definition.
- `forward`: forward transformation command.
- `target`: target domain definition.
- `reverse`: required for `return-failure`.
- `paths`: required for `compare-paths`.
- `pipeline`: required for `locate-loss`.
- `search`: controls source discovery.
- `shrink`: controls witness minimization.
- `replay`: controls stability checks.

## Command shape

Commands use `argv`, not shell strings:

```json
{
  "argv": ["python", "examples/transforms/approval_up.py"],
  "timeoutMs": 2000,
  "stdin": "json",
  "stdout": "json"
}
```

No shell interpolation should occur.
