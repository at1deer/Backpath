#!/usr/bin/env node
"use strict";

const input = readJson();

if (input.accountType === "minor" || input.accountType === "dependent") {
  writeJson({ restricted: true });
} else {
  process.stderr.write(`unsupported accountType: ${input.accountType}\n`);
  process.exitCode = 12;
}

function readJson() {
  return JSON.parse(require("node:fs").readFileSync(0, "utf8"));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
