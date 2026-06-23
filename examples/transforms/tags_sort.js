#!/usr/bin/env node
"use strict";

const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write(`${JSON.stringify({ tags: input.tags.slice().sort() })}\n`);
