"use strict";

const MISSING = Symbol("missing");

function exactKey(value) {
  return JSON.stringify(sortForJson(value));
}

function exactEquivalent(left, right) {
  return exactKey(left) === exactKey(right);
}

function differencePaths(left, right) {
  const paths = [];
  collectDifferencePaths(left, right, "", paths);
  return paths.length > 0 ? paths : [""];
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeJsonPointer(part) {
  return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

module.exports = {
  differencePaths,
  exactEquivalent,
  exactKey,
  sortForJson
};
