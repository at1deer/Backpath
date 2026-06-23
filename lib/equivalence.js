"use strict";

const MISSING = Symbol("missing");

function exactKey(value) {
  return JSON.stringify(sortForJson(value));
}

function exactEquivalent(left, right) {
  return exactKey(left) === exactKey(right);
}

function equivalent(left, right, spec) {
  return equivalenceKey(left, spec) === equivalenceKey(right, spec);
}

function equivalenceKey(value, spec) {
  return exactKey(normalizeForEquivalence(value, spec));
}

function differencePaths(left, right) {
  const paths = [];
  collectDifferencePaths(left, right, "", paths);
  return paths.length > 0 ? paths : [""];
}

function differencePathsForEquivalence(left, right, spec) {
  const normalizedLeft = normalizeForEquivalence(left, spec);
  const normalizedRight = normalizeForEquivalence(right, spec);
  if (exactEquivalent(normalizedLeft, normalizedRight)) {
    return [];
  }
  return differencePaths(normalizedLeft, normalizedRight);
}

function normalizeForEquivalence(value, spec) {
  const equivalence = spec || { mode: "exact" };
  if (!equivalence || equivalence.mode !== "structural") {
    return sortForJson(value);
  }

  let normalized = cloneJson(value);
  for (const pointer of equivalence.ignorePaths || []) {
    normalized = removeJsonPointer(normalized, pointer);
  }
  for (const [pointer, normalizer] of Object.entries(equivalence.normalizers || {})) {
    normalized = mapJsonPointer(normalized, pointer, (item) => applyNormalizer(item, normalizer));
  }
  for (const pointer of equivalence.unorderedPaths || []) {
    normalized = mapJsonPointer(normalized, pointer, sortArrayValue);
  }
  return sortForJson(normalized);
}

function collectDifferencePaths(left, right, path, paths) {
  if (exactEquivalent(left, right)) {
    return;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
    for (const key of keys) {
      collectDifferencePaths(
        Object.prototype.hasOwnProperty.call(left, key) ? left[key] : MISSING,
        Object.prototype.hasOwnProperty.call(right, key) ? right[key] : MISSING,
        `${path}/${escapeJsonPointer(key)}`,
        paths
      );
    }
    return;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      collectDifferencePaths(
        index < left.length ? left[index] : MISSING,
        index < right.length ? right[index] : MISSING,
        `${path}/${index}`,
        paths
      );
    }
    return;
  }

  paths.push(path);
}

function sortForJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sortForJson(value[key]);
    }
    return result;
  }
  if (value === MISSING) {
    return { "__backpathMissing": true };
  }
  return value;
}

function removeJsonPointer(value, pointer) {
  if (pointer === "") {
    return null;
  }
  const parts = parseJsonPointer(pointer);
  if (parts.length === 0) {
    return value;
  }
  return removeAtPath(value, parts);
}

function removeAtPath(value, parts) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const [head, ...tail] = parts;
  if (Array.isArray(value)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      return value.map((item) => cloneJson(item));
    }
    if (tail.length === 0) {
      return [...value.slice(0, index), ...value.slice(index + 1)].map((item) => cloneJson(item));
    }
    const next = value.map((item) => cloneJson(item));
    next[index] = removeAtPath(next[index], tail);
    return next;
  }
  if (!Object.prototype.hasOwnProperty.call(value, head)) {
    return cloneJson(value);
  }
  const next = cloneJson(value);
  if (tail.length === 0) {
    delete next[head];
  } else {
    next[head] = removeAtPath(next[head], tail);
  }
  return next;
}

function mapJsonPointer(value, pointer, mapper) {
  if (pointer === "") {
    return mapper(value);
  }
  const parts = parseJsonPointer(pointer);
  return mapAtPath(value, parts, mapper);
}

function mapAtPath(value, parts, mapper) {
  if (parts.length === 0) {
    return mapper(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const [head, ...tail] = parts;
  if (Array.isArray(value)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      return value.map((item) => cloneJson(item));
    }
    const next = value.map((item) => cloneJson(item));
    next[index] = mapAtPath(next[index], tail, mapper);
    return next;
  }
  if (!Object.prototype.hasOwnProperty.call(value, head)) {
    return cloneJson(value);
  }
  const next = cloneJson(value);
  next[head] = mapAtPath(next[head], tail, mapper);
  return next;
}

function applyNormalizer(value, normalizer) {
  if (normalizer === "lowercase" && typeof value === "string") {
    return value.toLowerCase();
  }
  if (normalizer === "uppercase" && typeof value === "string") {
    return value.toUpperCase();
  }
  if (normalizer === "trim" && typeof value === "string") {
    return value.trim();
  }
  if (normalizer === "sort-array") {
    return sortArrayValue(value);
  }
  return value;
}

function sortArrayValue(value) {
  if (!Array.isArray(value)) {
    return value;
  }
  return value
    .map((item) => sortForJson(item))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function parseJsonPointer(pointer) {
  if (pointer === "") {
    return [];
  }
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeJsonPointer(part) {
  return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  differencePaths,
  differencePathsForEquivalence,
  equivalent,
  equivalenceKey,
  exactEquivalent,
  exactKey,
  normalizeForEquivalence,
  sortForJson
};
