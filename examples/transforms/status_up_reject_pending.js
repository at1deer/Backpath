#!/usr/bin/env node
"use strict";

const input = readJson();

if (input.status === "active") {
  writeJson({ state: "enabled" });
} else if (input.status === "suspended") {
  writeJson({ state: "disabled" });
} else if (input.status === "closed") {
  writeJson({ state: "archived" });
} else if (input.status === "pending_review") {
  process.stderr.write("unsupported status: pending_review\n");
  process.exitCode = 12;
} else {
  process.stderr.write(`unknown status: ${input.status}\n`);
  process.exitCode = 12;
}

function readJson() {
  return JSON.parse(require("node:fs").readFileSync(0, "utf8"));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
