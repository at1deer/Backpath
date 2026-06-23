"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { equivalent, exactEquivalent } = require("./equivalence");
const { executeLossLocalization, executePathSet, pathDivergenceDetails } = require("./checks");
const { loadManifest } = require("./manifest");
const { resolveManifestArtifact, resolveStoredCwd } = require("./pathing");
const { runJsonCommand } = require("./runner");
const { compileSchemaFile, validateWithCompiled } = require("./schema");

class ReplayError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplayError";
  }
}

function loadWitness(inputPath) {
  const witnessPath = path.resolve(inputPath);
  let witness;
  try {
    witness = JSON.parse(fs.readFileSync(witnessPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ReplayError(`witness not found: ${witnessPath}`);
    }
    throw new ReplayError(`witness is not valid JSON: ${error.message}`);
  }

  if (!witness || typeof witness !== "object" || Array.isArray(witness)) {
    throw new ReplayError("witness must be a JSON object");
  }
  return { witness, path: witnessPath };
}

function replayWitness(witness, witnessPath) {
  if (witness.operation === "distinction_collision") {
    return replayDistinctionCollision(witness, witnessPath);
  }
  if (witness.operation === "return_failure") {
    return replayReturnFailure(witness, witnessPath);
  }
  if (witness.operation === "domain_exclusion") {
    return replayDomainExclusion(witness, witnessPath);
  }
  if (witness.operation === "path_divergence") {
    return replayPathDivergence(witness, witnessPath);
  }
  if (witness.operation === "loss_localization") {
    return replayLossLocalization(witness, witnessPath);
  }
  throw new ReplayError(`operation '${witness.operation}' cannot be replayed by the v0 prototype`);
}

function replayDistinctionCollision(witness, witnessPath) {
  const manifestPath = resolveManifestArtifact(witness, witnessPath);
  const ctx = loadReplayContext(manifestPath);
  const sourceA = witness.source && witness.source.a;
  const sourceB = witness.source && witness.source.b;
  const expectedA = witness.target && witness.target.a;
  const expectedB = witness.target && witness.target.b;
  const forwardCommand = commandFromSection(witness.forward || {}, witnessPath, manifestPath);
  const runA = runJsonCommand(forwardCommand.command, sourceA, forwardCommand.defaultCwd, forwardCommand.options);
  const runB = runJsonCommand(forwardCommand.command, sourceB, forwardCommand.defaultCwd, forwardCommand.options);
  const replayed =
    runA.succeeded &&
    runB.succeeded &&
    !sourceEquivalent(ctx, sourceA, sourceB) &&
    targetEquivalent(ctx, runA.output, expectedA) &&
    targetEquivalent(ctx, runB.output, expectedB) &&
    targetEquivalent(ctx, runA.output, runB.output);
  return result(witness, replayed, [runA.toEvidence(), runB.toEvidence()]);
}

function replayReturnFailure(witness, witnessPath) {
  const manifestPath = resolveManifestArtifact(witness, witnessPath);
  const ctx = loadReplayContext(manifestPath);
  const sourceValue = witness.source && witness.source.value;
  const targetValue = witness.target && witness.target.value;
  const returnedValue = witness.source && witness.source.returned;
  const forwardCommand = commandFromSection(witness.forward || {}, witnessPath, manifestPath);
  const reverseCommand = commandFromSection(witness.reverse || {}, witnessPath, manifestPath);
  const forwardRun = runJsonCommand(forwardCommand.command, sourceValue, forwardCommand.defaultCwd, forwardCommand.options);
  const reverseRun = forwardRun.succeeded
    ? runJsonCommand(reverseCommand.command, targetValue, reverseCommand.defaultCwd, reverseCommand.options)
    : null;
  const replayed = replayedReturnClassification(ctx, witness, sourceValue, targetValue, returnedValue, forwardRun, reverseRun, manifestPath);
  const runs = [forwardRun.toEvidence()];
  if (reverseRun) {
    runs.push(reverseRun.toEvidence());
  }
  return result(witness, replayed, runs);
}

function replayDomainExclusion(witness, witnessPath) {
  const manifestPath = resolveManifestArtifact(witness, witnessPath);
  const ctx = loadReplayContext(manifestPath);
  const sourceValue = witness.source && witness.source.value;
  const expectedTarget = witness.target && witness.target.value;
  const forwardCommand = commandFromSection(witness.forward || {}, witnessPath, manifestPath);
  const run = runJsonCommand(forwardCommand.command, sourceValue, forwardCommand.defaultCwd, forwardCommand.options);
  const classification = witness.classification;
  const replayed =
    (classification === "timeout" && run.timeout) ||
    (classification === "transform_crash" && Boolean(run.executionError)) ||
    (classification === "source_rejected" && run.exitCode !== null && run.exitCode !== 0) ||
    (classification === "malformed_output" && run.malformedOutput) ||
    (classification === "invalid_target" && run.succeeded && invalidTargetReplay(ctx, run.output, expectedTarget, manifestPath));
  return result(witness, replayed, [run.toEvidence()]);
}

function replayPathDivergence(witness, witnessPath) {
  const manifestPath = resolveManifestArtifact(witness, witnessPath);
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new ReplayError("path_divergence replay requires artifacts.manifest");
  }

  const ctx = loadManifest(manifestPath);
  const sourceValue = witness.source && witness.source.value;
  const pathResults = executePathSet(ctx, sourceValue);
  const divergence = pathDivergenceDetails(ctx, pathResults);
  const replayed = samePathDivergenceWitness(ctx, witness, divergence, pathResults);
  return result(witness, replayed, [], { paths: pathResults });
}

function replayLossLocalization(witness, witnessPath) {
  const manifestPath = resolveManifestArtifact(witness, witnessPath);
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new ReplayError("loss_localization replay requires artifacts.manifest");
  }

  const ctx = loadManifest(manifestPath);
  const sourceA = witness.source && witness.source.a;
  const sourceB = witness.source && witness.source.b;
  const evaluation = executeLossLocalization(ctx, sourceA, sourceB);
  const replayed = sameLossLocalizationWitness(witness, evaluation);
  return result(witness, replayed, [], {
    pipeline: evaluation.pipeline,
    localization: {
      firstLossEdge: evaluation.firstLossEdge || null
    },
    target: {
      valueA: evaluation.targetValueA,
      valueB: evaluation.targetValueB,
      differencePaths: evaluation.targetDifferencePaths || []
    }
  });
}

function replayedReturnClassification(ctx, witness, sourceValue, targetValue, returnedValue, forwardRun, reverseRun, manifestPath) {
  if (witness.classification === "forward_excluded") {
    return !forwardRun.succeeded;
  }

  if (!forwardRun.succeeded || !targetEquivalent(ctx, forwardRun.output, targetValue) || reverseRun === null) {
    return false;
  }

  if (witness.classification === "stranded_successor") {
    return reverseRun.timeout || reverseRun.executionError || (reverseRun.exitCode !== null && reverseRun.exitCode !== 0);
  }
  if (witness.classification === "malformed_output") {
    return reverseRun.malformedOutput;
  }
  if (witness.classification === "invalid_return") {
    return reverseRun.succeeded && invalidSourceReplay(ctx, reverseRun.output, returnedValue, manifestPath);
  }
  if (witness.classification === "return_drift") {
    return (
      reverseRun.succeeded &&
      sourceEquivalent(ctx, reverseRun.output, returnedValue) &&
      !sourceEquivalent(ctx, sourceValue, reverseRun.output)
    );
  }
  return false;
}

function invalidTargetReplay(ctx, output, expectedTarget, manifestPath) {
  if (!targetEquivalent(ctx, output, expectedTarget)) {
    return false;
  }
  const validators = manifestValidators(manifestPath);
  return validators.target ? !validateWithCompiled(validators.target, output).valid : true;
}

function invalidSourceReplay(ctx, output, expectedReturn, manifestPath) {
  if (!sourceEquivalent(ctx, output, expectedReturn)) {
    return false;
  }
  const validators = manifestValidators(manifestPath);
  return validators.source ? !validateWithCompiled(validators.source, output).valid : true;
}

function samePathDivergenceWitness(ctx, witness, divergence, pathResults) {
  if (!divergence) {
    return false;
  }

  const diagnostic = Array.isArray(witness.diagnostics)
    ? witness.diagnostics.find((item) => item.subtype === "route_failure" || item.subtype === "terminal_mismatch")
    : null;

  if (diagnostic && diagnostic.subtype === "route_failure") {
    if (divergence.subtype !== "route_failure") {
      return false;
    }
    return (
      sameSorted(diagnostic.succeededPaths || [], divergence.reached.map((item) => item.name)) &&
      exactEquivalent(
        normalizeFailedPaths(diagnostic.failedPaths || []),
        normalizeFailedPaths(divergence.failed.map((item) => ({
          name: item.name,
          edge: item.failure && item.failure.edge,
          classification: item.failure && item.failure.classification
        })))
      )
    );
  }

  if (divergence.subtype !== "terminal_mismatch") {
    return false;
  }

  const expectedTerminals = new Map(
    (witness.paths || [])
      .filter((pathResult) => pathResult.terminal && pathResult.terminal.reached)
      .map((pathResult) => [pathResult.name, pathResult.terminal.value])
  );

  return pathResults
    .filter((pathResult) => pathResult.terminal.reached)
    .every((pathResult) => (
      expectedTerminals.has(pathResult.name) &&
      targetEquivalent(ctx, pathResult.terminal.value, expectedTerminals.get(pathResult.name))
    ));
}

function sameLossLocalizationWitness(witness, evaluation) {
  if (!evaluation || witness.status !== evaluation.status || witness.classification !== evaluation.classification) {
    return false;
  }

  const expectedFirstLossEdge = witness.localization && witness.localization.firstLossEdge
    ? witness.localization.firstLossEdge
    : null;
  if (expectedFirstLossEdge !== (evaluation.firstLossEdge || null)) {
    return false;
  }

  return exactEquivalent(
    lossPipelineShape(witness.pipeline || []),
    lossPipelineShape(evaluation.pipeline || [])
  );
}

function lossPipelineShape(pipeline) {
  return pipeline.map((edge) => ({
    name: edge.name,
    beforeEquivalent: edge.beforeEquivalent,
    afterEquivalent: Object.prototype.hasOwnProperty.call(edge, "afterEquivalent") ? edge.afterEquivalent : null,
    classification: edge.classification || null
  }));
}

function sameSorted(left, right) {
  return exactEquivalent(left.slice().sort(), right.slice().sort());
}

function normalizeFailedPaths(paths) {
  return paths
    .map((item) => ({
      name: item.name,
      edge: item.edge || null,
      classification: item.classification || null
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function commandFromSection(section, witnessPath, manifestPath) {
  if (!Array.isArray(section.argv) || !section.argv.every((item) => typeof item === "string")) {
    throw new ReplayError("witness command section is missing argv");
  }

  const defaultCwd = manifestPath ? path.dirname(manifestPath) : path.dirname(witnessPath);
  const command = {
    argv: section.argv,
    timeoutMs: section.timeoutMs || 2000
  };
  if (
    section.environment &&
    section.environment.declared &&
    Object.keys(section.environment.declared).length > 0
  ) {
    command.env = section.environment.declared;
  }
  if (typeof section.cwd === "string") {
    command.cwd = resolveStoredCwd(section, witnessPath, manifestPath);
  } else {
    command.cwd = defaultCwd;
  }

  const cleanRoom = section.isolation === "fresh-process-clean-tempdir";
  return {
    command,
    defaultCwd,
    options: {
      stage: section.stage,
      isolation: section.isolation || null,
      cleanTempCwd: cleanRoom,
      argvBaseDir: defaultCwd
    }
  };
}

function loadReplayContext(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return loadManifest(manifestPath);
  } catch (_error) {
    return null;
  }
}

function sourceEquivalent(ctx, left, right) {
  return equivalent(left, right, ctx && ctx.manifest && ctx.manifest.source && ctx.manifest.source.equivalence);
}

function targetEquivalent(ctx, left, right) {
  return equivalent(left, right, ctx && ctx.manifest && ctx.manifest.target && ctx.manifest.target.equivalence);
}

function manifestValidators(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return { source: null, target: null };
  }

  try {
    const ctx = loadManifest(manifestPath);
    return {
      source: ctx.manifest.source && ctx.manifest.source.schema
        ? compileSchemaFile(path.resolve(ctx.baseDir, ctx.manifest.source.schema))
        : null,
      target: ctx.manifest.target && ctx.manifest.target.schema
        ? compileSchemaFile(path.resolve(ctx.baseDir, ctx.manifest.target.schema))
        : null
    };
  } catch (_error) {
    return { source: null, target: null };
  }
}

function result(witness, replayed, runs, extra = {}) {
  return {
    version: 1,
    status: replayed ? "replayed" : "replay_failed",
    replayed,
    operation: witness.operation,
    classification: witness.classification,
    runs,
    ...extra
  };
}

module.exports = {
  ReplayError,
  loadWitness,
  replayWitness
};
