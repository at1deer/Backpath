#!/usr/bin/env node
"use strict";

const input = readJson();
const output = { name: input.name };
if (input.role !== null) {
  output.role = input.role;
}
writeJson(output);

function readJson() {
  return JSON.parse(require("node:fs").readFileSync(0, "utf8"));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
