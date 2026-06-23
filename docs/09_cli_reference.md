# CLI Reference

## Commands

```bash
backpath validate manifest.json
backpath check manifest.json
backpath replay witness.json
backpath explain witness.json
```

## MVP command subset

The first prototype only needs:

```bash
backpath validate manifest.json
backpath check manifest.json
backpath replay witness.json
```

## CI behavior

Recommended exit codes:

- `0`: valid run with no witnessed finding, unless configured otherwise.
- `1`: witnessed finding when `--fail-on witnessed`.
- `2`: invalid manifest.
- `3`: indeterminate when `--fail-on indeterminate`.
