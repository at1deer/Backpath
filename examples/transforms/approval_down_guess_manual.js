#!/usr/bin/env node
"use strict";

const input = readJson();

if (input.approved === true) {
  writeJson({ approval: "manual" });
} else if (input.approved === false) {
  writeJson({ approval: "rejected" });
} else {
  process.stderr.write("unsupported approved value\n");
  process.exitCode = 12;
}

function readJson() {
  return JSON.parse(require("node:fs").readFileSync(0, "utf8"));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
