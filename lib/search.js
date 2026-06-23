"use strict";

const {
  ManifestError,
  corpusPaths,
  loadJsonAt
} = require("./manifest");
const { portableArtifactPath } = require("./pathing");
const { runJsonCommand } = require("./runner");

function collectSourceCandidates(ctx, contracts, helpers) {
  const searchSpec = ctx.manifest.search || {};
  const mode = searchSpec.mode || "corpus";
  const budget = searchSpec.budget || 10000;

  if (mode === "corpus") {
    return collectCorpusCandidates(ctx, contracts, helpers, budget);
  }
  if (mode === "exhaustive") {
    return collectCommandCandidates(ctx, contracts, helpers, {
      kind: "enumerator",
      command: ctx.manifest.source && ctx.manifest.source.enumerator,
      mode,
      budget
    });
  }
  if (mode === "generate") {
    return collectCommandCandidates(ctx, contracts, helpers, {
      kind: "generator",
      command: ctx.manifest.source && ctx.manifest.source.generator,
      mode,
      budget
    });
  }
  if (mode === "corpus-mutation") {
    return collectMutationCandidates(ctx, contracts, helpers, budget);
  }

  return fatalCollection(ctx, {
    classification: "unsupported_search_mode",
    message: `unsupported search.mode='${mode}'`
  });
}

function collectCorpusCandidates(ctx, contracts, helpers, budget) {
  const raw = loadCorpusItems(ctx, contracts, helpers);
  const selected = raw.slice(0, budget);
  const deduped = dedupeValidCandidates(ctx, selected, helpers);
  return {
    items: deduped.items,
    diagnostics: deduped.diagnostics,
    metadata: {
      mode: "corpus",
      budget,
      seed: ctx.manifest.search && ctx.manifest.search.seed,
      candidateCount: raw.length,
      validCandidateCount: selected.length,
      invalidCandidateCount: 0,
      deduplicatedCandidateCount: deduped.items.length,
      domainExhaustive: false,
      corpusExhausted: raw.length <= budget,
      enumeratorExhausted: false,
      generatorExhausted: false,
      generated: false,
      mutationBudgetExhausted: false
    }
  };
}

function collectCommandCandidates(ctx, contracts, helpers, options) {
  const envelope = {
    seed: ctx.manifest.search && ctx.manifest.search.seed,
    budget: options.budget,
    mode: options.mode
  };
  const run = runJsonCommand(options.command, envelope, ctx.baseDir, {
    stage: options.kind,
    portableContext: ctx,
    argvBaseDir: ctx.baseDir
  });

  const baseMetadata = {
    mode: options.mode,
    budget: options.budget,
    seed: ctx.manifest.search && ctx.manifest.search.seed,
    candidateCount: 0,
    validCandidateCount: 0,
    invalidCandidateCount: 0,
    deduplicatedCandidateCount: 0,
    domainExhaustive: false,
    corpusExhausted: false,
    enumeratorExhausted: options.kind === "enumerator" && run.succeeded,
    generatorExhausted: options.kind === "generator" && run.succeeded,
    generated: options.kind === "generator",
    mutationBudgetExhausted: false,
    command: run.toEvidence()
  };

  if (run.timeout || run.executionError || run.signal || run.exitCode === null || (run.exitCode !== null && run.exitCode !== 0)) {
    return fatalCollection(ctx, {
      stage: options.kind,
      classification: `${options.kind}_failed`,
      command: run.toEvidence()
    }, baseMetadata);
  }

  if (run.malformedOutput) {
    return fatalCollection(ctx, {
      stage: options.kind,
      classification: `${options.kind}_malformed_output`,
      command: run.toEvidence()
    }, baseMetadata);
  }

  if (!Array.isArray(run.output)) {
    return fatalCollection(ctx, {
      stage: options.kind,
      classification: `${options.kind}_invalid_protocol`,
      message: `${options.kind} stdout must be a JSON array`,
      command: run.toEvidence()
    }, baseMetadata);
  }

  if (run.output.length > options.budget) {
    return fatalCollection(ctx, {
      stage: options.kind,
      classification: `${options.kind}_exceeded_budget`,
      candidateCount: run.output.length,
      budget: options.budget,
      command: run.toEvidence()
    }, {
      ...baseMetadata,
      candidateCount: run.output.length
    });
  }

  const validated = validateExternalCandidates(ctx, contracts, helpers, run.output, options.kind);
  const metadata = {
    ...baseMetadata,
    candidateCount: run.output.length,
    validCandidateCount: validated.valid.length,
    invalidCandidateCount: validated.invalid.length
  };

  if (options.kind === "enumerator" && validated.invalid.length > 0) {
    return fatalCollection(ctx, {
      stage: options.kind,
      classification: "enumerator_invalid_candidate",
      invalidCandidateCount: validated.invalid.length,
      invalidCandidates: validated.invalid.slice(0, 5)
    }, metadata);
  }

  if (validated.valid.length === 0) {
    return fatalCollection(ctx, {
      stage: options.kind,
      classification: `${options.kind}_no_valid_candidates`,
      invalidCandidateCount: validated.invalid.length,
      invalidCandidates: validated.invalid.slice(0, 5)
    }, metadata);
  }

  const deduped = dedupeValidCandidates(ctx, validated.valid, helpers);
  const diagnostics = [];
  if (validated.invalid.length > 0) {
    diagnostics.push({
      stage: options.kind,
      classification: "invalid_candidates",
      invalidCandidateCount: validated.invalid.length,
      invalidCandidates: validated.invalid.slice(0, 5)
    });
  }

  return {
    items: deduped.items,
    diagnostics: diagnostics.concat(deduped.diagnostics),
    metadata: {
      ...metadata,
      deduplicatedCandidateCount: deduped.items.length,
      domainExhaustive: options.kind === "enumerator",
      enumeratorExhausted: options.kind === "enumerator",
      generatorExhausted: options.kind === "generator",
      generated: options.kind === "generator"
    }
  };
}

function collectMutationCandidates(ctx, contracts, helpers, budget) {
  const corpus = loadCorpusItems(ctx, contracts, helpers);
  const raw = [];
  let mutationBudgetExhausted = false;

  for (const item of corpus) {
    if (raw.length >= budget) {
      mutationBudgetExhausted = true;
      break;
    }
    raw.push(item);

    const mutations = generateMutationCandidates(item.value);
    for (const mutation of mutations) {
      if (raw.length >= budget) {
        mutationBudgetExhausted = true;
        break;
      }
      raw.push({
        value: mutation,
        origin: "mutation",
        label: `mutation[${raw.length}]`,
        derivedFrom: item.path ? portableArtifactPath(item.path, ctx) : item.label
      });
    }
  }

  const validated = validateMutationCandidates(ctx, contracts, helpers, raw);
  const deduped = dedupeValidCandidates(ctx, validated.valid, helpers);
  const diagnostics = [];
  if (validated.invalid.length > 0) {
    diagnostics.push({
      stage: "corpus-mutation",
      classification: "invalid_candidates",
      invalidCandidateCount: validated.invalid.length
    });
  }

  return {
    items: deduped.items,
    diagnostics: diagnostics.concat(deduped.diagnostics),
    metadata: {
      mode: "corpus-mutation",
      budget,
      seed: ctx.manifest.search && ctx.manifest.search.seed,
      candidateCount: raw.length,
      validCandidateCount: validated.valid.length,
      invalidCandidateCount: validated.invalid.length,
      deduplicatedCandidateCount: deduped.items.length,
      domainExhaustive: false,
      corpusExhausted: true,
      enumeratorExhausted: false,
      generatorExhausted: false,
      generated: false,
      mutationBudgetExhausted
    }
  };
}

function loadCorpusItems(ctx, contracts, helpers) {
  return corpusPaths(ctx).map((itemPath) => {
    const value = loadJsonAt(itemPath);
    const sourceValidation = helpers.validateSource(ctx, contracts, value);
    if (!sourceValidation.valid) {
      throw new ManifestError([
        `source corpus item failed source.schema: ${portableArtifactPath(itemPath, ctx)}`,
        ...sourceValidation.errors
      ]);
    }
    return {
      path: itemPath,
      origin: "corpus",
      value,
      validation: sourceValidation
    };
  });
}

function validateExternalCandidates(ctx, contracts, helpers, values, origin) {
  const valid = [];
  const invalid = [];

  values.forEach((value, index) => {
    const validation = helpers.validateSource(ctx, contracts, value);
    const item = {
      value,
      origin,
      label: `${origin}[${index}]`,
      validation
    };
    if (validation.valid) {
      valid.push(item);
    } else {
      invalid.push({
        index,
        value,
        errors: validation.errors
      });
    }
  });

  return { valid, invalid };
}

function validateMutationCandidates(ctx, contracts, helpers, items) {
  const valid = [];
  const invalid = [];

  items.forEach((item, index) => {
    if (item.validation && item.validation.valid) {
      valid.push(item);
      return;
    }
    const validation = helpers.validateSource(ctx, contracts, item.value);
    if (validation.valid) {
      valid.push({ ...item, validation });
    } else {
      invalid.push({
        index,
        origin: item.origin,
        errors: validation.errors
      });
    }
  });

  return { valid, invalid };
}

function dedupeValidCandidates(ctx, items, helpers) {
  const seen = new Set();
  const deduped = [];
  let duplicateCount = 0;

  for (const item of items) {
    const key = helpers.sourceKey(ctx, item.value);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    deduped.push({ ...item, sourceKey: key });
  }

  const diagnostics = duplicateCount > 0
    ? [{ classification: "deduplicated_candidates", duplicateCandidateCount: duplicateCount }]
    : [];
  return { items: deduped, diagnostics };
}

function fatalCollection(ctx, diagnostic, metadata = {}) {
  return {
    fatal: true,
    items: [],
    diagnostics: [diagnostic],
    metadata: {
      mode: ctx.manifest.search && ctx.manifest.search.mode,
      budget: ctx.manifest.search && ctx.manifest.search.budget,
      seed: ctx.manifest.search && ctx.manifest.search.seed,
      candidateCount: 0,
      validCandidateCount: 0,
      invalidCandidateCount: 0,
      deduplicatedCandidateCount: 0,
      domainExhaustive: false,
      corpusExhausted: false,
      enumeratorExhausted: false,
      generatorExhausted: false,
      generated: false,
      mutationBudgetExhausted: false,
      ...metadata
    }
  };
}

function generateMutationCandidates(value) {
  return uniqueJsonCandidates(rawMutationCandidates(value));
}

function rawMutationCandidates(value) {
  if (Array.isArray(value)) {
    const candidates = [];
    candidates.push([]);
    if (value.length > 1) {
      candidates.push(value.slice().reverse());
    }
    for (let index = 0; index < value.length; index += 1) {
      candidates.push([cloneJson(value[index])]);
      candidates.push([...value.slice(0, index), ...value.slice(index + 1)]);
      for (const child of generateMutationCandidates(value[index])) {
        const next = value.slice();
        next[index] = child;
        candidates.push(next);
      }
    }
    return candidates;
  }

  if (isPlainObject(value)) {
    const candidates = [];
    for (const key of Object.keys(value).sort()) {
      const without = { ...value };
      delete without[key];
      candidates.push(without);

      for (const child of generateMutationCandidates(value[key])) {
        candidates.push({ ...value, [key]: child });
      }
    }
    return candidates;
  }

  return scalarMutationCandidates(value);
}

function scalarMutationCandidates(value) {
  const candidates = [
    "",
    "a",
    "manual",
    "automatic",
    "pending_review",
    "unknown",
    0,
    1,
    -1,
    true,
    false,
    null
  ];
  return candidates.filter((candidate) => !sameJson(candidate, value));
}

function uniqueJsonCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  collectSourceCandidates,
  generateMutationCandidates
};
