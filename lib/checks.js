"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const { differencePaths, exactEquivalent, exactKey, sortForJson } = require("./equivalence");
const {
  ManifestError,
  corpusPaths,
  loadJsonAt,
  operationToWitnessName,
  requireV0CheckSupport,
  resolveManifestPath
} = require("./manifest");
const { portableArtifactPath } = require("./pathing");
const { runJsonCommand } = require("./runner");
const { compileSchemaFile, validateWithCompiled } = require("./schema");
const {
  jsonCostForPair,
  jsonCostForState,
  shrinkPair,
  shrinkSingle
} = require("./shrinker");

function checkManifest(ctx) {
  requireV0CheckSupport(ctx);
  if (ctx.manifest.operation === "domain-exclusion") {
    return checkDomainExclusion(ctx);
  }
  if (ctx.manifest.operation === "return-failure") {
    return checkReturnFailure(ctx);
  }
  if (ctx.manifest.operation === "distinction-collision") {
    return checkDistinctionCollision(ctx);
  }
  if (ctx.manifest.operation === "compare-paths") {
    return checkComparePaths(ctx);
  }
  if (ctx.manifest.operation === "locate-loss") {
    return checkLocateLoss(ctx);
  }
  const error = new Error(`operation '${ctx.manifest.operation}' is not implemented in the v0 prototype`);
  error.code = "BACKPATH_NOT_IMPLEMENTED";
  throw error;
}

function checkDomainExclusion(ctx) {
  const contracts = buildContracts(ctx);
  const corpus = loadCorpus(ctx, contracts);
  const budget = ctx.manifest.search.budget || corpus.length;
  let evaluated = 0;

  for (const item of corpus.slice(0, budget)) {
    evaluated += 1;
    const run = runForward(ctx, item.value);
    const processClassification = domainExclusionClassification(run);
    if (processClassification) {
      return domainExclusionWitness(ctx, contracts, item, {
        classification: processClassification,
        run,
        target: { equivalence: "exact" },
        diagnostics: []
      }, evaluated);
    }

    const targetValidation = validateTarget(ctx, contracts, run.output);
    if (!targetValidation.valid) {
      return domainExclusionWitness(ctx, contracts, item, {
        classification: "invalid_target",
        run,
        target: {
          equivalence: "exact",
          value: run.output,
          validation: targetValidation
        },
        diagnostics: [{ stage: "forward", classification: "invalid_target", validation: targetValidation }]
      }, evaluated);
    }
  }

  return notFound(ctx, evaluated, 0);
}

function checkReturnFailure(ctx) {
  const contracts = buildContracts(ctx);
  const corpus = loadCorpus(ctx, contracts);
  const budget = ctx.manifest.search.budget || corpus.length;
  let evaluated = 0;

  for (const item of corpus.slice(0, budget)) {
    evaluated += 1;
    const forwardRun = runForward(ctx, item.value);
    const forwardFailure = forwardExcludedClassification(ctx, contracts, forwardRun);
    if (forwardFailure.classification) {
      return returnFailureWitness(ctx, contracts, item, {
        classification: "forward_excluded",
        forwardRun,
        reverseRun: null,
        target: forwardFailure.target,
        returned: null,
        sourceValidation: null,
        diagnostics: forwardFailure.diagnostics
      }, evaluated);
    }

    const reverseRun = runReverse(ctx, forwardRun.output);
    const returnFailure = returnFailureClassification(ctx, contracts, item.value, reverseRun);
    if (returnFailure.classification) {
      return returnFailureWitness(ctx, contracts, item, {
        classification: returnFailure.classification,
        forwardRun,
        reverseRun,
        target: {
          equivalence: "exact",
          value: forwardRun.output
        },
        returned: reverseRun.output === undefined ? null : reverseRun.output,
        sourceValidation: returnFailure.sourceValidation,
        diagnostics: returnFailure.diagnostics
      }, evaluated);
    }
  }

  return notFound(ctx, evaluated, 0);
}

function checkDistinctionCollision(ctx) {
  const contracts = buildContracts(ctx);
  const corpus = loadCorpus(ctx, contracts);
  const budget = ctx.manifest.search.budget || corpus.length;
  const buckets = new Map();
  const diagnostics = [];
  let evaluated = 0;
  let evaluatedPairs = 0;

  for (const item of corpus.slice(0, budget)) {
    evaluated += 1;
    const run = runForward(ctx, item.value);
    if (!run.succeeded) {
      diagnostics.push({ corpusPath: item.path, forward: run.toEvidence() });
      continue;
    }

    const targetValidation = validateTarget(ctx, contracts, run.output);
    if (!targetValidation.valid) {
      diagnostics.push({
        corpusPath: item.path,
        forward: run.toEvidence(),
        classification: "invalid_target",
        validation: targetValidation
      });
      continue;
    }

    const bucketKey = exactKey(run.output);
    const candidate = {
      item,
      target: run.output,
      run,
      sourceKey: exactKey(item.value)
    };

    const bucket = buckets.get(bucketKey) || [];
    for (const existing of bucket) {
      evaluatedPairs += 1;
      if (existing.sourceKey !== candidate.sourceKey) {
        return distinctionCollisionWitness(ctx, existing, candidate, evaluated, evaluatedPairs, diagnostics);
      }
    }
    bucket.push(candidate);
    buckets.set(bucketKey, bucket);
  }

  return notFound(ctx, evaluated, evaluatedPairs, diagnostics);
}

function checkComparePaths(ctx) {
  const contracts = buildContracts(ctx);
  const corpus = loadCorpus(ctx, contracts);
  const budget = ctx.manifest.search.budget || corpus.length;
  let evaluated = 0;
  let evaluatedPairs = 0;

  for (const item of corpus.slice(0, budget)) {
    evaluated += 1;
    const pathResults = executePathSet(ctx, item.value);
    const divergence = pathDivergenceDetails(pathResults);
    evaluatedPairs += divergence ? divergence.evaluatedPairs : countTerminalPairs(pathResults);
    if (divergence) {
      return pathDivergenceWitness(ctx, item, pathResults, divergence, evaluated, evaluatedPairs);
    }
  }

  return notFound(ctx, evaluated, evaluatedPairs);
}

function checkLocateLoss(ctx) {
  const input = loadLossInputWitness(ctx);
  if (!input.ok) {
    return lossLocalizationWitness(ctx, input, {
      status: "indeterminate",
      classification: "none",
      outcome: "input_witness_error",
      startDifferencePaths: [],
      pipeline: [],
      targetValueA: null,
      targetValueB: null,
      targetDifferencePaths: [],
      diagnostics: [input.diagnostic]
    });
  }

  const evaluation = executeLossLocalization(ctx, input.a, input.b);
  return lossLocalizationWitness(ctx, input, evaluation);
}

function domainExclusionWitness(ctx, contracts, initialItem, initialFinding, evaluated) {
  const shrink = shrinkDomainExclusion(ctx, contracts, initialItem, initialFinding);
  const item = shrink ? shrink.item : initialItem;
  const finding = shrink ? shrink.finding : initialFinding;

  return {
    ...baseWitness(ctx, "witnessed", finding.classification),
    summary: finding.classification === "invalid_target"
      ? "The forward transform emitted parseable JSON that failed the target schema."
      : "A valid source corpus item could not cross the forward transformation.",
    source: sourceSingle(ctx, item),
    target: finding.target,
    forward: finding.run.toEvidence(),
    minimality: minimality(ctx, shrink),
    reproducibility: reproducibility(ctx, { forwardReplays: 0 }),
    search: search(ctx, evaluated, 0, { witnessed: true }),
    diagnostics: diagnosticsWithShrink(finding.diagnostics, shrink),
    artifacts: artifacts(ctx)
  };
}

function returnFailureWitness(ctx, contracts, initialItem, initialFinding, evaluated) {
  const shrink = shrinkReturnFailure(ctx, contracts, initialItem, initialFinding);
  const item = shrink ? shrink.item : initialItem;
  const finding = shrink ? shrink.finding : initialFinding;
  const returned = finding.returned;

  return {
    ...baseWitness(ctx, "witnessed", finding.classification),
    summary: returnSummary(finding.classification),
    source: {
      ...sourceSingle(ctx, item),
      returned,
      differencePaths: returned === null || returned === undefined ? [] : differencePaths(item.value, returned),
      validation: finding.sourceValidation
    },
    target: finding.target,
    forward: finding.forwardRun.toEvidence(),
    reverse: finding.reverseRun ? finding.reverseRun.toEvidence() : {},
    minimality: minimality(ctx, shrink),
    reproducibility: finding.reverseRun
      ? replayCountsForReturn(ctx, item.value, finding.forwardRun.output, finding.reverseRun.output)
      : reproducibility(ctx, { forwardReplays: 0, reverseReplays: 0 }),
    search: search(ctx, evaluated, 0, { witnessed: true }),
    diagnostics: diagnosticsWithShrink(finding.diagnostics, shrink),
    artifacts: artifacts(ctx)
  };
}

function distinctionCollisionWitness(ctx, left, right, evaluated, evaluatedPairs, diagnostics) {
  const shrink = shrinkDistinctionCollision(ctx, left, right);
  const finalLeft = shrink ? shrink.left : left;
  const finalRight = shrink ? shrink.right : right;
  const leftValue = finalLeft.item.value;
  const rightValue = finalRight.item.value;
  const commonForward = commonCommandEvidence(finalLeft.run.toEvidence());
  return {
    ...baseWitness(ctx, "witnessed", "distinction_collision"),
    summary: "Two source-distinct corpus items produced exact-equivalent target values.",
    source: {
      equivalence: "exact",
      a: leftValue,
      b: rightValue,
      aPath: portableArtifactPath(finalLeft.item.path, ctx),
      bPath: portableArtifactPath(finalRight.item.path, ctx),
      differencePaths: differencePaths(leftValue, rightValue)
    },
    target: {
      equivalence: "exact",
      a: finalLeft.target,
      b: finalRight.target
    },
    forward: {
      ...commonForward,
      a: finalLeft.run.toEvidence(),
      b: finalRight.run.toEvidence()
    },
    minimality: minimality(ctx, shrink),
    reproducibility: replayCountsForCollision(ctx, leftValue, rightValue, finalLeft.target, finalRight.target),
    search: search(ctx, evaluated, evaluatedPairs, { witnessed: true }),
    diagnostics: diagnosticsWithShrink(diagnostics, shrink),
    artifacts: artifacts(ctx)
  };
}

function pathDivergenceWitness(ctx, item, pathResults, divergence, evaluated, evaluatedPairs) {
  return {
    ...baseWitness(ctx, "witnessed", "path_divergence"),
    summary: divergence.subtype === "route_failure"
      ? "One path reached a terminal value while another route failed."
      : "Two paths reached exact-distinct terminal values.",
    source: sourceSingle(ctx, item),
    paths: pathResults,
    target: {
      equivalence: "exact",
      differencePaths: divergence.differencePaths || [],
      left: divergence.left ? { path: divergence.left.name, value: divergence.left.terminal.value } : null,
      right: divergence.right ? { path: divergence.right.name, value: divergence.right.terminal.value } : null
    },
    minimality: minimality(ctx),
    reproducibility: replayCountsForPathDivergence(ctx, item.value, divergence),
    search: search(ctx, evaluated, evaluatedPairs, { witnessed: true }),
    diagnostics: [pathDivergenceDiagnostic(divergence)],
    artifacts: artifacts(ctx)
  };
}

function lossLocalizationWitness(ctx, input, evaluation) {
  return {
    ...baseWitness(ctx, evaluation.status, evaluation.classification),
    summary: lossLocalizationSummary(evaluation),
    source: lossSource(input, evaluation),
    pipeline: evaluation.pipeline,
    localization: {
      lossKind: "distinction_collision",
      firstLossEdge: evaluation.firstLossEdge || null,
      previousDifferencePaths: evaluation.previousDifferencePaths || [],
      collapsedTarget: Object.prototype.hasOwnProperty.call(evaluation, "collapsedTarget")
        ? evaluation.collapsedTarget
        : null
    },
    target: {
      equivalence: "exact",
      valueA: evaluation.targetValueA,
      valueB: evaluation.targetValueB,
      differencePaths: evaluation.targetDifferencePaths || []
    },
    minimality: minimality(ctx),
    reproducibility: input.ok ? replayCountsForLossLocalization(ctx, input.a, input.b, evaluation) : reproducibility(ctx),
    search: lossSearch(ctx, evaluation),
    diagnostics: evaluation.diagnostics,
    artifacts: artifacts(ctx, input.ok ? { inputWitness: input.path } : {})
  };
}

function lossSource(input, evaluation) {
  const source = {
    equivalence: "exact",
    differencePaths: evaluation.startDifferencePaths || []
  };
  if (input.ok) {
    source.a = input.a;
    source.b = input.b;
    if (input.witness.source && input.witness.source.aPath) {
      source.aPath = input.witness.source.aPath;
    }
    if (input.witness.source && input.witness.source.bPath) {
      source.bPath = input.witness.source.bPath;
    }
  }
  return source;
}

function lossLocalizationSummary(evaluation) {
  if (evaluation.outcome === "localized") {
    return "A source distinction first becomes exact-equivalent at the localized pipeline edge.";
  }
  if (evaluation.outcome === "already_equivalent") {
    return "The input source pair was already exact-equivalent before the pipeline started.";
  }
  if (evaluation.outcome === "edge_failure") {
    return "The pipeline could not be evaluated through localization because an edge failed.";
  }
  if (evaluation.outcome === "no_loss") {
    return "No distinction loss was found within the declared pipeline.";
  }
  return "Loss localization could not evaluate the input witness.";
}

function loadLossInputWitness(ctx) {
  const inputWitnessPath = resolveManifestPath(ctx, ctx.manifest.inputWitness);
  let witness;
  try {
    witness = JSON.parse(fs.readFileSync(inputWitnessPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      path: inputWitnessPath,
      diagnostic: {
        classification: "input_witness_unavailable",
        message: `inputWitness could not be loaded: ${error.message}`
      }
    };
  }

  if (!witness || witness.operation !== "distinction_collision") {
    return {
      ok: false,
      path: inputWitnessPath,
      diagnostic: {
        classification: "input_witness_unsupported",
        message: "locate-loss requires a distinction_collision input witness"
      }
    };
  }

  if (!witness.source || !Object.prototype.hasOwnProperty.call(witness.source, "a") || !Object.prototype.hasOwnProperty.call(witness.source, "b")) {
    return {
      ok: false,
      path: inputWitnessPath,
      diagnostic: {
        classification: "input_witness_malformed",
        message: "distinction_collision input witness must include source.a and source.b"
      }
    };
  }

  return {
    ok: true,
    path: inputWitnessPath,
    witness,
    a: witness.source.a,
    b: witness.source.b
  };
}

function executePathSet(ctx, sourceValue) {
  return ctx.manifest.paths.map((pathSpec) => executePath(ctx, pathSpec, sourceValue));
}

function executePath(ctx, pathSpec, sourceValue) {
  const result = {
    name: pathSpec.name,
    terminal: {
      reached: false
    },
    edges: []
  };
  let current = sourceValue;

  for (const edge of pathSpec.edges) {
    const edgeEvidence = {
      name: edge.name,
      input: current
    };
    const run = runPathEdge(ctx, edge, current);
    edgeEvidence.command = run.toEvidence();

    const processClassification = domainExclusionClassification(run);
    if (processClassification) {
      edgeEvidence.classification = processClassification;
      result.failed = true;
      result.failure = {
        edge: edge.name,
        classification: processClassification
      };
      result.edges.push(edgeEvidence);
      return result;
    }

    edgeEvidence.output = run.output;
    edgeEvidence.validation = validateDomainSpec(ctx, edge.target, run.output);
    if (!edgeEvidence.validation.valid) {
      edgeEvidence.classification = "invalid_target";
      result.failed = true;
      result.failure = {
        edge: edge.name,
        classification: "invalid_target"
      };
      result.edges.push(edgeEvidence);
      return result;
    }

    result.edges.push(edgeEvidence);
    current = run.output;
  }

  const terminalValidation = validateDomainSpec(ctx, pathSpec.target, current);
  if (!terminalValidation.valid) {
    result.failed = true;
    result.failure = {
      edge: null,
      classification: "invalid_target"
    };
    result.terminal = {
      reached: false,
      value: current,
      validation: terminalValidation,
      classification: "invalid_target"
    };
    return result;
  }

  result.terminal = {
    reached: true,
    value: current,
    validation: terminalValidation
  };
  return result;
}

function pathDivergenceDetails(pathResults) {
  const reached = pathResults.filter((pathResult) => pathResult.terminal.reached);
  const failed = pathResults.filter((pathResult) => !pathResult.terminal.reached);

  if (reached.length > 0 && failed.length > 0) {
    return {
      subtype: "route_failure",
      reached,
      failed,
      evaluatedPairs: reached.length * failed.length
    };
  }

  let evaluatedPairs = 0;
  for (let leftIndex = 0; leftIndex < reached.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < reached.length; rightIndex += 1) {
      evaluatedPairs += 1;
      const left = reached[leftIndex];
      const right = reached[rightIndex];
      if (!exactEquivalent(left.terminal.value, right.terminal.value)) {
        return {
          subtype: "terminal_mismatch",
          left,
          right,
          differencePaths: differencePaths(left.terminal.value, right.terminal.value),
          evaluatedPairs
        };
      }
    }
  }

  return null;
}

function pathDivergenceDiagnostic(divergence) {
  if (divergence.subtype === "route_failure") {
    return {
      subtype: "route_failure",
      succeededPaths: divergence.reached.map((pathResult) => pathResult.name),
      failedPaths: divergence.failed.map((pathResult) => ({
        name: pathResult.name,
        edge: pathResult.failure && pathResult.failure.edge,
        classification: pathResult.failure && pathResult.failure.classification
      }))
    };
  }

  return {
    subtype: "terminal_mismatch",
    leftPath: divergence.left.name,
    rightPath: divergence.right.name,
    differencePaths: divergence.differencePaths
  };
}

function executeLossLocalization(ctx, sourceA, sourceB) {
  const startEquivalent = exactEquivalent(sourceA, sourceB);
  const startDifferencePaths = startEquivalent ? [] : differencePaths(sourceA, sourceB);
  const pipeline = [];
  let currentA = sourceA;
  let currentB = sourceB;
  let previousDifferencePaths = startDifferencePaths;

  if (startEquivalent) {
    return {
      status: "indeterminate",
      classification: "none",
      outcome: "already_equivalent",
      startDifferencePaths,
      pipeline,
      targetValueA: currentA,
      targetValueB: currentB,
      targetDifferencePaths: [],
      diagnostics: [
        {
          classification: "already_equivalent",
          message: "source.a and source.b are exact-equivalent before the pipeline starts"
        }
      ]
    };
  }

  for (const edge of ctx.manifest.pipeline) {
    const edgeResult = executeLossPipelineEdge(ctx, edge, currentA, currentB);
    pipeline.push(edgeResult.evidence);

    if (edgeResult.failed) {
      return {
        status: "indeterminate",
        classification: "none",
        outcome: "edge_failure",
        startDifferencePaths,
        pipeline,
        targetValueA: currentA,
        targetValueB: currentB,
        targetDifferencePaths: previousDifferencePaths,
        diagnostics: [
          {
            classification: "edge_failure",
            edge: edge.name,
            message: "pipeline edge failed before loss localization could complete",
            failure: edgeResult.evidence.failure || null
          }
        ]
      };
    }

    if (!edgeResult.beforeEquivalent && edgeResult.afterEquivalent) {
      return {
        status: "witnessed",
        classification: "loss_localized",
        outcome: "localized",
        startDifferencePaths,
        pipeline,
        firstLossEdge: edge.name,
        previousDifferencePaths: edgeResult.beforeDifferencePaths,
        collapsedTarget: edgeResult.outputA,
        targetValueA: edgeResult.outputA,
        targetValueB: edgeResult.outputB,
        targetDifferencePaths: [],
        diagnostics: []
      };
    }

    currentA = edgeResult.outputA;
    currentB = edgeResult.outputB;
    previousDifferencePaths = edgeResult.afterDifferencePaths;
  }

  return {
    status: "not_found_within_budget",
    classification: "none",
    outcome: "no_loss",
    startDifferencePaths,
    pipeline,
    targetValueA: currentA,
    targetValueB: currentB,
    targetDifferencePaths: exactEquivalent(currentA, currentB) ? [] : differencePaths(currentA, currentB),
    diagnostics: [
      {
        classification: "no-loss-found",
        message: "source.a and source.b remained exact-distinct through the full declared pipeline"
      }
    ]
  };
}

function executeLossPipelineEdge(ctx, edge, inputA, inputB) {
  const beforeEquivalent = exactEquivalent(inputA, inputB);
  const beforeDifferencePaths = beforeEquivalent ? [] : differencePaths(inputA, inputB);
  const evidence = {
    name: edge.name,
    inputA,
    inputB,
    beforeEquivalent
  };

  const runA = runPipelineEdge(ctx, edge, inputA);
  const runB = runPipelineEdge(ctx, edge, inputB);
  evidence.commandA = runA.toEvidence();
  evidence.commandB = runB.toEvidence();

  if (Object.prototype.hasOwnProperty.call(runA, "output") && runA.output !== undefined) {
    evidence.outputA = runA.output;
  }
  if (Object.prototype.hasOwnProperty.call(runB, "output") && runB.output !== undefined) {
    evidence.outputB = runB.output;
  }

  const classificationA = domainExclusionClassification(runA);
  const classificationB = domainExclusionClassification(runB);
  if (classificationA || classificationB) {
    evidence.classification = classificationA || classificationB;
    evidence.failure = {
      a: classificationA || null,
      b: classificationB || null
    };
    return {
      failed: true,
      evidence
    };
  }

  evidence.outputA = runA.output;
  evidence.outputB = runB.output;
  evidence.validation = {
    a: validateDomainSpec(ctx, edge.target, runA.output),
    b: validateDomainSpec(ctx, edge.target, runB.output)
  };

  if (!evidence.validation.a.valid || !evidence.validation.b.valid) {
    evidence.classification = "invalid_target";
    evidence.failure = {
      a: evidence.validation.a.valid ? null : "invalid_target",
      b: evidence.validation.b.valid ? null : "invalid_target"
    };
    return {
      failed: true,
      evidence
    };
  }

  const afterEquivalent = exactEquivalent(runA.output, runB.output);
  evidence.afterEquivalent = afterEquivalent;
  evidence.afterDifferencePaths = afterEquivalent ? [] : differencePaths(runA.output, runB.output);

  return {
    failed: false,
    beforeEquivalent,
    beforeDifferencePaths,
    afterEquivalent,
    afterDifferencePaths: evidence.afterDifferencePaths,
    outputA: runA.output,
    outputB: runB.output,
    evidence
  };
}

function sameLossLocalizationResult(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    left.status === right.status &&
    left.classification === right.classification &&
    (left.outcome || null) === (right.outcome || null) &&
    (left.firstLossEdge || null) === (right.firstLossEdge || null) &&
    exactEquivalent(lossPipelineShape(left.pipeline), lossPipelineShape(right.pipeline))
  );
}

function lossPipelineShape(pipeline) {
  return (pipeline || []).map((edge) => ({
    name: edge.name,
    beforeEquivalent: edge.beforeEquivalent,
    afterEquivalent: Object.prototype.hasOwnProperty.call(edge, "afterEquivalent") ? edge.afterEquivalent : null,
    classification: edge.classification || null
  }));
}

function shrinkDomainExclusion(ctx, contracts, initialItem, initialFinding) {
  if (!shouldShrink(ctx)) {
    return null;
  }

  const result = shrinkSingle(initialItem.value, {
    budget: shrinkBudget(ctx),
    initialInfo: { accepted: true, finding: initialFinding, validation: initialItem.validation },
    predicate: (candidate) => evaluateDomainExclusionCandidate(ctx, contracts, candidate, initialFinding.classification),
    cost: (candidate) => jsonCostForState(candidate, 0)
  });

  return {
    item: itemWithValue(initialItem, result.value, result.info.validation),
    finding: result.info.finding,
    cost: result.cost,
    attempts: result.attempts,
    accepted: result.accepted,
    budgetExhausted: result.budgetExhausted
  };
}

function shrinkReturnFailure(ctx, contracts, initialItem, initialFinding) {
  if (!shouldShrink(ctx)) {
    return null;
  }

  const result = shrinkSingle(initialItem.value, {
    budget: shrinkBudget(ctx),
    initialInfo: { accepted: true, finding: initialFinding, validation: initialItem.validation },
    predicate: (candidate) => evaluateReturnFailureCandidate(ctx, contracts, candidate, initialFinding.classification),
    cost: (candidate, info) => jsonCostForState(candidate, returnDifferenceCount(candidate, info.finding))
  });

  return {
    item: itemWithValue(initialItem, result.value, result.info.validation),
    finding: result.info.finding,
    cost: result.cost,
    attempts: result.attempts,
    accepted: result.accepted,
    budgetExhausted: result.budgetExhausted
  };
}

function shrinkDistinctionCollision(ctx, initialLeft, initialRight) {
  if (!shouldShrink(ctx)) {
    return null;
  }

  const contracts = buildContracts(ctx);
  const result = shrinkPair(initialLeft.item.value, initialRight.item.value, {
    budget: shrinkBudget(ctx),
    initialInfo: { accepted: true, left: initialLeft, right: initialRight },
    predicate: (leftValue, rightValue) => evaluateDistinctionCollisionCandidate(ctx, contracts, initialLeft, initialRight, leftValue, rightValue),
    cost: (leftValue, rightValue) => jsonCostForPair(leftValue, rightValue)
  });

  return {
    left: result.info.left,
    right: result.info.right,
    cost: result.cost,
    attempts: result.attempts,
    accepted: result.accepted,
    budgetExhausted: result.budgetExhausted
  };
}

function evaluateDomainExclusionCandidate(ctx, contracts, sourceValue, expectedClassification) {
  const sourceValidation = validateSource(ctx, contracts, sourceValue);
  if (!sourceValidation.valid) {
    return { accepted: false };
  }

  const run = runForward(ctx, sourceValue);
  const processClassification = domainExclusionClassification(run);
  if (processClassification) {
    if (processClassification !== expectedClassification) {
      return { accepted: false };
    }
    return {
      accepted: true,
      validation: sourceValidation,
      finding: {
        classification: processClassification,
        run,
        target: { equivalence: "exact" },
        diagnostics: []
      }
    };
  }

  const targetValidation = validateTarget(ctx, contracts, run.output);
  if (!targetValidation.valid && expectedClassification === "invalid_target") {
    return {
      accepted: true,
      validation: sourceValidation,
      finding: {
        classification: "invalid_target",
        run,
        target: {
          equivalence: "exact",
          value: run.output,
          validation: targetValidation
        },
        diagnostics: [{ stage: "forward", classification: "invalid_target", validation: targetValidation }]
      }
    };
  }

  return { accepted: false };
}

function evaluateReturnFailureCandidate(ctx, contracts, sourceValue, expectedClassification) {
  const sourceValidation = validateSource(ctx, contracts, sourceValue);
  if (!sourceValidation.valid) {
    return { accepted: false };
  }

  const forwardRun = runForward(ctx, sourceValue);
  const forwardFailure = forwardExcludedClassification(ctx, contracts, forwardRun);
  if (forwardFailure.classification) {
    if (expectedClassification !== "forward_excluded") {
      return { accepted: false };
    }
    return {
      accepted: true,
      validation: sourceValidation,
      finding: {
        classification: "forward_excluded",
        forwardRun,
        reverseRun: null,
        target: forwardFailure.target,
        returned: null,
        sourceValidation: null,
        diagnostics: forwardFailure.diagnostics
      }
    };
  }

  const reverseRun = runReverse(ctx, forwardRun.output);
  const returnFailure = returnFailureClassification(ctx, contracts, sourceValue, reverseRun);
  if (!returnFailure.classification || returnFailure.classification !== expectedClassification) {
    return { accepted: false };
  }

  return {
    accepted: true,
    validation: sourceValidation,
    finding: {
      classification: returnFailure.classification,
      forwardRun,
      reverseRun,
      target: {
        equivalence: "exact",
        value: forwardRun.output
      },
      returned: reverseRun.output === undefined ? null : reverseRun.output,
      sourceValidation: returnFailure.sourceValidation,
      diagnostics: returnFailure.diagnostics
    }
  };
}

function evaluateDistinctionCollisionCandidate(ctx, contracts, initialLeft, initialRight, leftValue, rightValue) {
  const leftValidation = validateSource(ctx, contracts, leftValue);
  const rightValidation = validateSource(ctx, contracts, rightValue);
  if (!leftValidation.valid || !rightValidation.valid || exactEquivalent(leftValue, rightValue)) {
    return { accepted: false };
  }

  const leftRun = runForward(ctx, leftValue);
  const rightRun = runForward(ctx, rightValue);
  if (!leftRun.succeeded || !rightRun.succeeded) {
    return { accepted: false };
  }

  const leftTargetValidation = validateTarget(ctx, contracts, leftRun.output);
  const rightTargetValidation = validateTarget(ctx, contracts, rightRun.output);
  if (!leftTargetValidation.valid || !rightTargetValidation.valid || !exactEquivalent(leftRun.output, rightRun.output)) {
    return { accepted: false };
  }

  return {
    accepted: true,
    left: {
      item: itemWithValue(initialLeft.item, leftValue, leftValidation),
      target: leftRun.output,
      run: leftRun,
      sourceKey: exactKey(leftValue)
    },
    right: {
      item: itemWithValue(initialRight.item, rightValue, rightValidation),
      target: rightRun.output,
      run: rightRun,
      sourceKey: exactKey(rightValue)
    }
  };
}

function returnDifferenceCount(sourceValue, finding) {
  if (!finding || finding.returned === null || finding.returned === undefined) {
    return 0;
  }
  return differencePaths(sourceValue, finding.returned).length;
}

function itemWithValue(item, value, validation) {
  return {
    ...item,
    value,
    validation
  };
}

function shouldShrink(ctx) {
  return Boolean(
    ctx.manifest.shrink &&
    ctx.manifest.shrink.enabled !== false &&
    shrinkBudget(ctx) > 0
  );
}

function shrinkBudget(ctx) {
  const shrink = ctx.manifest.shrink || {};
  if (Object.prototype.hasOwnProperty.call(shrink, "budget")) {
    return shrink.budget;
  }
  return ctx.manifest.shrink ? 5000 : 0;
}

function diagnosticsWithShrink(diagnostics, shrink) {
  const data = diagnostics ? diagnostics.slice() : [];
  if (shrink) {
    data.push({
      classification: "shrink",
      shrinkAttempts: shrink.attempts,
      shrinkAccepted: shrink.accepted,
      shrinkBudgetExhausted: shrink.budgetExhausted
    });
  }
  return data;
}

function loadCorpus(ctx, contracts) {
  return corpusPaths(ctx).map((itemPath) => {
    const value = loadJsonAt(itemPath);
    const sourceValidation = validateSource(ctx, contracts, value);
    if (!sourceValidation.valid) {
      throw new ManifestError([
        `source corpus item failed source.schema: ${portableArtifactPath(itemPath, ctx)}`,
        ...sourceValidation.errors
      ]);
    }
    return {
      path: itemPath,
      value,
      validation: sourceValidation
    };
  });
}

function domainExclusionClassification(run) {
  if (run.timeout) {
    return "timeout";
  }
  if (run.executionError || run.signal || run.exitCode === null) {
    return "transform_crash";
  }
  if (run.exitCode !== null && run.exitCode !== 0) {
    return "source_rejected";
  }
  if (run.malformedOutput) {
    return "malformed_output";
  }
  return null;
}

function forwardExcludedClassification(ctx, contracts, forwardRun) {
  const processClassification = domainExclusionClassification(forwardRun);
  if (processClassification) {
    return {
      classification: "forward_excluded",
      target: { equivalence: "exact" },
      diagnostics: [{ stage: "forward", classification: processClassification }]
    };
  }

  const targetValidation = validateTarget(ctx, contracts, forwardRun.output);
  if (!targetValidation.valid) {
    return {
      classification: "forward_excluded",
      target: {
        equivalence: "exact",
        value: forwardRun.output,
        validation: targetValidation
      },
      diagnostics: [{ stage: "forward", classification: "invalid_target", validation: targetValidation }]
    };
  }

  return {
    classification: null,
    target: {
      equivalence: "exact",
      value: forwardRun.output,
      validation: targetValidation
    },
    diagnostics: []
  };
}

function returnFailureClassification(ctx, contracts, source, reverseRun) {
  if (
    reverseRun.timeout ||
    reverseRun.executionError ||
    reverseRun.signal ||
    reverseRun.exitCode === null ||
    (reverseRun.exitCode !== null && reverseRun.exitCode !== 0)
  ) {
    return {
      classification: "stranded_successor",
      sourceValidation: null,
      diagnostics: [{ stage: "reverse", classification: "stranded_successor" }]
    };
  }

  if (reverseRun.malformedOutput) {
    return {
      classification: "malformed_output",
      sourceValidation: null,
      diagnostics: [{ stage: "reverse", classification: "malformed_output" }]
    };
  }

  const sourceValidation = validateSource(ctx, contracts, reverseRun.output);
  if (!sourceValidation.valid) {
    return {
      classification: "invalid_return",
      sourceValidation,
      diagnostics: [{ stage: "reverse", classification: "invalid_return", validation: sourceValidation }]
    };
  }

  if (!exactEquivalent(source, reverseRun.output)) {
    return {
      classification: "return_drift",
      sourceValidation,
      diagnostics: []
    };
  }

  return {
    classification: null,
    sourceValidation,
    diagnostics: []
  };
}

function returnSummary(classification) {
  if (classification === "forward_excluded") {
    return "The forward transform did not produce a valid target during return testing.";
  }
  if (classification === "return_drift") {
    return "Forward and reverse succeeded, but the returned source was not exact-equivalent to the original.";
  }
  if (classification === "stranded_successor") {
    return "Forward succeeded, but the reverse transform could not return the target value.";
  }
  if (classification === "invalid_return") {
    return "Reverse emitted parseable JSON that failed the source schema.";
  }
  if (classification === "malformed_output") {
    return "Reverse emitted stdout that was not parseable JSON.";
  }
  return "Return testing produced a witnessed finding.";
}

function baseWitness(ctx, status, classification) {
  return {
    version: 1,
    operation: operationToWitnessName(ctx.manifest.operation),
    status,
    classification,
    createdAt: new Date().toISOString(),
    contractDigest: digest(ctx.manifest),
    manifestDigest: digest(ctx.manifest)
  };
}

function notFound(ctx, evaluatedStates, evaluatedPairs, diagnostics = []) {
  return {
    ...baseWitness(ctx, "not_found_within_budget", "none"),
    summary: "No witnessed finding was found within the corpus budget.",
    source: { equivalence: "exact" },
    target: { equivalence: "exact" },
    minimality: { kind: "none" },
    reproducibility: reproducibility(ctx),
    search: search(ctx, evaluatedStates, evaluatedPairs),
    diagnostics,
    artifacts: artifacts(ctx)
  };
}

function sourceSingle(ctx, item) {
  return {
    equivalence: ctx.manifest.source.equivalence.mode,
    value: item.value,
    path: portableArtifactPath(item.path, ctx),
    validation: item.validation
  };
}

function minimality(ctx, shrinkResult = null) {
  const shrink = ctx.manifest.shrink || {};
  const preservedClassification = shrink.preserveClassification !== false;
  if (!shrinkResult) {
    return {
      kind: "not_attempted",
      budget: shrinkBudget(ctx),
      preservedClassification
    };
  }
  return {
    kind: shrinkResult.budgetExhausted ? "budget_exhausted" : "local_fixed_point",
    cost: shrinkResult.cost,
    budget: shrinkBudget(ctx),
    preservedClassification
  };
}

function reproducibility(ctx, counts = {}) {
  const replay = ctx.manifest.replay || {};
  const data = {
    seed: ctx.manifest.search && ctx.manifest.search.seed,
    replayCommand: "backpath replay <witness.json>"
  };
  if (Object.prototype.hasOwnProperty.call(counts, "forwardReplays")) {
    data.stableForwardReplays = counts.forwardReplays;
  } else if (Object.prototype.hasOwnProperty.call(replay, "forward")) {
    data.requestedForwardReplays = replay.forward;
  }
  if (Object.prototype.hasOwnProperty.call(counts, "reverseReplays")) {
    data.stableReverseReplays = counts.reverseReplays;
  } else if (Object.prototype.hasOwnProperty.call(replay, "reverse")) {
    data.requestedReverseReplays = replay.reverse;
  }
  if (Object.prototype.hasOwnProperty.call(counts, "equivalenceReplays")) {
    data.stableEquivalenceReplays = counts.equivalenceReplays;
  } else if (Object.prototype.hasOwnProperty.call(replay, "equivalence")) {
    data.requestedEquivalenceReplays = replay.equivalence;
  }
  return data;
}

function replayCountsForCollision(ctx, sourceA, sourceB, targetA, targetB) {
  const requestedForward = (ctx.manifest.replay && ctx.manifest.replay.forward) || 1;
  let forwardReplays = 0;
  for (let index = 0; index < requestedForward; index += 1) {
    const runA = runForward(ctx, sourceA);
    const runB = runForward(ctx, sourceB);
    if (!runA.succeeded || !runB.succeeded) {
      break;
    }
    if (!exactEquivalent(runA.output, targetA) || !exactEquivalent(runB.output, targetB)) {
      break;
    }
    forwardReplays += 1;
  }
  return reproducibility(ctx, {
    forwardReplays,
    equivalenceReplays: (ctx.manifest.replay && ctx.manifest.replay.equivalence) || 1
  });
}

function replayCountsForReturn(ctx, source, target, returned) {
  const requestedForward = (ctx.manifest.replay && ctx.manifest.replay.forward) || 1;
  const requestedReverse = (ctx.manifest.replay && ctx.manifest.replay.reverse) || 1;
  let forwardReplays = 0;
  let reverseReplays = 0;

  for (let index = 0; index < requestedForward; index += 1) {
    const run = runForward(ctx, source);
    if (!run.succeeded || !exactEquivalent(run.output, target)) {
      break;
    }
    forwardReplays += 1;
  }

  for (let index = 0; index < requestedReverse; index += 1) {
    const run = runReverse(ctx, target);
    if (!run.succeeded || !exactEquivalent(run.output, returned)) {
      break;
    }
    reverseReplays += 1;
  }

  return reproducibility(ctx, {
    forwardReplays,
    reverseReplays,
    equivalenceReplays: (ctx.manifest.replay && ctx.manifest.replay.equivalence) || 1
  });
}

function replayCountsForPathDivergence(ctx, source, originalDivergence) {
  const requestedPathReplays = (ctx.manifest.replay && ctx.manifest.replay.forward) || 1;
  let stablePathReplays = 0;

  for (let index = 0; index < requestedPathReplays; index += 1) {
    const pathResults = executePathSet(ctx, source);
    const replayDivergence = pathDivergenceDetails(pathResults);
    if (!samePathDivergence(originalDivergence, replayDivergence)) {
      break;
    }
    stablePathReplays += 1;
  }

  return {
    ...reproducibility(ctx),
    stablePathReplays
  };
}

function replayCountsForLossLocalization(ctx, sourceA, sourceB, originalEvaluation) {
  const requestedPipelineReplays = (ctx.manifest.replay && ctx.manifest.replay.forward) || 1;
  let stablePipelineReplays = 0;

  for (let index = 0; index < requestedPipelineReplays; index += 1) {
    const evaluation = executeLossLocalization(ctx, sourceA, sourceB);
    if (!sameLossLocalizationResult(originalEvaluation, evaluation)) {
      break;
    }
    stablePipelineReplays += 1;
  }

  return {
    ...reproducibility(ctx),
    stablePipelineReplays
  };
}

function samePathDivergence(left, right) {
  if (!left || !right || left.subtype !== right.subtype) {
    return false;
  }

  if (left.subtype === "route_failure") {
    return (
      sameNames(left.reached, right.reached) &&
      sameFailureNames(left.failed, right.failed)
    );
  }

  return (
    left.left.name === right.left.name &&
    left.right.name === right.right.name &&
    exactEquivalent(left.left.terminal.value, right.left.terminal.value) &&
    exactEquivalent(left.right.terminal.value, right.right.terminal.value)
  );
}

function sameNames(left, right) {
  return exactEquivalent(
    left.map((item) => item.name).sort(),
    right.map((item) => item.name).sort()
  );
}

function sameFailureNames(left, right) {
  return exactEquivalent(
    left.map((item) => ({
      name: item.name,
      edge: item.failure && item.failure.edge,
      classification: item.failure && item.failure.classification
    })).sort(compareByName),
    right.map((item) => ({
      name: item.name,
      edge: item.failure && item.failure.edge,
      classification: item.failure && item.failure.classification
    })).sort(compareByName)
  );
}

function compareByName(left, right) {
  return left.name.localeCompare(right.name);
}

function countTerminalPairs(pathResults) {
  const reached = pathResults.filter((pathResult) => pathResult.terminal.reached);
  return Math.max(0, (reached.length * (reached.length - 1)) / 2);
}

function search(ctx, evaluatedStates, evaluatedPairs, options = {}) {
  const budget = ctx.manifest.search.budget;
  const corpusSize = Array.isArray(ctx.manifest.source && ctx.manifest.source.corpus)
    ? ctx.manifest.source.corpus.length
    : 0;
  const budgetExhaustedCorpus = evaluatedStates >= Math.min(budget || corpusSize, corpusSize);
  const corpusExhausted = ctx.manifest.search.mode === "corpus" && !options.witnessed && budgetExhaustedCorpus;
  const domainExhaustive = ctx.manifest.search.mode === "exhaustive" && !options.witnessed && budgetExhaustedCorpus;
  return {
    mode: ctx.manifest.search.mode,
    evaluatedStates,
    evaluatedPairs,
    budget,
    seed: ctx.manifest.search.seed,
    corpusExhausted,
    domainExhaustive
  };
}

function lossSearch(ctx, evaluation) {
  const searchSpec = ctx.manifest.search || {};
  const evaluatedEdges = evaluation.pipeline.length;
  const evaluatedEdgeExecutions = evaluatedEdges * 2;
  return {
    mode: searchSpec.mode || "corpus",
    evaluatedSourceStates: 2,
    evaluatedEdgeExecutions,
    evaluatedPairs: evaluatedEdges,
    evaluatedEdges,
    evaluatedStates: evaluatedEdgeExecutions,
    budget: searchSpec.budget || ctx.manifest.pipeline.length,
    seed: searchSpec.seed,
    corpusExhausted: false,
    domainExhaustive: false,
    pipelineExhausted: evaluation.status === "not_found_within_budget"
  };
}

function buildContracts(ctx) {
  return {
    source: compileDomainSchema(ctx, "source"),
    target: compileDomainSchema(ctx, "target")
  };
}

function compileDomainSchema(ctx, label) {
  return compileDomainSpec(ctx, ctx.manifest[label], `${label}.schema`);
}

function compileDomainSpec(ctx, domainSpec, label) {
  const schemaPath = domainSpec && domainSpec.schema;
  if (!schemaPath) {
    return null;
  }
  try {
    return compileSchemaFile(resolveManifestPath(ctx, schemaPath));
  } catch (error) {
    throw new ManifestError([`${label} could not be loaded: ${schemaPath}`, error.message]);
  }
}

function validateSource(ctx, contracts, value) {
  return validationEvidence(ctx, validateWithCompiled(contracts.source, value));
}

function validateTarget(ctx, contracts, value) {
  return validationEvidence(ctx, validateWithCompiled(contracts.target, value));
}

function validateDomainSpec(ctx, domainSpec, value) {
  return validationEvidence(ctx, validateWithCompiled(compileDomainSpec(ctx, domainSpec, "path target schema"), value));
}

function validationEvidence(ctx, result) {
  return {
    valid: result.valid,
    schema: result.schema ? portableArtifactPath(result.schema, ctx) : null,
    errors: result.errors
  };
}

function runForward(ctx, value) {
  return runJsonCommand(ctx.manifest.forward, value, ctx.baseDir, {
    stage: "forward",
    portableContext: ctx,
    argvBaseDir: ctx.baseDir
  });
}

function runReverse(ctx, value) {
  const reverseIsolation = ctx.manifest.context && ctx.manifest.context.reverseIsolation;
  const cleanRoom = reverseIsolation === "fresh-process-clean-tempdir";
  return runJsonCommand(ctx.manifest.reverse, value, ctx.baseDir, {
    stage: "reverse",
    portableContext: ctx,
    argvBaseDir: ctx.baseDir,
    cleanTempCwd: cleanRoom,
    isolation: cleanRoom ? reverseIsolation : reverseIsolation || null
  });
}

function runPathEdge(ctx, edge, value) {
  return runJsonCommand(edge.transform, value, ctx.baseDir, {
    stage: "path",
    portableContext: ctx,
    argvBaseDir: ctx.baseDir
  });
}

function runPipelineEdge(ctx, edge, value) {
  return runJsonCommand(edge.transform, value, ctx.baseDir, {
    stage: "pipeline",
    portableContext: ctx,
    argvBaseDir: ctx.baseDir
  });
}

function commonCommandEvidence(evidence) {
  const common = {
    argv: evidence.argv,
    timeoutMs: evidence.timeoutMs,
    cwd: evidence.cwd,
    exitCode: evidence.exitCode,
    durationMs: evidence.durationMs,
    timeout: evidence.timeout,
    stderr: evidence.stderr
  };
  if (evidence.cwdBase) {
    common.cwdBase = evidence.cwdBase;
  }
  if (evidence.stage) {
    common.stage = evidence.stage;
  }
  if (evidence.environment) {
    common.environment = evidence.environment;
  }
  return common;
}

function artifacts(ctx, extra = {}) {
  const data = {
    manifest: portableArtifactPath(ctx.path, ctx)
  };
  if (extra.inputWitness) {
    data.inputWitness = portableArtifactPath(extra.inputWitness, ctx);
  }
  return data;
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(sortForJson(value))).digest("hex")}`;
}

module.exports = {
  checkManifest,
  domainExclusionClassification,
  executeLossLocalization,
  executePathSet,
  pathDivergenceDetails,
  returnFailureClassification,
  sameLossLocalizationResult
};
