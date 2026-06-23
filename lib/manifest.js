"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { findRepoRoot } = require("./pathing");
const { createAjv, formatAjvErrors } = require("./schema");

const SUPPORTED_OPERATIONS = new Set([
  "distinction-collision",
  "return-failure",
  "domain-exclusion",
  "compare-paths",
  "locate-loss"
]);

const IMPLEMENTED_OPERATIONS = new Set([
  "distinction-collision",
  "return-failure",
  "domain-exclusion",
  "compare-paths",
  "locate-loss"
]);

const EQUIVALENCE_MODES = new Set(["exact", "canonical", "structural", "predicate"]);
const IMPLEMENTED_EQUIVALENCE_MODES = new Set(["exact", "structural"]);
const SEARCH_MODES = new Set(["exhaustive", "generate", "corpus", "corpus-mutation"]);

class ManifestError extends Error {
  constructor(errors) {
    super(errors.join("\n"));
    this.name = "ManifestError";
    this.errors = errors;
  }
}

function loadManifest(inputPath) {
  const manifestPath = path.resolve(inputPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ManifestError([`manifest not found: ${manifestPath}`]);
    }
    throw new ManifestError([`manifest is not valid JSON: ${error.message}`]);
  }

  if (!isPlainObject(manifest)) {
    throw new ManifestError(["manifest must be a JSON object"]);
  }

  return {
    manifest,
    path: manifestPath,
    baseDir: path.dirname(manifestPath),
    rootDir: findRepoRoot(manifestPath)
  };
}

function loadJsonAt(inputPath) {
  return JSON.parse(fs.readFileSync(inputPath, "utf8"));
}

function validateManifest(manifest) {
  const errors = validateManifestWithAjv(manifest);
  for (const key of ["version", "operation"]) {
    if (!Object.prototype.hasOwnProperty.call(manifest, key)) {
      errors.push(`missing required field: ${key}`);
    }
  }

  if (manifest.version !== 1) {
    errors.push("version must be 1");
  }

  if (!SUPPORTED_OPERATIONS.has(manifest.operation)) {
    errors.push(`operation must be one of: ${Array.from(SUPPORTED_OPERATIONS).sort().join(", ")}`);
  }

  if (requiresForwardContract(manifest.operation)) {
    for (const key of ["source", "forward", "target", "search"]) {
      if (!Object.prototype.hasOwnProperty.call(manifest, key)) {
        errors.push(`${manifest.operation} requires ${key}`);
      }
    }
  }
  if (manifest.operation === "return-failure" && !Object.prototype.hasOwnProperty.call(manifest, "reverse")) {
    errors.push("return-failure requires reverse");
  }
  if (manifest.operation === "compare-paths" && !Object.prototype.hasOwnProperty.call(manifest, "paths")) {
    errors.push("compare-paths requires paths");
  }
  if (manifest.operation === "locate-loss" && !Object.prototype.hasOwnProperty.call(manifest, "inputWitness")) {
    errors.push("locate-loss requires inputWitness");
  }
  if (manifest.operation === "locate-loss" && !Object.prototype.hasOwnProperty.call(manifest, "pipeline")) {
    errors.push("locate-loss requires pipeline");
  }

  if (Object.prototype.hasOwnProperty.call(manifest, "source")) {
    validateDomain(manifest.source, "source", errors);
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "target")) {
    validateDomain(manifest.target, "target", errors);
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "forward")) {
    validateCommand(manifest.forward, "forward", errors);
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "reverse")) {
    validateCommand(manifest.reverse, "reverse", errors);
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "search")) {
    validateSearch(manifest.search, "search", errors);
  }

  if (Object.prototype.hasOwnProperty.call(manifest, "paths")) {
    validatePaths(manifest.paths, "paths", errors);
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "pipeline")) {
    validatePipeline(manifest.pipeline, "pipeline", errors);
  }

  return errors;
}

function requireValidManifest(ctx) {
  const errors = validateManifest(ctx.manifest);
  if (errors.length > 0) {
    throw new ManifestError(errors);
  }
}

function requireV0CheckSupport(ctx) {
  const { manifest } = ctx;
  if (!IMPLEMENTED_OPERATIONS.has(manifest.operation)) {
    const error = new Error(`operation '${manifest.operation}' is not implemented in the v0 prototype`);
    error.code = "BACKPATH_NOT_IMPLEMENTED";
    error.operation = operationToWitnessName(manifest.operation);
    throw error;
  }

  const errors = [];
  if (manifest.operation === "locate-loss" && manifest.search && manifest.search.mode !== "corpus") {
    errors.push("v0 check supports only search.mode='corpus'");
  }

  if (manifest.memory && manifest.memory.mode && manifest.memory.mode !== "none") {
    errors.push("v0.6 check does not yet support memory.mode='declared'");
  }

  if (manifest.operation !== "locate-loss") {
    if (!manifest.search) {
      errors.push("v0 check supports only search.mode='corpus'");
    } else if (manifest.search.mode !== "corpus") {
      errors.push("v0 check supports only search.mode='corpus'");
    }
    for (const label of ["source", "target"]) {
      const equivalence = manifest[label] && manifest[label].equivalence;
      if (!equivalence || !IMPLEMENTED_EQUIVALENCE_MODES.has(equivalence.mode)) {
        errors.push(`v0.6 check supports only ${label}.equivalence.mode='exact' or 'structural'`);
      }
    }
  }

  if (manifest.operation === "compare-paths") {
    for (const [pathIndex, pathSpec] of (manifest.paths || []).entries()) {
      const pathEquivalence = pathSpec.target && pathSpec.target.equivalence;
      if (!pathEquivalence || !IMPLEMENTED_EQUIVALENCE_MODES.has(pathEquivalence.mode)) {
        errors.push(`v0.6 check supports only paths[${pathIndex}].target.equivalence.mode='exact' or 'structural'`);
      }
      for (const [edgeIndex, edge] of (pathSpec.edges || []).entries()) {
        const edgeEquivalence = edge.target && edge.target.equivalence;
        if (!edgeEquivalence || !IMPLEMENTED_EQUIVALENCE_MODES.has(edgeEquivalence.mode)) {
          errors.push(`v0.6 check supports only paths[${pathIndex}].edges[${edgeIndex}].target.equivalence.mode='exact' or 'structural'`);
        }
      }
    }
  }

  if (manifest.operation === "locate-loss") {
    for (const [edgeIndex, edge] of (manifest.pipeline || []).entries()) {
      const edgeEquivalence = edge.target && edge.target.equivalence;
      if (!edgeEquivalence || !IMPLEMENTED_EQUIVALENCE_MODES.has(edgeEquivalence.mode)) {
        errors.push(`v0.6 check supports only pipeline[${edgeIndex}].target.equivalence.mode='exact' or 'structural'`);
      }
    }
  }

  if (errors.length > 0) {
    throw new ManifestError(errors);
  }
}

function operationToWitnessName(operation) {
  const operationNames = {
    "distinction-collision": "distinction_collision",
    "return-failure": "return_failure",
    "domain-exclusion": "domain_exclusion",
    "compare-paths": "path_divergence",
    "locate-loss": "loss_localization"
  };
  return operationNames[operation] || operation.replace(/-/g, "_");
}

function requiresForwardContract(operation) {
  return [
    "distinction-collision",
    "return-failure",
    "domain-exclusion",
    "compare-paths"
  ].includes(operation);
}

function corpusPaths(ctx) {
  const corpus = ctx.manifest.source && ctx.manifest.source.corpus;
  if (!Array.isArray(corpus)) {
    throw new ManifestError(["source.corpus is required for corpus mode"]);
  }
  return corpus.map((item) => resolveManifestPath(ctx, item));
}

function resolveManifestPath(ctx, value) {
  return path.isAbsolute(value) ? value : path.resolve(ctx.baseDir, value);
}

function validateDomain(value, pointer, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${pointer} must be an object`);
    return;
  }

  if (!isPlainObject(value.equivalence)) {
    errors.push(`${pointer}.equivalence must be an object`);
  } else {
    validateEquivalence(value.equivalence, `${pointer}.equivalence`, errors);
  }

  if (Object.prototype.hasOwnProperty.call(value, "corpus")) {
    if (!Array.isArray(value.corpus) || !value.corpus.every((item) => typeof item === "string")) {
      errors.push(`${pointer}.corpus must be an array of strings`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, "validator")) {
    validateCommand(value.validator, `${pointer}.validator`, errors);
  }
}

function validateEquivalence(value, pointer, errors) {
  if (!EQUIVALENCE_MODES.has(value.mode)) {
    errors.push(`${pointer}.mode must be one of: ${Array.from(EQUIVALENCE_MODES).sort().join(", ")}`);
  }
  if (value.mode === "canonical") {
    validateCommand(value.canonicalizer, `${pointer}.canonicalizer`, errors);
  }
  if (value.mode === "predicate") {
    validateCommand(value.predicate, `${pointer}.predicate`, errors);
  }
}

function validateCommand(value, pointer, errors) {
  if (typeof value === "string") {
    errors.push(`${pointer} must be a command object with argv, not a shell string`);
    return;
  }
  if (!isPlainObject(value)) {
    errors.push(`${pointer} must be an object`);
    return;
  }

  if (!Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((item) => typeof item === "string" && item.length > 0)) {
    errors.push(`${pointer}.argv must be a non-empty array of strings`);
  }

  if (Object.prototype.hasOwnProperty.call(value, "timeoutMs") && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1)) {
    errors.push(`${pointer}.timeoutMs must be a positive integer`);
  }

  if (Object.prototype.hasOwnProperty.call(value, "cwd") && typeof value.cwd !== "string") {
    errors.push(`${pointer}.cwd must be a string`);
  }

  if (Object.prototype.hasOwnProperty.call(value, "env")) {
    const env = value.env;
    if (!isPlainObject(env) || !Object.entries(env).every(([key, item]) => typeof key === "string" && typeof item === "string")) {
      errors.push(`${pointer}.env must be an object with string values`);
    }
  }
}

function validateSearch(value, pointer, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${pointer} must be an object`);
    return;
  }
  if (!SEARCH_MODES.has(value.mode)) {
    errors.push(`${pointer}.mode must be one of: ${Array.from(SEARCH_MODES).sort().join(", ")}`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "budget") && (!Number.isInteger(value.budget) || value.budget < 1)) {
    errors.push(`${pointer}.budget must be a positive integer`);
  }
}

function validatePaths(value, pointer, errors) {
  if (!Array.isArray(value) || value.length < 2) {
    errors.push(`${pointer} must be an array with at least two entries`);
    return;
  }

  value.forEach((item, index) => {
    const itemPointer = `${pointer}[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${itemPointer} must be an object`);
      return;
    }
    if (typeof item.name !== "string") {
      errors.push(`${itemPointer}.name must be a string`);
    }
    validatePipeline(item.edges, `${itemPointer}.edges`, errors);
    if (Object.prototype.hasOwnProperty.call(item, "target")) {
      validateDomain(item.target, `${itemPointer}.target`, errors);
    }
  });
}

function validatePipeline(value, pointer, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${pointer} must be a non-empty array`);
    return;
  }

  value.forEach((edge, index) => {
    const edgePointer = `${pointer}[${index}]`;
    if (!isPlainObject(edge)) {
      errors.push(`${edgePointer} must be an object`);
      return;
    }
    if (typeof edge.name !== "string") {
      errors.push(`${edgePointer}.name must be a string`);
    }
    validateCommand(edge.transform, `${edgePointer}.transform`, errors);
    if (Object.prototype.hasOwnProperty.call(edge, "source")) {
      validateDomain(edge.source, `${edgePointer}.source`, errors);
    }
    validateDomain(edge.target, `${edgePointer}.target`, errors);
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let manifestValidator = null;

function validateManifestWithAjv(manifest) {
  try {
    if (!manifestValidator) {
      const schemaPath = path.resolve(__dirname, "..", "schemas", "backpath-manifest.v1.schema.json");
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      manifestValidator = createAjv().compile(schema);
    }
    if (manifestValidator(manifest)) {
      return [];
    }
    return formatAjvErrors(manifestValidator.errors || []).map((error) => `schema ${error}`);
  } catch (error) {
    return [`manifest schema validation unavailable: ${error.message}`];
  }
}

module.exports = {
  ManifestError,
  corpusPaths,
  loadJsonAt,
  loadManifest,
  operationToWitnessName,
  requireV0CheckSupport,
  requireValidManifest,
  resolveManifestPath,
  validateManifest
};
