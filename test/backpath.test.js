"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { domainExclusionClassification } = require("../lib/checks");
const { compileSchemaFile, validateWithCompiled } = require("../lib/schema");
const { jsonCostForPair, jsonCostForState } = require("../lib/shrinker");

const repoRoot = path.resolve(__dirname, "..");
const cli = path.join(repoRoot, "bin", "backpath.js");
const witnessSchema = compileSchemaFile(path.join(repoRoot, "schemas", "backpath-witness.v1.schema.json"));

test("validate accepts example manifests", () => {
  for (const manifest of [
    "examples/manifests/distinction-collision.approval.json",
    "examples/manifests/return-failure.approval.json",
    "examples/manifests/domain-exclusion.status.json",
    "examples/manifests/compare-paths.role.json",
    "examples/manifests/locate-loss.account-type.json",
    "examples/manifests/distinction-collision.noisy-approval.json",
    "examples/manifests/return-failure.noisy-approval.json",
    "examples/manifests/domain-exclusion.noisy-status.json",
    "examples/manifests/distinction-collision.username-exact.json",
    "examples/manifests/distinction-collision.username-structural-source.json",
    "examples/manifests/distinction-collision.username-target-structural.json",
    "examples/manifests/distinction-collision.tags-exact.json",
    "examples/manifests/distinction-collision.tags-structural-source.json",
    "examples/manifests/compare-paths.generated-at-exact.json",
    "examples/manifests/compare-paths.generated-at-structural-target.json"
  ]) {
    const result = runJson(["validate", manifest]);
    assert.equal(result.json.valid, true, manifest);
  }
});

test("required checks emit expected classifications", () => {
  assert.equal(
    runJson(["check", "examples/manifests/distinction-collision.approval.json"]).json.classification,
    "distinction_collision"
  );
  assert.equal(
    runJson(["check", "examples/manifests/return-failure.approval.json"]).json.classification,
    "return_drift"
  );
  assert.equal(
    runJson(["check", "examples/manifests/domain-exclusion.status.json"]).json.classification,
    "source_rejected"
  );
});

test("compare-paths role example emits path_divergence", () => {
  const witness = runJson(["check", "examples/manifests/compare-paths.role.json"]).json;
  assert.equal(witness.operation, "path_divergence");
  assert.equal(witness.classification, "path_divergence");
  assert.equal(witness.status, "witnessed");
});

test("locate-loss account type example emits loss_localized", () => {
  const witness = runJson(["check", "examples/manifests/locate-loss.account-type.json"]).json;
  assert.equal(witness.operation, "loss_localization");
  assert.equal(witness.classification, "loss_localized");
  assert.equal(witness.status, "witnessed");
});

test("exact equivalence behavior remains unchanged for structural examples", () => {
  const username = runJson(["check", "examples/manifests/distinction-collision.username-exact.json"]).json;
  const generated = runJson(["check", "examples/manifests/compare-paths.generated-at-exact.json"]).json;

  assert.equal(username.classification, "distinction_collision");
  assert.equal(username.source.equivalence, "exact");
  assert.equal(generated.classification, "path_divergence");
  assert.deepEqual(generated.target.differencePaths, ["/generatedAt"]);
});

test("structural lowercase normalizer prevents false collision", () => {
  const witness = runJson(["check", "examples/manifests/distinction-collision.username-structural-source.json"]).json;

  assert.equal(witness.operation, "distinction_collision");
  assert.equal(witness.status, "not_found_within_budget");
  assert.equal(witness.classification, "none");
  assert.equal(witness.source.equivalence, "structural");
});

test("structural unorderedPaths treats arrays as equivalent", () => {
  const exact = runJson(["check", "examples/manifests/distinction-collision.tags-exact.json"]).json;
  const structural = runJson(["check", "examples/manifests/distinction-collision.tags-structural-source.json"]).json;

  assert.equal(exact.classification, "distinction_collision");
  assert.deepEqual(exact.source.differencePaths, ["/tags/0", "/tags/1"]);
  assert.equal(structural.status, "not_found_within_budget");
  assert.equal(structural.classification, "none");
  assert.equal(structural.source.equivalence, "structural");
});

test("structural ignorePaths prevents false path_divergence", () => {
  const witness = runJson(["check", "examples/manifests/compare-paths.generated-at-structural-target.json"]).json;

  assert.equal(witness.operation, "path_divergence");
  assert.equal(witness.status, "not_found_within_budget");
  assert.equal(witness.classification, "none");
  assert.equal(witness.target.equivalence, "structural");
});

test("return_drift respects structural source equivalence", () => {
  const fixture = createStructuralReturnFixture({
    sourceEquivalence: {
      mode: "structural",
      normalizers: {
        "/username": "lowercase"
      }
    }
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.operation, "return_failure");
  assert.equal(witness.status, "not_found_within_budget");
  assert.equal(witness.classification, "none");
  assert.equal(witness.source.equivalence, "structural");
});

test("memory.mode declared validates but check rejects unsupported retained memory", () => {
  const fixture = createFixture({
    operation: "return-failure",
    memory: {
      mode: "declared"
    }
  });

  const validation = runJson(["validate", fixture.manifest]);
  assert.equal(validation.json.valid, true);

  const rejected = runJson(["check", fixture.manifest], { allowExit: 2 });
  assert.equal(rejected.json.valid, false);
  assert.ok(rejected.json.errors.includes("v0.6 check does not yet support memory.mode='declared'"));
});

test("replay respects structural equivalence", () => {
  const witness = runJson(["check", "examples/manifests/distinction-collision.username-target-structural.json"]).json;

  assert.equal(witness.classification, "distinction_collision");
  assert.equal(witness.target.equivalence, "structural");
  assert.match(witness.summary, /declared target equivalence/);
  assert.equal(witness.summary.includes("exact-equivalent"), false);
  assertReplay(witness, "distinction_collision");
});

test("emitted witnesses validate against witness schema", () => {
  const witnesses = [
    runJson(["check", "examples/manifests/distinction-collision.approval.json"]).json,
    runJson(["check", "examples/manifests/return-failure.approval.json"]).json,
    runJson(["check", "examples/manifests/domain-exclusion.status.json"]).json,
    runJson(["check", "examples/manifests/compare-paths.role.json"]).json,
    runJson(["check", "examples/manifests/locate-loss.account-type.json"]).json
  ];

  assert.deepEqual(
    witnesses.map((witness) => witness.classification),
    ["distinction_collision", "return_drift", "source_rejected", "path_divergence", "loss_localized"]
  );
  for (const witness of witnesses) {
    assertWitnessSchema(witness);
  }
});

test("shrink.enabled=false preserves not_attempted minimality", () => {
  const fixture = createFixture({
    operation: "domain-exclusion",
    forwardCode: "process.stderr.write('reject\\n'); process.exitCode = 12;",
    shrink: {
      enabled: false,
      budget: 100,
      preserveClassification: true
    }
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.classification, "source_rejected");
  assert.equal(witness.minimality.kind, "not_attempted");
  assertWitnessSchema(witness);
});

test("noisy distinction-collision shrinks to fewer difference paths", () => {
  const originalA = readJson("examples/corpus/approval_noisy_manual.json");
  const originalB = readJson("examples/corpus/approval_noisy_automatic.json");
  const witness = runJson(["check", "examples/manifests/distinction-collision.noisy-approval.json"]).json;
  const originalDifferenceCount = jsonCostForPair(originalA, originalB)[0];

  assert.equal(witness.classification, "distinction_collision");
  assert.equal(witness.minimality.kind, "local_fixed_point");
  assert.deepEqual(witness.source.differencePaths, ["/approval"]);
  assert.ok(witness.source.differencePaths.length < originalDifferenceCount);
  assert.deepEqual(witness.source.a, { approval: "manual" });
  assert.deepEqual(witness.source.b, { approval: "automatic" });
  assert.ok(shrinkDiagnostic(witness).shrinkAccepted > 0);
  assertWitnessSchema(witness);
  assertReplay(witness, "distinction_collision");
});

test("noisy return-failure shrinks source cost while preserving return_drift", () => {
  const original = readJson("examples/corpus/approval_noisy_automatic.json");
  const witness = runJson(["check", "examples/manifests/return-failure.noisy-approval.json"]).json;

  assert.equal(witness.classification, "return_drift");
  assert.equal(witness.minimality.kind, "local_fixed_point");
  assert.ok(jsonCostForState(witness.source.value)[1] < jsonCostForState(original)[1]);
  assert.deepEqual(witness.source.value, { approval: "automatic" });
  assert.deepEqual(witness.source.returned, { approval: "manual" });
  assert.ok(shrinkDiagnostic(witness).shrinkAccepted > 0);
  assertWitnessSchema(witness);
  assertReplay(witness, "return_drift");
});

test("noisy domain-exclusion shrinks source cost while preserving source_rejected", () => {
  const original = readJson("examples/corpus/status_noisy_pending_review.json");
  const witness = runJson(["check", "examples/manifests/domain-exclusion.noisy-status.json"]).json;

  assert.equal(witness.classification, "source_rejected");
  assert.equal(witness.minimality.kind, "local_fixed_point");
  assert.ok(jsonCostForState(witness.source.value)[1] < jsonCostForState(original)[1]);
  assert.deepEqual(witness.source.value, { status: "pending_review" });
  assert.ok(shrinkDiagnostic(witness).shrinkAccepted > 0);
  assertWitnessSchema(witness);
  assertReplay(witness, "source_rejected");
});

test("shrink budget is respected", () => {
  const fixture = createFixture({
    operation: "domain-exclusion",
    forwardCode: "process.stderr.write('reject\\n'); process.exitCode = 12;",
    shrink: {
      enabled: true,
      budget: 1,
      preserveClassification: true
    }
  });

  const witness = runJson(["check", fixture.manifest]).json;
  const diagnostic = shrinkDiagnostic(witness);
  assert.equal(witness.classification, "source_rejected");
  assert.equal(witness.minimality.kind, "budget_exhausted");
  assert.equal(diagnostic.shrinkAttempts, 1);
  assert.equal(diagnostic.shrinkBudgetExhausted, true);
  assertWitnessSchema(witness);
});

test("terminal mismatch includes both path terminals", () => {
  const witness = runJson(["check", "examples/manifests/compare-paths.role.json"]).json;
  const terminals = new Map(witness.paths.map((pathResult) => [pathResult.name, pathResult.terminal.value]));

  assert.deepEqual(terminals.get("v1-v2-v4"), { name: "Mara", role: "member" });
  assert.deepEqual(terminals.get("v1-v3-v4"), { name: "Mara" });
  assert.deepEqual(witness.target.differencePaths, ["/role"]);
});

test("valid source rejected emits source_rejected", () => {
  const fixture = createFixture({
    operation: "domain-exclusion",
    forwardCode: "process.stderr.write('reject\\n'); process.exitCode = 12;"
  });

  assert.equal(runJson(["check", fixture.manifest]).json.classification, "source_rejected");
});

test("forward non-JSON stdout emits malformed_output", () => {
  const fixture = createFixture({
    operation: "domain-exclusion",
    forwardCode: "process.stdout.write('not json\\n');"
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.classification, "malformed_output");
  assert.equal(witness.forward.stage, "forward");
  assert.equal(witness.forward.malformedOutput, true);
});

test("forward parseable invalid target emits invalid_target", () => {
  const fixture = createFixture({
    operation: "domain-exclusion",
    forwardCode: "process.stdout.write(JSON.stringify({ approved: 'yes' }) + '\\n');"
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.classification, "invalid_target");
  assert.equal(witness.target.validation.valid, false);
});

test("signal or null-status abnormal forward termination is transform_crash", () => {
  assert.equal(
    domainExclusionClassification({
      timeout: false,
      executionError: null,
      signal: "SIGTERM",
      exitCode: null,
      malformedOutput: false
    }),
    "transform_crash"
  );
});

test("reverse rejects valid target emits stranded_successor", () => {
  const fixture = createFixture({
    operation: "return-failure",
    reverseCode: "process.stderr.write('no return\\n'); process.exitCode = 12;"
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.classification, "stranded_successor");
  assert.equal(witness.reverse.stage, "reverse");
  assert.equal(witness.reverse.isolation, "fresh-process-clean-tempdir");
});

test("reverse non-JSON stdout emits malformed_output with reverse evidence", () => {
  const fixture = createFixture({
    operation: "return-failure",
    reverseCode: "process.stdout.write('not json\\n');"
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.classification, "malformed_output");
  assert.equal(witness.reverse.stage, "reverse");
  assert.equal(witness.reverse.malformedOutput, true);
});

test("reverse parseable invalid source emits invalid_return", () => {
  const fixture = createFixture({
    operation: "return-failure",
    reverseCode: "process.stdout.write(JSON.stringify({ approval: 123 }) + '\\n');"
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.classification, "invalid_return");
  assert.equal(witness.source.validation.valid, false);
});

test("reverse valid non-equivalent source emits return_drift", () => {
  const fixture = createFixture({
    operation: "return-failure",
    reverseCode: "process.stdout.write(JSON.stringify({ approval: 'manual' }) + '\\n');"
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.classification, "return_drift");
  assert.deepEqual(witness.source.differencePaths, ["/approval"]);
});

test("reverse clean-room cwd does not expose files written by forward", () => {
  const fixture = createFixture({
    operation: "return-failure",
    forwardCode: [
      "const fs = require('node:fs');",
      "fs.writeFileSync('forward-state.txt', 'ambient');",
      "process.stdout.write(JSON.stringify({ approved: true }) + '\\n');"
    ].join(" "),
    reverseCode: [
      "const fs = require('node:fs');",
      "if (fs.existsSync('forward-state.txt')) {",
      "  process.stdout.write(JSON.stringify({ approval: 'automatic' }) + '\\n');",
      "} else {",
      "  process.stderr.write('missing forward-state.txt\\n');",
      "  process.exitCode = 12;",
      "}"
    ].join(" ")
  });

  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.classification, "stranded_successor");
  assert.equal(witness.reverse.stage, "reverse");
  assert.equal(witness.reverse.isolation, "fresh-process-clean-tempdir");
});

test("route failure emits path_divergence with route_failure diagnostic", () => {
  const fixture = createCompareFixture({
    rightCode: "process.stderr.write('route failed\\n'); process.exitCode = 12;"
  });

  const witness = runJson(["check", fixture.manifest]).json;
  const routeFailure = witness.diagnostics.find((item) => item.subtype === "route_failure");
  assert.equal(witness.operation, "path_divergence");
  assert.equal(witness.classification, "path_divergence");
  assert.ok(routeFailure);
  assert.deepEqual(routeFailure.succeededPaths, ["left"]);
  assert.deepEqual(routeFailure.failedPaths, [
    {
      name: "right",
      edge: "right-edge",
      classification: "source_rejected"
    }
  ]);
});

test("path edge invalid target is captured in edge evidence", () => {
  const fixture = createCompareFixture({
    rightCode: "process.stdout.write(JSON.stringify({ approved: 'yes' }) + '\\n');"
  });

  const witness = runJson(["check", fixture.manifest]).json;
  const right = witness.paths.find((pathResult) => pathResult.name === "right");
  assert.equal(witness.classification, "path_divergence");
  assert.equal(right.edges[0].classification, "invalid_target");
  assert.equal(right.edges[0].validation.valid, false);
});

test("replay can rerun a path_divergence witness", () => {
  const witness = runJson(["check", "examples/manifests/compare-paths.role.json"]).json;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpath-path-"));
  const witnessPath = path.join(tempDir, "witness.json");
  fs.writeFileSync(witnessPath, JSON.stringify(witness, null, 2));

  const replay = runJson(["replay", witnessPath]).json;
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation, "path_divergence");
  assert.equal(replay.classification, "path_divergence");
});

test("locate-loss firstLossEdge is correct", () => {
  const witness = runJson(["check", "examples/manifests/locate-loss.account-type.json"]).json;
  assert.equal(witness.localization.firstLossEdge, "edge-2-restrict");
  assert.deepEqual(witness.localization.previousDifferencePaths, ["/accountType"]);
  assert.deepEqual(witness.localization.collapsedTarget, { restricted: true });
});

test("locate-loss pipeline evidence includes every edge through loss", () => {
  const witness = runJson(["check", "examples/manifests/locate-loss.account-type.json"]).json;
  assert.deepEqual(
    witness.pipeline.map((edge) => edge.name),
    ["edge-1-preserve-account-type", "edge-2-restrict"]
  );
  assert.equal(witness.pipeline[0].beforeEquivalent, false);
  assert.equal(witness.pipeline[0].afterEquivalent, false);
  assert.equal(witness.pipeline[1].beforeEquivalent, false);
  assert.equal(witness.pipeline[1].afterEquivalent, true);
  assert.equal(witness.pipeline[1].commandA.stage, "pipeline");
  assert.equal(witness.pipeline[1].validation.a.valid, true);
  assert.equal(witness.search.evaluatedSourceStates, 2);
  assert.equal(witness.search.evaluatedEdges, 2);
  assert.equal(witness.search.evaluatedEdgeExecutions, 4);
  assert.equal(witness.search.evaluatedPairs, 2);
  assert.equal(witness.search.pipelineExhausted, false);
});

test("locate-loss no-loss pipeline returns not_found_within_budget", () => {
  const fixture = createLocateLossFixture({ mode: "no-loss" });
  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.operation, "loss_localization");
  assert.equal(witness.status, "not_found_within_budget");
  assert.equal(witness.classification, "none");
  assert.equal(witness.diagnostics[0].classification, "no-loss-found");
  assert.equal(witness.pipeline.length, 2);
  assert.equal(witness.search.evaluatedSourceStates, 2);
  assert.equal(witness.search.evaluatedEdges, 2);
  assert.equal(witness.search.evaluatedEdgeExecutions, 4);
  assert.equal(witness.search.evaluatedPairs, 2);
  assert.equal(witness.search.pipelineExhausted, true);
});

test("locate-loss edge failure returns indeterminate with edge evidence", () => {
  const fixture = createLocateLossFixture({ mode: "edge-failure" });
  const witness = runJson(["check", fixture.manifest]).json;
  assert.equal(witness.operation, "loss_localization");
  assert.equal(witness.status, "indeterminate");
  assert.equal(witness.classification, "none");
  assert.equal(witness.pipeline.length, 2);
  assert.equal(witness.pipeline[1].name, "edge-2-fail");
  assert.equal(witness.pipeline[1].classification, "source_rejected");
  assert.equal(witness.pipeline[1].failure.a, "source_rejected");
  assert.equal(witness.diagnostics[0].classification, "edge_failure");
});

test("replay can rerun a loss_localization witness", () => {
  const witness = runJson(["check", "examples/manifests/locate-loss.account-type.json"]).json;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpath-loss-"));
  const witnessPath = path.join(tempDir, "witness.json");
  fs.writeFileSync(witnessPath, JSON.stringify(witness, null, 2));

  const replay = runJson(["replay", witnessPath]).json;
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation, "loss_localization");
  assert.equal(replay.classification, "loss_localized");
  assert.equal(replay.localization.firstLossEdge, "edge-2-restrict");
});

test("replay can rerun an emitted witness", () => {
  const witness = runJson(["check", "examples/manifests/distinction-collision.approval.json"]).json;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpath-"));
  const witnessPath = path.join(tempDir, "witness.json");
  fs.writeFileSync(witnessPath, JSON.stringify(witness, null, 2));

  const replay = runJson(["replay", witnessPath]).json;
  assert.equal(replay.replayed, true);
  assert.equal(replay.classification, "distinction_collision");
});

function createFixture({ operation, forwardCode, reverseCode, shrink, memory }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpath-contract-"));
  writeJson(path.join(dir, "source.schema.json"), {
    type: "object",
    additionalProperties: false,
    required: ["approval"],
    properties: {
      approval: { enum: ["manual", "automatic", "rejected"] }
    }
  });
  writeJson(path.join(dir, "target.schema.json"), {
    type: "object",
    additionalProperties: false,
    required: ["approved"],
    properties: {
      approved: { type: "boolean" }
    }
  });
  writeJson(path.join(dir, "source.json"), { approval: "automatic" });

  fs.writeFileSync(
    path.join(dir, "forward.js"),
    forwardCode || "process.stdout.write(JSON.stringify({ approved: true }) + '\\n');"
  );
  if (operation === "return-failure") {
    fs.writeFileSync(
      path.join(dir, "reverse.js"),
      reverseCode || "process.stdout.write(JSON.stringify({ approval: 'automatic' }) + '\\n');"
    );
  }

  const manifest = {
    version: 1,
    operation,
    source: {
      schema: "source.schema.json",
      corpus: ["source.json"],
      equivalence: { mode: "exact" }
    },
    forward: {
      argv: [process.execPath, "forward.js"],
      timeoutMs: 2000
    },
    target: {
      schema: "target.schema.json",
      equivalence: { mode: "exact" }
    },
    search: {
      mode: "corpus",
      budget: 100
    },
    replay: {
      forward: 1,
      reverse: 1,
      equivalence: 1
    }
  };

  if (operation === "return-failure") {
    manifest.reverse = {
      argv: [process.execPath, "reverse.js"],
      timeoutMs: 2000
    };
    manifest.context = {
      reverseIsolation: "fresh-process-clean-tempdir"
    };
  }
  if (memory) {
    manifest.memory = memory;
  }
  if (shrink) {
    manifest.shrink = shrink;
  }

  const manifestPath = path.join(dir, "manifest.json");
  writeJson(manifestPath, manifest);
  return { dir, manifest: manifestPath };
}

function createStructuralReturnFixture({ sourceEquivalence }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpath-structural-return-"));
  writeJson(path.join(dir, "source.schema.json"), {
    type: "object",
    additionalProperties: false,
    required: ["username"],
    properties: {
      username: { type: "string" }
    }
  });
  writeJson(path.join(dir, "target.schema.json"), {
    type: "object",
    additionalProperties: false,
    required: ["username"],
    properties: {
      username: { type: "string" }
    }
  });
  writeJson(path.join(dir, "source.json"), { username: "Aidan" });
  fs.writeFileSync(
    path.join(dir, "forward.js"),
    [
      "const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
      "process.stdout.write(JSON.stringify({ username: input.username }) + '\\n');"
    ].join(" ")
  );
  fs.writeFileSync(
    path.join(dir, "reverse.js"),
    "process.stdout.write(JSON.stringify({ username: 'aidan' }) + '\\n');"
  );

  const manifest = {
    version: 1,
    operation: "return-failure",
    source: {
      schema: "source.schema.json",
      corpus: ["source.json"],
      equivalence: sourceEquivalence
    },
    forward: {
      argv: [process.execPath, "forward.js"],
      timeoutMs: 2000
    },
    target: {
      schema: "target.schema.json",
      equivalence: { mode: "exact" }
    },
    reverse: {
      argv: [process.execPath, "reverse.js"],
      timeoutMs: 2000
    },
    context: {
      reverseIsolation: "fresh-process-clean-tempdir"
    },
    search: {
      mode: "corpus",
      budget: 100
    },
    replay: {
      forward: 1,
      reverse: 1,
      equivalence: 1
    }
  };

  const manifestPath = path.join(dir, "manifest.json");
  writeJson(manifestPath, manifest);
  return { dir, manifest: manifestPath };
}

function createLocateLossFixture({ mode } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpath-locate-"));
  writeJson(path.join(dir, "input-witness.json"), {
    version: 1,
    operation: "distinction_collision",
    status: "witnessed",
    classification: "distinction_collision",
    createdAt: "2026-06-20T00:00:00Z",
    contractDigest: "sha256:test",
    manifestDigest: "sha256:test",
    source: {
      equivalence: "exact",
      a: { accountType: "minor" },
      b: { accountType: "dependent" },
      differencePaths: ["/accountType"]
    },
    target: {
      equivalence: "exact",
      a: { restricted: true },
      b: { restricted: true }
    },
    diagnostics: [],
    artifacts: {}
  });
  writeJson(path.join(dir, "account.schema.json"), {
    type: "object",
    additionalProperties: false,
    required: ["accountType"],
    properties: {
      accountType: { enum: ["minor", "dependent"] }
    }
  });
  writeJson(path.join(dir, "restricted.schema.json"), {
    type: "object",
    additionalProperties: false,
    required: ["restricted"],
    properties: {
      restricted: { type: "boolean" }
    }
  });
  fs.writeFileSync(
    path.join(dir, "preserve.js"),
    [
      "const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
      "process.stdout.write(JSON.stringify({ accountType: input.accountType }) + '\\n');"
    ].join(" ")
  );
  fs.writeFileSync(
    path.join(dir, "collapse.js"),
    "process.stdout.write(JSON.stringify({ restricted: true }) + '\\n');"
  );
  fs.writeFileSync(
    path.join(dir, "fail.js"),
    "process.stderr.write('edge failed\\n'); process.exitCode = 12;"
  );

  const accountTarget = {
    schema: "account.schema.json",
    equivalence: { mode: "exact" }
  };
  const restrictedTarget = {
    schema: "restricted.schema.json",
    equivalence: { mode: "exact" }
  };
  const preserveEdge = (name) => ({
    name,
    transform: {
      argv: [process.execPath, "preserve.js"],
      timeoutMs: 2000
    },
    target: accountTarget
  });

  const pipeline = [preserveEdge("edge-1-preserve")];
  if (mode === "edge-failure") {
    pipeline.push({
      name: "edge-2-fail",
      transform: {
        argv: [process.execPath, "fail.js"],
        timeoutMs: 2000
      },
      target: restrictedTarget
    });
  } else if (mode === "no-loss") {
    pipeline.push(preserveEdge("edge-2-preserve"));
  } else {
    pipeline.push({
      name: "edge-2-collapse",
      transform: {
        argv: [process.execPath, "collapse.js"],
        timeoutMs: 2000
      },
      target: restrictedTarget
    });
  }

  const manifest = {
    version: 1,
    operation: "locate-loss",
    inputWitness: "input-witness.json",
    pipeline,
    search: {
      mode: "corpus",
      budget: 100
    },
    replay: {
      forward: 1,
      equivalence: 1
    }
  };

  const manifestPath = path.join(dir, "manifest.json");
  writeJson(manifestPath, manifest);
  return { dir, manifest: manifestPath };
}

function createCompareFixture({ leftCode, rightCode }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpath-compare-"));
  writeJson(path.join(dir, "source.schema.json"), {
    type: "object",
    additionalProperties: false,
    required: ["approval"],
    properties: {
      approval: { enum: ["automatic"] }
    }
  });
  writeJson(path.join(dir, "target.schema.json"), {
    type: "object",
    additionalProperties: false,
    required: ["approved"],
    properties: {
      approved: { type: "boolean" }
    }
  });
  writeJson(path.join(dir, "source.json"), { approval: "automatic" });
  fs.writeFileSync(
    path.join(dir, "left.js"),
    leftCode || "process.stdout.write(JSON.stringify({ approved: true }) + '\\n');"
  );
  fs.writeFileSync(
    path.join(dir, "right.js"),
    rightCode || "process.stdout.write(JSON.stringify({ approved: false }) + '\\n');"
  );

  const source = {
    schema: "source.schema.json",
    corpus: ["source.json"],
    equivalence: { mode: "exact" }
  };
  const target = {
    schema: "target.schema.json",
    equivalence: { mode: "exact" }
  };
  const manifest = {
    version: 1,
    operation: "compare-paths",
    source,
    forward: {
      argv: [process.execPath, "left.js"],
      timeoutMs: 2000
    },
    target,
    paths: [
      {
        name: "left",
        edges: [
          {
            name: "left-edge",
            transform: {
              argv: [process.execPath, "left.js"],
              timeoutMs: 2000
            },
            target
          }
        ],
        target
      },
      {
        name: "right",
        edges: [
          {
            name: "right-edge",
            transform: {
              argv: [process.execPath, "right.js"],
              timeoutMs: 2000
            },
            target
          }
        ],
        target
      }
    ],
    search: {
      mode: "corpus",
      budget: 100
    },
    replay: {
      forward: 1,
      equivalence: 1
    }
  };

  const manifestPath = path.join(dir, "manifest.json");
  writeJson(manifestPath, manifest);
  return { dir, manifest: manifestPath };
}

function runJson(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  const allowed = options.allowExit === undefined ? 0 : options.allowExit;
  assert.equal(result.status, allowed, result.stderr || result.stdout);
  return {
    status: result.status,
    json: JSON.parse(result.stdout)
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function assertWitnessSchema(witness) {
  const result = validateWithCompiled(witnessSchema, witness);
  assert.equal(result.valid, true, result.errors.join("\n"));
}

function assertReplay(witness, classification) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpath-shrunk-"));
  const witnessPath = path.join(tempDir, "witness.json");
  fs.writeFileSync(witnessPath, JSON.stringify(witness, null, 2));

  const replay = runJson(["replay", witnessPath]).json;
  assert.equal(replay.replayed, true);
  assert.equal(replay.classification, classification);
}

function shrinkDiagnostic(witness) {
  const diagnostic = witness.diagnostics.find((item) => Object.prototype.hasOwnProperty.call(item, "shrinkAttempts"));
  assert.ok(diagnostic, "expected shrink diagnostic");
  return diagnostic;
}
