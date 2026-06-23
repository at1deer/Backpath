#!/usr/bin/env node
"use strict";

readJson();
writeJson([
  { status: "active" },
  { status: "pending_review" }
]);

function readJson() {
  return JSON.parse(require("node:fs").readFileSync(0, "utf8"));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
