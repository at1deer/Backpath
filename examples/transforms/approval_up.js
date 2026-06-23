#!/usr/bin/env node
"use strict";

const input = readJson();
const approval = input.approval;

if (approval === "manual" || approval === "automatic") {
  writeJson({ approved: true });
} else if (approval === "rejected") {
  writeJson({ approved: false });
} else {
  process.stderr.write(`unsupported approval: ${approval}\n`);
  process.exitCode = 12;
}

function readJson() {
  return JSON.parse(require("node:fs").readFileSync(0, "utf8"));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
