# Backpath Project Brief

## One-line description

Backpath finds what a transformation makes unrecoverable.

## Longer description

Backpath is a command-line transition-loss tool. Given source states, a forward transformation, optional reverse transformation, validation contracts, equivalence contracts, and a search strategy, Backpath produces minimized, reproducible witnesses showing where valid states are excluded, distinctions collide, return paths fail, alternate routes diverge, or pipeline edges first destroy a distinction.

## Non-goals

Backpath is not:

- a moral scoring system;
- a migration framework;
- a database-only rollback tester;
- a property-testing library replacement;
- a schema registry;
- a serialization benchmark;
- an ethical checklist;
- an MPE chatbot.

It should remain useful to a developer who has never read a word of Modal Path Ethics.

## Invention claim

The ingredients are not new: property-based testing, round-trip laws, schema validation, migration tooling, and metamorphic testing all exist.

Backpath's claim is the combination:

> black-box transition execution + explicit equivalence contracts + relational witness search + witness minimization + epistemic reporting + replayable artifacts.

The unit of output is not a score. The unit of output is a concrete witness.

## MVP slogan

> Find the smallest example your migration cannot honestly preserve.

## First build constraint

Use JSON and `argv` arrays first. Avoid YAML, shell strings, daemonized workers, dashboards, plugin systems, web UI, database adapters, or moral language in the initial implementation.
