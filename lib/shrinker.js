"use strict";

const { differencePaths, sortForJson } = require("./equivalence");

function jsonCostForState(value, differencePathCount = 0) {
  const stats = jsonStats(value);
  return [
    differencePathCount,
    stats.nodeCount,
    stats.maxDepth,
    stats.byteSize,
    stats.scalarComplexity,
    canonicalJson(value)
  ];
}

function jsonCostForPair(left, right) {
  const stats = combineStats(jsonStats(left), jsonStats(right));
  return [
    differencePaths(left, right).length,
    stats.nodeCount,
    stats.maxDepth,
    stats.byteSize,
    stats.scalarComplexity,
    `${canonicalJson(left)}\u0000${canonicalJson(right)}`
  ];
}

function jsonStats(value) {
  return {
    nodeCount: countNodes(value),
    maxDepth: maxDepth(value),
    byteSize: Buffer.byteLength(canonicalJson(value), "utf8"),
    scalarComplexity: scalarComplexity(value)
  };
}

function shrinkSingle(initialValue, options) {
  const budget = Math.max(0, options.budget || 0);
  let current = cloneJson(initialValue);
  let currentInfo = options.initialInfo || options.predicate(current);
  let currentCost = options.cost(current, currentInfo);
  let attempts = 0;
  let accepted = 0;
  let budgetExhausted = false;

  while (attempts < budget) {
    let nextAccepted = null;
    const candidates = generateSingleCandidates(current);

    for (const candidate of candidates) {
      if (attempts >= budget) {
        budgetExhausted = true;
        break;
      }
      attempts += 1;

      const info = options.predicate(candidate);
      if (!info || !info.accepted) {
        continue;
      }

      const candidateCost = options.cost(candidate, info);
      if (compareCosts(candidateCost, currentCost) >= 0) {
        continue;
      }
      nextAccepted = { value: candidate, info, cost: candidateCost };
      break;
    }

    if (!nextAccepted) {
      break;
    }

    current = nextAccepted.value;
    currentInfo = nextAccepted.info;
    currentCost = nextAccepted.cost;
    accepted += 1;
  }

  return {
    value: current,
    info: currentInfo,
    cost: currentCost,
    attempts,
    accepted,
    budgetExhausted
  };
}

function shrinkPair(initialLeft, initialRight, options) {
  const budget = Math.max(0, options.budget || 0);
  let current = {
    left: cloneJson(initialLeft),
    right: cloneJson(initialRight)
  };
  let currentInfo = options.initialInfo || options.predicate(current.left, current.right);
  let currentCost = options.cost(current.left, current.right, currentInfo);
  let attempts = 0;
  let accepted = 0;
  let budgetExhausted = false;

  while (attempts < budget) {
    let nextAccepted = null;
    const candidates = generatePairCandidates(current.left, current.right);

    for (const candidate of candidates) {
      if (attempts >= budget) {
        budgetExhausted = true;
        break;
      }
      attempts += 1;

      const info = options.predicate(candidate.left, candidate.right);
      if (!info || !info.accepted) {
        continue;
      }

      const candidateCost = options.cost(candidate.left, candidate.right, info);
      if (compareCosts(candidateCost, currentCost) >= 0) {
        continue;
      }
      nextAccepted = { value: candidate, info, cost: candidateCost };
      break;
    }

    if (!nextAccepted) {
      break;
    }

    current = nextAccepted.value;
    currentInfo = nextAccepted.info;
    currentCost = nextAccepted.cost;
    accepted += 1;
  }

  return {
    left: current.left,
    right: current.right,
    info: currentInfo,
    cost: currentCost,
    attempts,
    accepted,
    budgetExhausted
  };
}

function generateSingleCandidates(value) {
  return uniqueJsonCandidates(rawSingleCandidates(value));
}

function rawSingleCandidates(value) {
  if (Array.isArray(value)) {
    const candidates = [];
    for (let index = 0; index < value.length; index += 1) {
      candidates.push([...value.slice(0, index), ...value.slice(index + 1)]);
      for (const child of generateSingleCandidates(value[index])) {
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

      for (const child of generateSingleCandidates(value[key])) {
        candidates.push({ ...value, [key]: child });
      }
    }
    return candidates;
  }

  return scalarCandidates(value);
}

function generatePairCandidates(left, right) {
  return uniquePairCandidates([
    ...pairDeletionCandidates(left, right),
    ...pairAlignmentCandidates(left, right)
  ]);
}

function pairDeletionCandidates(left, right) {
  const candidates = [];

  if (isPlainObject(left) && isPlainObject(right)) {
    const commonKeys = Object.keys(left).filter((key) => Object.prototype.hasOwnProperty.call(right, key)).sort();
    for (const key of commonKeys) {
      const nextLeft = { ...left };
      const nextRight = { ...right };
      delete nextLeft[key];
      delete nextRight[key];
      candidates.push({ left: nextLeft, right: nextRight });
    }
  }

  for (const candidate of generateSingleCandidates(left)) {
    candidates.push({ left: candidate, right });
  }
  for (const candidate of generateSingleCandidates(right)) {
    candidates.push({ left, right: candidate });
  }

  return candidates;
}

function pairAlignmentCandidates(left, right) {
  const candidates = [];
  for (const pathParts of collectDifferingLeafPaths(left, right)) {
    const leftValue = getAtPath(left, pathParts);
    const rightValue = getAtPath(right, pathParts);
    if (leftValue.exists && rightValue.exists) {
      candidates.push({ left: setAtPath(left, pathParts, rightValue.value), right });
      candidates.push({ left, right: setAtPath(right, pathParts, leftValue.value) });
    }
  }
  return candidates;
}

function scalarCandidates(value) {
  if (typeof value === "string") {
    const candidates = [""];
    const trimmed = value.trim();
    if (trimmed !== value) {
      candidates.push(trimmed);
    }
    if (value.length > 1) {
      candidates.push(value.slice(0, 1));
    }
    const lower = value.toLowerCase();
    if (lower !== value) {
      candidates.push(lower);
    }
    return candidates;
  }
  if (typeof value === "number") {
    return [0, 1, -1].filter((candidate) => candidate !== value);
  }
  if (typeof value === "boolean") {
    return [!value];
  }
  if (value !== null) {
    return [null];
  }
  return [];
}

function collectDifferingLeafPaths(left, right) {
  const paths = [];
  collectDifferingLeafPathsInto(left, right, [], paths);
  return paths;
}

function collectDifferingLeafPathsInto(left, right, pathParts, paths) {
  if (canonicalJson(left) === canonicalJson(right)) {
    return;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(left, key) && Object.prototype.hasOwnProperty.call(right, key)) {
        collectDifferingLeafPathsInto(left[key], right[key], [...pathParts, key], paths);
      }
    }
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      collectDifferingLeafPathsInto(left[index], right[index], [...pathParts, index], paths);
    }
    return;
  }
  paths.push(pathParts);
}

function getAtPath(value, pathParts) {
  let current = value;
  for (const part of pathParts) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function setAtPath(value, pathParts, replacement) {
  if (pathParts.length === 0) {
    return cloneJson(replacement);
  }
  const [head, ...tail] = pathParts;
  const next = Array.isArray(value) ? value.slice() : { ...value };
  next[head] = setAtPath(value[head], tail, replacement);
  return next;
}

function compareCosts(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (typeof leftValue === "string" || typeof rightValue === "string") {
      return String(leftValue).localeCompare(String(rightValue));
    }
    return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

function countNodes(value) {
  if (Array.isArray(value)) {
    return 1 + value.reduce((total, item) => total + countNodes(item), 0);
  }
  if (isPlainObject(value)) {
    return 1 + Object.values(value).reduce((total, item) => total + countNodes(item), 0);
  }
  return 1;
}

function maxDepth(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? 1 : 1 + Math.max(...value.map(maxDepth));
  }
  if (isPlainObject(value)) {
    const values = Object.values(value);
    return values.length === 0 ? 1 : 1 + Math.max(...values.map(maxDepth));
  }
  return 1;
}

function scalarComplexity(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + scalarComplexity(item), 0);
  }
  if (isPlainObject(value)) {
    return Object.values(value).reduce((total, item) => total + scalarComplexity(item), 0);
  }
  if (typeof value === "string") {
    return value.length;
  }
  if (typeof value === "number") {
    return String(value).length;
  }
  return 1;
}

function combineStats(left, right) {
  return {
    nodeCount: left.nodeCount + right.nodeCount,
    maxDepth: Math.max(left.maxDepth, right.maxDepth),
    byteSize: left.byteSize + right.byteSize,
    scalarComplexity: left.scalarComplexity + right.scalarComplexity
  };
}

function uniqueJsonCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = canonicalJson(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }
  return unique;
}

function uniquePairCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = `${canonicalJson(candidate.left)}\u0000${canonicalJson(candidate.right)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }
  return unique;
}

function canonicalJson(value) {
  return JSON.stringify(sortForJson(value));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  compareCosts,
  generatePairCandidates,
  generateSingleCandidates,
  jsonCostForPair,
  jsonCostForState,
  jsonStats,
  shrinkPair,
  shrinkSingle
};
