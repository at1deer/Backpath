#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");

const { checkManifest } = require("../lib/checks");
const { sortForJson } = require("../lib/equivalence");
const { loadManifest, ManifestError, requireValidManifest, validateManifest } = require("../lib/manifest");
const { loadWitness, ReplayError, replayWitness } = require("../lib/replay");

function main(argv) {
  const [command, file] = argv;

  if (!command || command === "-h" || command === "--help") {
    usage(command ? 0 : 2);
    return command ? 0 : 2;
  }

  if (!["validate", "check", "replay"].includes(command)) {
    printJson({ error: `unknown command: ${command}` });
    usage(2);
    return 2;
  }

  if (!file) {
    printJson({ error: `${command} requires a file path` });
    return 2;
  }

  if (command === "validate") {
    return validate(file);
  }
  if (command === "check") {
    return check(file);
  }
  return replay(file);
}

function validate(path) {
  let ctx;
  try {
    ctx = loadManifest(path);
  } catch (error) {
    if (error instanceof ManifestError) {
      printJson({ valid: false, errors: error.errors });
      return 2;
    }
    throw error;
  }

  const errors = validateManifest(ctx.manifest);
  if (errors.length > 0) {
    printJson({ valid: false, errors });
    return 2;
  }

  printJson({ valid: true, manifest: ctx.path });
  return 0;
}

function check(path) {
  let ctx;
  try {
    ctx = loadManifest(path);
    requireValidManifest(ctx);
    printJson(checkManifest(ctx));
    return 0;
  } catch (error) {
    if (error instanceof ManifestError) {
      printJson({ valid: false, errors: error.errors });
      return 2;
    }
    if (error && error.code === "BACKPATH_NOT_IMPLEMENTED") {
      printJson(indeterminateWitness(ctx, error));
      return 3;
    }
    throw error;
  }
}

function replay(path) {
  try {
    const { witness, path: witnessPath } = loadWitness(path);
    const result = replayWitness(witness, witnessPath);
    printJson(result);
    return result.replayed ? 0 : 1;
  } catch (error) {
    if (error instanceof ReplayError) {
      printJson({ status: "replay_failed", replayed: false, error: error.message });
      return 2;
    }
    throw error;
  }
}

function usage(exitCode) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write("Usage:\n");
  stream.write("  backpath validate manifest.json\n");
  stream.write("  backpath check manifest.json\n");
  stream.write("  backpath replay witness.json\n");
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function indeterminateWitness(ctx, error) {
  const manifest = ctx && ctx.manifest ? ctx.manifest : {};
  const digest = `sha256:${crypto.createHash("sha256").update(JSON.stringify(sortForJson(manifest))).digest("hex")}`;
  return {
    version: 1,
    operation: error.operation,
    status: "indeterminate",
    classification: "none",
    createdAt: new Date().toISOString(),
    contractDigest: digest,
    manifestDigest: digest,
    summary: error.message,
    diagnostics: [
      {
        classification: "not_implemented",
        message: error.message
      }
    ],
    artifacts: ctx && ctx.path ? { manifest: ctx.path } : {}
  };
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
