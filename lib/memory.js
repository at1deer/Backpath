"use strict";

function declaredMemorySpec(manifest) {
  const spec = manifest && manifest.memory;
  if (!spec || spec.mode !== "declared") {
    return null;
  }
  return {
    schema: spec.schema || null,
    forwardTargetPath: spec.forwardTargetPath,
    forwardMemoryPath: spec.forwardMemoryPath,
    reverseEnvelope: spec.reverseEnvelope !== false,
    requireBinding: spec.requireBinding === true
  };
}

function hasDeclaredMemory(manifest) {
  return Boolean(declaredMemorySpec(manifest));
}

function extractJsonPointer(value, pointer) {
  if (pointer === "") {
    return { found: true, value };
  }
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    return { found: false, value: undefined };
  }

  let current = value;
  for (const part of parseJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
    } else if (current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      return { found: false, value: undefined };
    }
  }

  return { found: true, value: current };
}

function reverseInputForMemory(target, memory, spec) {
  if (!spec) {
    return target;
  }
  return { target, memory };
}

function parseJsonPointer(pointer) {
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

module.exports = {
  declaredMemorySpec,
  extractJsonPointer,
  hasDeclaredMemory,
  reverseInputForMemory
};
