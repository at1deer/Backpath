"use strict";

const fs = require("node:fs");
const path = require("node:path");

function findRepoRoot(startPath) {
  let current = fs.existsSync(startPath) && fs.statSync(startPath).isFile() ? path.dirname(startPath) : startPath;
  current = path.resolve(current);

  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(process.cwd());
    }
    current = parent;
  }
}

function portableArtifactPath(absPath, ctx) {
  const resolved = path.resolve(absPath);
  if (ctx.rootDir && isInside(ctx.rootDir, resolved)) {
    return path.relative(ctx.rootDir, resolved) || ".";
  }
  return resolved;
}

function portableCwd(absCwd, ctx) {
  const resolved = path.resolve(absCwd);
  if (ctx && ctx.baseDir && isInside(ctx.baseDir, resolved)) {
    return { cwd: path.relative(ctx.baseDir, resolved) || ".", cwdBase: "manifest" };
  }
  if (ctx && ctx.rootDir && isInside(ctx.rootDir, resolved)) {
    return { cwd: path.relative(ctx.rootDir, resolved) || ".", cwdBase: "repo" };
  }
  return { cwd: resolved };
}

function resolveStoredCwd(section, witnessPath, manifestPath) {
  const cwd = typeof section.cwd === "string" ? section.cwd : ".";
  if (path.isAbsolute(cwd)) {
    return cwd;
  }

  if (section.cwdBase === "manifest" && manifestPath) {
    return path.resolve(path.dirname(manifestPath), cwd);
  }

  if (section.cwdBase === "repo" && manifestPath) {
    return path.resolve(findRepoRoot(manifestPath), cwd);
  }

  return path.resolve(path.dirname(witnessPath), cwd);
}

function resolveManifestArtifact(witness, witnessPath) {
  const manifestValue = witness.artifacts && witness.artifacts.manifest;
  if (typeof manifestValue !== "string") {
    return null;
  }
  if (path.isAbsolute(manifestValue)) {
    return manifestValue;
  }

  const fromProcess = path.resolve(process.cwd(), manifestValue);
  if (fs.existsSync(fromProcess)) {
    return fromProcess;
  }

  const fromWitness = path.resolve(path.dirname(witnessPath), manifestValue);
  if (fs.existsSync(fromWitness)) {
    return fromWitness;
  }

  return fromProcess;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

module.exports = {
  findRepoRoot,
  portableArtifactPath,
  portableCwd,
  resolveManifestArtifact,
  resolveStoredCwd
};
