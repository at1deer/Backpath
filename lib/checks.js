"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const {
  differencePaths,
  differencePathsForEquivalence,
  equivalent,
  equivalenceKey,
  exactEquivalent,
  sortForJson
} = require("./equivalence");
const {
  ManifestError,
  operationToWitnessName,
  requireV0CheckSupport,
  resolveManifestPath
} = require("./manifest");
const {
  declaredMemorySpec,
  extractJsonPointer,
  hasDeclaredMemory,
  reverseInputForMemory
} = require("./memory");
const { portableArtifactPath } = require("./pathing");
const { runJsonCommand } = require("./runner");
const { compileSchemaFile, validateWithCompiled } = require("./schema");
const { collectSourceCandidates } = require("./search");
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
  const candidates = collectCandidates(ctx, contracts);
  if (candidates.fatal) {
    return indeterminateSearch(ctx, candidates);
  }
  let evaluated = 0;

  for (const item of candidates.items) {
    evaluated += 1;
    const run = runForward(ctx, item.value);
    const processClassification = domainExclusionClassification(run);
    if (processClassification) {
      return domainExclusionWitness(ctx, contracts, item, {
        classification: processClassification,
        run,
        target: { equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence) },
        diagnostics: []
      }, evaluated, candidates);
    }

    const targetValidation = validateTarget(ctx, contracts, run.output);
    if (!targetValidation.valid) {
      return domainExclusionWitness(ctx, contracts, item, {
        classification: "invalid_target",
        run,
        target: {
          equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
          value: run.output,
          validation: targetValidation
        },
        diagnostics: [{ stage: "forward", classification: "invalid_target", validation: targetValidation }]
      }, evaluated, candidates);
    }
  }

  return notFound(ctx, evaluated, 0, candidates.diagnostics, candidates);
}

function checkReturnFailure(ctx) {
  const contracts = buildContracts(ctx);
  const candidates = collectCandidates(ctx, contracts);
  if (candidates.fatal) {
    return indeterminateSearch(ctx, candidates);
  }
  let evaluated = 0;

  for (const item of candidates.items) {
    evaluated += 1;
    const forwardRun = runForward(ctx, item.value);
    const forwardResult = prepareReturnForward(ctx, contracts, forwardRun);
    if (forwardResult.classification) {
      return returnFailureWitness(ctx, contracts, item, {
        classification: forwardResult.classification,
        forwardRun,
        reverseRun: null,
        target: forwardResult.target,
        memory: forwardResult.memory,
        returned: null,
        sourceValidation: null,
        diagnostics: forwardResult.diagnostics,
        forwardEnvelope: forwardResult.forwardEnvelope,
        reverseInputEnvelope: forwardResult.reverseInputEnvelope
      }, evaluated, candidates);
    }

    const reverseRun = runReverse(ctx, forwardResult.reverseInput);
    const returnFailure = returnFailureClassification(ctx, contracts, item.value, reverseRun);
    if (returnFailure.classification) {
      const diagnostics = diagnosticsForDeclaredMemory(ctx, returnFailure.diagnostics);
      return returnFailureWitness(ctx, contracts, item, {
        classification: returnFailure.classification,
        forwardRun,
        reverseRun,
        target: forwardResult.target,
        memory: forwardResult.memory,
        returned: reverseRun.output === undefined ? null : reverseRun.output,
        sourceValidation: returnFailure.sourceValidation,
        diagnostics,
        forwardEnvelope: forwardResult.forwardEnvelope,
        reverseInputEnvelope: forwardResult.reverseInputEnvelope
      }, evaluated, candidates);
    }
  }

  return notFound(ctx, evaluated, 0, candidates.diagnostics, candidates);
}

function checkDistinctionCollision(ctx) {
  const contracts = buildContracts(ctx);
  const candidates = collectCandidates(ctx, contracts);
  if (candidates.fatal) {
    return indeterminateSearch(ctx, candidates);
  }
  const buckets = new Map();
  const diagnostics = candidates.diagnostics.slice();
  let evaluated = 0;
  let evaluatedPairs = 0;

  for (const item of candidates.items) {
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

    const bucketKey = targetKey(ctx, run.output);
    const candidate = {
      item,
      target: run.output,
      run,
      sourceKey: sourceKey(ctx, item.value)
    };

    const bucket = buckets.get(bucketKey) || [];
    for (const existing of bucket) {
      evaluatedPairs += 1;
      if (!sourceEquivalent(ctx, existing.item.value, candidate.item.value)) {
        return distinctionCollisionWitness(ctx, existing, candidate, evaluated, evaluatedPairs, diagnostics, candidates);
      }
    }
    bucket.push(candidate);
    buckets.set(bucketKey, bucket);
  }

  return notFound(ctx, evaluated, evaluatedPairs, diagnostics, candidates);
}

function checkComparePaths(ctx) {
  const contracts = buildContracts(ctx);
  const candidates = collectCandidates(ctx, contracts);
  if (candidates.fatal) {
    return indeterminateSearch(ctx, candidates);
  }
  let evaluated = 0;
  let evaluatedPairs = 0;

  for (const item of candidates.items) {
    evaluated += 1;
    const pathResults = executePathSet(ctx, item.value);
    const divergence = pathDivergenceDetails(ctx, pathResults);
    evaluatedPairs += divergence ? divergence.evaluatedPairs : countTerminalPairs(pathResults);
    if (divergence) {
      return pathDivergenceWitness(ctx, item, pathResults, divergence, evaluated, evaluatedPairs, candidates);
    }
  }

  return notFound(ctx, evaluated, evaluatedPairs, candidates.diagnostics, candidates);
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

function domainExclusionWitness(ctx, contracts, initialItem, initialFinding, evaluated, candidates) {
  const shrink = shrinkDomainExclusion(ctx, contracts, initialItem, initialFinding);
  const item = shrink ? shrink.item : initialItem;
  const finding = shrink ? shrink.finding : initialFinding;

  return {
    ...baseWitness(ctx, "witnessed", finding.classification),
    summary: finding.classification === "invalid_target"
      ? "The forward transform emitted parseable JSON that failed the target schema."
      : "A valid source candidate could not cross the forward transformation.",
    source: sourceSingle(ctx, item),
    target: finding.target,
    forward: finding.run.toEvidence(),
    minimality: minimality(ctx, shrink),
    reproducibility: reproducibility(ctx, { forwardReplays: 0 }),
    search: search(ctx, evaluated, 0, { witnessed: true, candidates }),
    diagnostics: diagnosticsWithShrink(finding.diagnostics, shrink),
    artifacts: artifacts(ctx)
  };
}

function returnFailureWitness(ctx, contracts, initialItem, initialFinding, evaluated, candidates) {
  const shrink = shrinkReturnFailure(ctx, contracts, initialItem, initialFinding);
  const item = shrink ? shrink.item : initialItem;
  const finding = shrink ? shrink.finding : initialFinding;
  const returned = finding.returned;

  return {
    ...baseWitness(ctx, "witnessed", finding.classification),
    summary: returnSummary(ctx, finding.classification),
    source: {
      ...sourceSingle(ctx, item),
      returned,
      differencePaths: returned === null || returned === undefined ? [] : sourceDifferencePaths(ctx, item.value, returned),
      validation: finding.sourceValidation || item.validation
    },
    target: finding.target,
    memory: finding.memory,
    forward: returnForwardEvidence(finding),
    reverse: finding.reverseRun ? returnReverseEvidence(finding) : {},
    minimality: minimality(ctx, shrink),
    reproducibility: finding.reverseRun
      ? replayCountsForReturn(ctx, item.value, finding)
      : reproducibility(ctx, { forwardReplays: 0, reverseReplays: 0 }),
    search: search(ctx, evaluated, 0, { witnessed: true, candidates }),
    diagnostics: diagnosticsWithShrink(finding.diagnostics, shrink),
    artifacts: artifacts(ctx)
  };
}

function distinctionCollisionWitness(ctx, left, right, evaluated, evaluatedPairs, diagnostics, candidates) {
  const shrink = shrinkDistinctionCollision(ctx, left, right);
  const finalLeft = shrink ? shrink.left : left;
  const finalRight = shrink ? shrink.right : right;
  const leftValue = finalLeft.item.value;
  const rightValue = finalRight.item.value;
  const commonForward = commonCommandEvidence(finalLeft.run.toEvidence());
  return {
    ...baseWitness(ctx, "witnessed", "distinction_collision"),
    summary: `Two ${sourceDistinctPhrase(ctx)} produced ${targetEquivalentPhrase(ctx)}.`,
    source: {
      equivalence: equivalenceMode(ctx.manifest.source && ctx.manifest.source.equivalence),
      a: leftValue,
      b: rightValue,
      aPath: sourceItemPath(ctx, finalLeft.item),
      bPath: sourceItemPath(ctx, finalRight.item),
      differencePaths: sourceDifferencePaths(ctx, leftValue, rightValue)
    },
    target: {
      equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
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
    search: search(ctx, evaluated, evaluatedPairs, { witnessed: true, candidates }),
    diagnostics: diagnosticsWithShrink(diagnostics, shrink),
    artifacts: artifacts(ctx)
  };
}

function pathDivergenceWitness(ctx, item, pathResults, divergence, evaluated, evaluatedPairs, candidates) {
  return {
    ...baseWitness(ctx, "witnessed", "path_divergence"),
    summary: divergence.subtype === "route_failure"
      ? "One path reached a terminal value while another route failed."
      : `Two paths reached ${targetDistinctPhrase(ctx)}.`,
    source: sourceSingle(ctx, item),
    paths: pathResults,
    target: {
      equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
      differencePaths: divergence.differencePaths || [],
      left: divergence.left ? { path: divergence.left.name, value: divergence.left.terminal.value } : null,
      right: divergence.right ? { path: divergence.right.name, value: divergence.right.terminal.value } : null
    },
    minimality: minimality(ctx),
    reproducibility: replayCountsForPathDivergence(ctx, item.value, divergence),
    search: search(ctx, evaluated, evaluatedPairs, { witnessed: true, candidates }),
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
      equivalence: equivalenceMode(evaluation.targetEquivalence),
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
    equivalence: equivalenceMode(evaluation.sourceEquivalence),
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
    return `A source distinction first becomes ${targetEquivalentStatePhraseForSpec(evaluation.targetEquivalence)} at the localized pipeline edge.`;
  }
  if (evaluation.outcome === "already_equivalent") {
    return `The input source pair was already ${sourceEquivalentPhraseForSpec(evaluation.sourceEquivalence)} before the pipeline started.`;
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

function pathDivergenceDetails(ctx, pathResults) {
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
      if (!targetEquivalent(ctx, left.terminal.value, right.terminal.value)) {
        return {
          subtype: "terminal_mismatch",
          left,
          right,
          differencePaths: targetDifferencePaths(ctx, left.terminal.value, right.terminal.value),
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
  let currentEquivalence = exactEquivalenceSpec();
  const startEquivalent = equivalent(sourceA, sourceB, currentEquivalence);
  const startDifferencePaths = startEquivalent ? [] : differencePathsForEquivalence(sourceA, sourceB, currentEquivalence);
  const pipeline = [];
  let currentA = sourceA;
  let currentB = sourceB;
  let previousDifferencePaths = startDifferencePaths;

  if (startEquivalent) {
    return {
      status: "indeterminate",
      classification: "none",
      outcome: "already_equivalent",
      sourceEquivalence: currentEquivalence,
      targetEquivalence: currentEquivalence,
      startDifferencePaths,
      pipeline,
      targetValueA: currentA,
      targetValueB: currentB,
      targetDifferencePaths: [],
      diagnostics: [
        {
          classification: "already_equivalent",
          message: `source.a and source.b are ${sourceEquivalentPhraseForSpec(currentEquivalence)} before the pipeline starts`
        }
      ]
    };
  }

  for (const edge of ctx.manifest.pipeline) {
    const edgeResult = executeLossPipelineEdge(ctx, edge, currentA, currentB, currentEquivalence);
    pipeline.push(edgeResult.evidence);

    if (edgeResult.failed) {
      return {
        status: "indeterminate",
        classification: "none",
        outcome: "edge_failure",
        sourceEquivalence: exactEquivalenceSpec(),
        targetEquivalence: currentEquivalence,
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
        sourceEquivalence: exactEquivalenceSpec(),
        targetEquivalence: edgeResult.targetEquivalence,
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
    currentEquivalence = edge.target.equivalence || exactEquivalenceSpec();
  }

  return {
    status: "not_found_within_budget",
    classification: "none",
    outcome: "no_loss",
    sourceEquivalence: exactEquivalenceSpec(),
    targetEquivalence: currentEquivalence,
    startDifferencePaths,
    pipeline,
    targetValueA: currentA,
    targetValueB: currentB,
    targetDifferencePaths: equivalent(currentA, currentB, currentEquivalence) ? [] : differencePathsForEquivalence(currentA, currentB, currentEquivalence),
    diagnostics: [
      {
        classification: "no-loss-found",
        message: `source.a and source.b remained ${targetDistinctPhraseForSpec(currentEquivalence)} through the full declared pipeline`
      }
    ]
  };
}

function executeLossPipelineEdge(ctx, edge, inputA, inputB, beforeEquivalence) {
  const targetEquivalence = edge.target.equivalence || exactEquivalenceSpec();
  const beforeEquivalent = equivalent(inputA, inputB, beforeEquivalence);
  const beforeDifferencePaths = beforeEquivalent ? [] : differencePathsForEquivalence(inputA, inputB, beforeEquivalence);
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

  const afterEquivalent = equivalent(runA.output, runB.output, targetEquivalence);
  evidence.afterEquivalent = afterEquivalent;
  evidence.afterDifferencePaths = afterEquivalent ? [] : differencePathsForEquivalence(runA.output, runB.output, targetEquivalence);

  return {
    failed: false,
    beforeEquivalent,
    beforeDifferencePaths,
    afterEquivalent,
    afterDifferencePaths: evidence.afterDifferencePaths,
    targetEquivalence,
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
    cost: (candidate, info) => jsonCostForState(candidate, returnDifferenceCount(ctx, candidate, info.finding))
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
    cost: (leftValue, rightValue) => jsonCostForPair(leftValue, rightValue, sourceDifferencePaths(ctx, leftValue, rightValue).length)
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
        target: { equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence) },
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
          equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
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
  const forwardResult = prepareReturnForward(ctx, contracts, forwardRun);
  if (forwardResult.classification) {
    if (expectedClassification !== forwardResult.classification) {
      return { accepted: false };
    }
    return {
      accepted: true,
      validation: sourceValidation,
      finding: {
        classification: forwardResult.classification,
        forwardRun,
        reverseRun: null,
        target: forwardResult.target,
        memory: forwardResult.memory,
        returned: null,
        sourceValidation: null,
        diagnostics: forwardResult.diagnostics,
        forwardEnvelope: forwardResult.forwardEnvelope,
        reverseInputEnvelope: forwardResult.reverseInputEnvelope
      }
    };
  }

  const reverseRun = runReverse(ctx, forwardResult.reverseInput);
  const returnFailure = returnFailureClassification(ctx, contracts, sourceValue, reverseRun);
  if (!returnFailure.classification || returnFailure.classification !== expectedClassification) {
    return { accepted: false };
  }
  const diagnostics = diagnosticsForDeclaredMemory(ctx, returnFailure.diagnostics);

  return {
    accepted: true,
    validation: sourceValidation,
    finding: {
      classification: returnFailure.classification,
      forwardRun,
      reverseRun,
      target: forwardResult.target,
      memory: forwardResult.memory,
      returned: reverseRun.output === undefined ? null : reverseRun.output,
      sourceValidation: returnFailure.sourceValidation,
      diagnostics,
      forwardEnvelope: forwardResult.forwardEnvelope,
      reverseInputEnvelope: forwardResult.reverseInputEnvelope
    }
  };
}

function evaluateDistinctionCollisionCandidate(ctx, contracts, initialLeft, initialRight, leftValue, rightValue) {
  const leftValidation = validateSource(ctx, contracts, leftValue);
  const rightValidation = validateSource(ctx, contracts, rightValue);
  if (!leftValidation.valid || !rightValidation.valid || sourceEquivalent(ctx, leftValue, rightValue)) {
    return { accepted: false };
  }

  const leftRun = runForward(ctx, leftValue);
  const rightRun = runForward(ctx, rightValue);
  if (!leftRun.succeeded || !rightRun.succeeded) {
    return { accepted: false };
  }

  const leftTargetValidation = validateTarget(ctx, contracts, leftRun.output);
  const rightTargetValidation = validateTarget(ctx, contracts, rightRun.output);
  if (!leftTargetValidation.valid || !rightTargetValidation.valid || !targetEquivalent(ctx, leftRun.output, rightRun.output)) {
    return { accepted: false };
  }

  return {
    accepted: true,
    left: {
      item: itemWithValue(initialLeft.item, leftValue, leftValidation),
      target: leftRun.output,
      run: leftRun,
      sourceKey: sourceKey(ctx, leftValue)
    },
    right: {
      item: itemWithValue(initialRight.item, rightValue, rightValidation),
      target: rightRun.output,
      run: rightRun,
      sourceKey: sourceKey(ctx, rightValue)
    }
  };
}

function returnDifferenceCount(ctx, sourceValue, finding) {
  if (!finding || finding.returned === null || finding.returned === undefined) {
    return 0;
  }
  return sourceDifferencePaths(ctx, sourceValue, finding.returned).length;
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

function collectCandidates(ctx, contracts) {
  return collectSourceCandidates(ctx, contracts, {
    validateSource,
    sourceKey
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

function prepareReturnForward(ctx, contracts, forwardRun) {
  const memorySpec = declaredMemorySpec(ctx.manifest);
  const processClassification = domainExclusionClassification(forwardRun);
  if (processClassification) {
    return {
      classification: "forward_excluded",
      target: { equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence) },
      memory: memorySpec ? memoryEvidence(ctx) : undefined,
      diagnostics: [{ stage: "forward", classification: processClassification }],
      forwardEnvelope: Boolean(memorySpec),
      reverseInputEnvelope: false
    };
  }

  if (!memorySpec) {
    return prepareDirectReturnForward(ctx, contracts, forwardRun.output);
  }

  return prepareDeclaredMemoryReturnForward(ctx, contracts, forwardRun.output, memorySpec);
}

function prepareDirectReturnForward(ctx, contracts, output) {
  const targetValidation = validateTarget(ctx, contracts, output);
  if (!targetValidation.valid) {
    return {
      classification: "forward_excluded",
      target: {
        equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
        value: output,
        validation: targetValidation
      },
      diagnostics: [{ stage: "forward", classification: "invalid_target", validation: targetValidation }],
      forwardEnvelope: false,
      reverseInputEnvelope: false
    };
  }

  return {
    classification: null,
    target: {
      equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
      value: output,
      validation: targetValidation
    },
    reverseInput: output,
    diagnostics: [],
    forwardEnvelope: false,
    reverseInputEnvelope: false
  };
}

function prepareDeclaredMemoryReturnForward(ctx, contracts, envelope, memorySpec) {
  const targetExtraction = extractJsonPointer(envelope, memorySpec.forwardTargetPath);
  if (!targetExtraction.found) {
    return retainedMemoryFailure(ctx, {
      subtype: "missing_target",
      target: {
        equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
        envelope: true,
        targetPath: memorySpec.forwardTargetPath,
        found: false
      },
      memory: memoryEvidence(ctx),
      diagnostics: [
        {
          stage: "forward",
          classification: "retained_memory_failure",
          subtype: "missing_target",
          targetPath: memorySpec.forwardTargetPath
        }
      ]
    });
  }

  const targetValidation = validateTarget(ctx, contracts, targetExtraction.value);
  const target = targetEnvelopeEvidence(ctx, targetExtraction.value, targetValidation);
  if (!targetValidation.valid) {
    return {
      classification: "forward_excluded",
      target,
      memory: memoryEvidence(ctx),
      diagnostics: [{ stage: "forward", classification: "invalid_target", validation: targetValidation }],
      forwardEnvelope: true,
      reverseInputEnvelope: false
    };
  }

  const memoryExtraction = extractJsonPointer(envelope, memorySpec.forwardMemoryPath);
  if (!memoryExtraction.found) {
    return retainedMemoryFailure(ctx, {
      subtype: "missing_memory",
      target,
      memory: memoryEvidence(ctx, undefined, null, { found: false }),
      diagnostics: [
        {
          stage: "forward",
          classification: "retained_memory_failure",
          subtype: "missing_memory",
          memoryPath: memorySpec.forwardMemoryPath
        }
      ]
    });
  }

  const memoryValidation = validateMemory(ctx, contracts, memoryExtraction.value);
  const memory = memoryEvidence(ctx, memoryExtraction.value, memoryValidation, { found: true });
  if (!memoryValidation.valid) {
    return retainedMemoryFailure(ctx, {
      subtype: "invalid_memory",
      target,
      memory,
      diagnostics: [
        {
          stage: "forward",
          classification: "retained_memory_failure",
          subtype: "invalid_memory",
          memoryPath: memorySpec.forwardMemoryPath,
          validation: memoryValidation
        }
      ]
    });
  }

  return {
    classification: null,
    target,
    memory,
    reverseInput: reverseInputForMemory(targetExtraction.value, memoryExtraction.value, memorySpec),
    diagnostics: [],
    forwardEnvelope: true,
    reverseInputEnvelope: true
  };
}

function retainedMemoryFailure(ctx, data) {
  return {
    classification: "retained_memory_failure",
    target: data.target,
    memory: data.memory,
    diagnostics: data.diagnostics,
    forwardEnvelope: true,
    reverseInputEnvelope: false
  };
}

function targetEnvelopeEvidence(ctx, value, validation) {
  const memorySpec = declaredMemorySpec(ctx.manifest);
  return {
    equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
    value,
    validation,
    envelope: true,
    targetPath: memorySpec.forwardTargetPath
  };
}

function memoryEvidence(ctx, value, validation = null, extra = {}) {
  const memorySpec = declaredMemorySpec(ctx.manifest);
  if (!memorySpec) {
    return undefined;
  }
  const evidence = {
    declared: true,
    memoryPath: memorySpec.forwardMemoryPath,
    bindingChecked: false,
    ...extra
  };
  if (memorySpec.schema) {
    evidence.schema = portableArtifactPath(resolveManifestPath(ctx, memorySpec.schema), ctx);
  }
  if (Object.prototype.hasOwnProperty.call(arguments, 1) && value !== undefined) {
    evidence.value = value;
  }
  if (validation) {
    evidence.validation = validation;
  }
  return evidence;
}

function diagnosticsForDeclaredMemory(ctx, diagnostics) {
  if (!hasDeclaredMemory(ctx.manifest)) {
    return diagnostics;
  }
  return [
    ...diagnostics,
    {
      stage: "reverse",
      classification: "insufficient_memory",
      subtype: "insufficient_memory",
      message: "Declared memory was present and valid, but reverse did not reconstruct an equivalent source."
    }
  ];
}

function forwardExcludedClassification(ctx, contracts, forwardRun) {
  const processClassification = domainExclusionClassification(forwardRun);
  if (processClassification) {
    return {
      classification: "forward_excluded",
      target: { equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence) },
      diagnostics: [{ stage: "forward", classification: processClassification }]
    };
  }

  const targetValidation = validateTarget(ctx, contracts, forwardRun.output);
  if (!targetValidation.valid) {
    return {
      classification: "forward_excluded",
      target: {
        equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
        value: forwardRun.output,
        validation: targetValidation
      },
      diagnostics: [{ stage: "forward", classification: "invalid_target", validation: targetValidation }]
    };
  }

  return {
    classification: null,
    target: {
      equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence),
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

  if (!sourceEquivalent(ctx, source, reverseRun.output)) {
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

function returnSummary(ctx, classification) {
  if (classification === "forward_excluded") {
    return "The forward transform did not produce a valid target during return testing.";
  }
  if (classification === "return_drift") {
    return `Forward and reverse succeeded, but the returned source was not ${sourceEquivalentPhrase(ctx)} to the original.`;
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
  if (classification === "retained_memory_failure") {
    return "The declared retained-memory contract was missing or invalid before reverse could run.";
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

function notFound(ctx, evaluatedStates, evaluatedPairs, diagnostics = [], candidates = null) {
  const proven = candidates && candidates.metadata && candidates.metadata.mode === "exhaustive" && candidates.metadata.domainExhaustive;
  const status = proven ? "proven_within_domain" : "not_found_within_budget";
  return {
    ...baseWitness(ctx, status, "none"),
    summary: proven
      ? "No witnessed finding was found within the declared finite enumerator domain."
      : "No witnessed finding was found within the search budget.",
    source: { equivalence: equivalenceMode(ctx.manifest.source && ctx.manifest.source.equivalence) },
    target: { equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence) },
    minimality: minimality(ctx),
    reproducibility: reproducibility(ctx),
    search: search(ctx, evaluatedStates, evaluatedPairs, { candidates }),
    diagnostics,
    artifacts: artifacts(ctx)
  };
}

function indeterminateSearch(ctx, candidates) {
  return {
    ...baseWitness(ctx, "indeterminate", "none"),
    summary: "Search candidates could not be collected under the declared protocol.",
    source: { equivalence: equivalenceMode(ctx.manifest.source && ctx.manifest.source.equivalence) },
    target: { equivalence: equivalenceMode(ctx.manifest.target && ctx.manifest.target.equivalence) },
    minimality: minimality(ctx),
    reproducibility: reproducibility(ctx),
    search: search(ctx, 0, 0, { candidates }),
    diagnostics: candidates.diagnostics,
    artifacts: artifacts(ctx)
  };
}

function sourceSingle(ctx, item) {
  const source = {
    equivalence: ctx.manifest.source.equivalence.mode,
    value: item.value,
    validation: item.validation
  };
  const itemPath = sourceItemPath(ctx, item);
  if (itemPath) {
    source.path = itemPath;
  }
  if (item.origin) {
    source.origin = item.origin;
  }
  if (item.derivedFrom) {
    source.derivedFrom = item.derivedFrom;
  }
  return source;
}

function sourceItemPath(ctx, item) {
  if (item.path) {
    return portableArtifactPath(item.path, ctx);
  }
  if (item.label) {
    return item.label;
  }
  return null;
}

function exactEquivalenceSpec() {
  return { mode: "exact" };
}

function equivalenceMode(spec) {
  if (typeof spec === "string") {
    return spec;
  }
  return (spec && spec.mode) || "exact";
}

function sourceDistinctPhrase(ctx) {
  return equivalenceMode(ctx.manifest.source && ctx.manifest.source.equivalence) === "exact"
    ? "source-distinct candidates"
    : "candidates distinct under the declared source equivalence";
}

function sourceEquivalentPhrase(ctx) {
  return sourceEquivalentPhraseForSpec(ctx.manifest.source && ctx.manifest.source.equivalence);
}

function sourceEquivalentPhraseForSpec(spec) {
  return equivalenceMode(spec) === "exact"
    ? "exact-equivalent"
    : "source-equivalent under the declared source equivalence";
}

function targetEquivalentPhrase(ctx) {
  return targetEquivalentPhraseForSpec(ctx.manifest.target && ctx.manifest.target.equivalence);
}

function targetEquivalentPhraseForSpec(spec) {
  return equivalenceMode(spec) === "exact"
    ? "exact-equivalent target values"
    : "target-equivalent values under the declared target equivalence";
}

function targetEquivalentStatePhraseForSpec(spec) {
  return equivalenceMode(spec) === "exact"
    ? "exact-equivalent"
    : "target-equivalent under the declared target equivalence";
}

function targetDistinctPhrase(ctx) {
  return targetDistinctPhraseForSpec(ctx.manifest.target && ctx.manifest.target.equivalence);
}

function targetDistinctPhraseForSpec(spec) {
  return equivalenceMode(spec) === "exact"
    ? "exact-distinct terminal values"
    : "terminal values distinct under the declared target equivalence";
}

function sourceEquivalenceSpec(ctx) {
  return (ctx.manifest.source && ctx.manifest.source.equivalence) || exactEquivalenceSpec();
}

function targetEquivalenceSpec(ctx) {
  return (ctx.manifest.target && ctx.manifest.target.equivalence) || exactEquivalenceSpec();
}

function sourceEquivalent(ctx, left, right) {
  return equivalent(left, right, sourceEquivalenceSpec(ctx));
}

function targetEquivalent(ctx, left, right) {
  return equivalent(left, right, targetEquivalenceSpec(ctx));
}

function sourceDifferencePaths(ctx, left, right) {
  return differencePathsForEquivalence(left, right, sourceEquivalenceSpec(ctx));
}

function targetDifferencePaths(ctx, left, right) {
  return differencePathsForEquivalence(left, right, targetEquivalenceSpec(ctx));
}

function sourceKey(ctx, value) {
  return equivalenceKey(value, sourceEquivalenceSpec(ctx));
}

function targetKey(ctx, value) {
  return equivalenceKey(value, targetEquivalenceSpec(ctx));
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
    if (!targetEquivalent(ctx, runA.output, targetA) || !targetEquivalent(ctx, runB.output, targetB)) {
      break;
    }
    forwardReplays += 1;
  }
  return reproducibility(ctx, {
    forwardReplays,
    equivalenceReplays: (ctx.manifest.replay && ctx.manifest.replay.equivalence) || 1
  });
}

function replayCountsForReturn(ctx, source, finding) {
  const requestedForward = (ctx.manifest.replay && ctx.manifest.replay.forward) || 1;
  const requestedReverse = (ctx.manifest.replay && ctx.manifest.replay.reverse) || 1;
  const contracts = buildContracts(ctx);
  let forwardReplays = 0;
  let reverseReplays = 0;

  for (let index = 0; index < requestedForward; index += 1) {
    const run = runForward(ctx, source);
    const forwardResult = run.succeeded ? prepareReturnForward(ctx, contracts, run) : null;
    if (!forwardResult || forwardResult.classification || !sameReturnForwardResult(ctx, finding, forwardResult)) {
      break;
    }
    forwardReplays += 1;
  }

  for (let index = 0; index < requestedReverse; index += 1) {
    const forwardRun = runForward(ctx, source);
    const forwardResult = forwardRun.succeeded ? prepareReturnForward(ctx, contracts, forwardRun) : null;
    if (!forwardResult || forwardResult.classification || !sameReturnForwardResult(ctx, finding, forwardResult)) {
      break;
    }
    const run = runReverse(ctx, forwardResult.reverseInput);
    if (!run.succeeded || !sourceEquivalent(ctx, run.output, finding.returned)) {
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

function sameReturnForwardResult(ctx, finding, forwardResult) {
  if (!targetEquivalent(ctx, forwardResult.target.value, finding.target && finding.target.value)) {
    return false;
  }
  if (hasDeclaredMemory(ctx.manifest)) {
    return (
      finding.memory &&
      forwardResult.memory &&
      exactEquivalent(forwardResult.memory.value, finding.memory.value)
    );
  }
  return true;
}

function replayCountsForPathDivergence(ctx, source, originalDivergence) {
  const requestedPathReplays = (ctx.manifest.replay && ctx.manifest.replay.forward) || 1;
  let stablePathReplays = 0;

  for (let index = 0; index < requestedPathReplays; index += 1) {
    const pathResults = executePathSet(ctx, source);
    const replayDivergence = pathDivergenceDetails(ctx, pathResults);
    if (!samePathDivergence(ctx, originalDivergence, replayDivergence)) {
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

function samePathDivergence(ctx, left, right) {
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
    targetEquivalent(ctx, left.left.terminal.value, right.left.terminal.value) &&
    targetEquivalent(ctx, left.right.terminal.value, right.right.terminal.value)
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
  const metadata = (options.candidates && options.candidates.metadata) || {};
  const searchSpec = ctx.manifest.search || {};
  return {
    mode: metadata.mode || searchSpec.mode,
    budget: metadata.budget || searchSpec.budget,
    seed: Object.prototype.hasOwnProperty.call(metadata, "seed") ? metadata.seed : searchSpec.seed,
    candidateCount: metadata.candidateCount || 0,
    validCandidateCount: metadata.validCandidateCount || 0,
    invalidCandidateCount: metadata.invalidCandidateCount || 0,
    deduplicatedCandidateCount: metadata.deduplicatedCandidateCount || 0,
    evaluatedStates,
    evaluatedPairs,
    domainExhaustive: Boolean(metadata.domainExhaustive),
    corpusExhausted: Boolean(metadata.corpusExhausted),
    enumeratorExhausted: Boolean(metadata.enumeratorExhausted),
    generatorExhausted: Boolean(metadata.generatorExhausted),
    generated: Boolean(metadata.generated),
    mutationBudgetExhausted: Boolean(metadata.mutationBudgetExhausted)
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
    target: compileDomainSchema(ctx, "target"),
    memory: compileMemorySchema(ctx)
  };
}

function compileDomainSchema(ctx, label) {
  return compileDomainSpec(ctx, ctx.manifest[label], `${label}.schema`);
}

function compileMemorySchema(ctx) {
  const memory = ctx.manifest.memory;
  if (!memory || !memory.schema) {
    return null;
  }
  try {
    return compileSchemaFile(resolveManifestPath(ctx, memory.schema));
  } catch (error) {
    throw new ManifestError([`memory.schema could not be loaded: ${memory.schema}`, error.message]);
  }
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

function validateMemory(ctx, contracts, value) {
  return validationEvidence(ctx, validateWithCompiled(contracts.memory, value));
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

function returnForwardEvidence(finding) {
  const evidence = finding.forwardRun.toEvidence();
  if (finding.forwardEnvelope) {
    evidence.outputEnvelope = true;
    if (finding.target && finding.target.targetPath) {
      evidence.targetPath = finding.target.targetPath;
    }
    if (finding.memory && finding.memory.memoryPath) {
      evidence.memoryPath = finding.memory.memoryPath;
    }
  }
  return evidence;
}

function returnReverseEvidence(finding) {
  const evidence = finding.reverseRun.toEvidence();
  if (finding.reverseInputEnvelope) {
    evidence.inputEnvelope = true;
  }
  return evidence;
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
