# Security

Backpath executes user-declared commands from manifests.

Backpath is not a sandbox. Its process runner uses argv arrays and command timeouts, but those controls do not isolate untrusted code from the host system.

Do not run untrusted manifests, transforms, enumerators, or generators on your machine.

Use operating-system, virtual-machine, or container isolation when evaluating code you do not fully trust.
