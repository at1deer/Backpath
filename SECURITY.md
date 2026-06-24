# Security

Backpath executes commands declared in manifests.

Backpath is not a sandbox. Its runner uses argv arrays and command timeouts, but those controls do not isolate untrusted code from the host system.

Do not run untrusted manifests, transforms, generators, enumerators, validators, canonicalizers, or equivalence predicates.

Use OS-level, virtual-machine, or container isolation when evaluating untrusted transformations.
