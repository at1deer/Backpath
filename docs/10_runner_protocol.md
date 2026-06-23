# Runner Protocol

Backpath treats transformations as black-box commands.

## Input

A transform receives exactly one JSON value on standard input.

## Output

A transform emits exactly one JSON value on standard output.

## Error

A nonzero exit code means the transform failed or rejected the input. Standard error is captured as diagnostic evidence.

## No shell interpolation

Use `argv` arrays. Do not invoke shell commands by default.

## Reverse isolation

For return testing, the reverse command should receive only target JSON, declared retained memory, declared files, and declared environment variables. It should not inherit temporary files from the forward run.

## Security boundary

Backpath executes arbitrary user-provided commands. It is not a sandbox. The prototype can isolate temp directories, but it must not claim process-level security containment.
