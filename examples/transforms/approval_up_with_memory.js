#!/usr/bin/env node
"use strict";

const input = readJson();
const approval = input.approval;

if (approval === "manual" || approval === "automatic") {
  writeJson({
    target: { approved: true },
    memory: { approvalMode: approval }
  });
} else if (approval === "rejected") {
  writeJson({
    target: { approved: false },
    memory: { approvalMode: approval }
  });
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
