"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");

function createAjv() {
  return new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false
  });
}

function compileSchemaFile(schemaPath) {
  const resolved = path.resolve(schemaPath);
  const schema = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return {
    path: resolved,
    validate: createAjv().compile(schema)
  };
}

function validateWithCompiled(compiled, value) {
  if (!compiled) {
    return { valid: true, errors: [], schema: null };
  }

  const valid = compiled.validate(value);
  return {
    valid,
    errors: valid ? [] : formatAjvErrors(compiled.validate.errors || []),
    schema: compiled.path
  };
}

function formatAjvErrors(errors) {
  return errors.map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message}`;
  });
}

module.exports = {
  compileSchemaFile,
  createAjv,
  formatAjvErrors,
  validateWithCompiled
};
