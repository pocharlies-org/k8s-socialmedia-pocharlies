import assert from "node:assert/strict";
import { createRequire } from "node:module";

const rootRequire = createRequire(import.meta.url);

const eslintPackage = rootRequire.resolve("eslint/package.json");
const eslintRequire = createRequire(eslintPackage);
const minimatch3Package = eslintRequire.resolve("minimatch/package.json");
const minimatch3Require = createRequire(minimatch3Package);
const minimatch3 = minimatch3Require("minimatch");
const brace3 = minimatch3Require("brace-expansion/package.json");

const parserPackage = rootRequire.resolve("@typescript-eslint/parser/package.json");
const parserRequire = createRequire(parserPackage);
const estreePackage = parserRequire.resolve(
  "@typescript-eslint/typescript-estree/package.json",
);
const estreeRequire = createRequire(estreePackage);
const minimatch9Package = estreeRequire.resolve("minimatch/package.json");
const minimatch9Require = createRequire(minimatch9Package);
const minimatch9 = minimatch9Require("minimatch");
const brace9 = minimatch9Require("brace-expansion/package.json");

assert.equal(brace3.version, "1.1.18", "minimatch 3 must use patched brace-expansion 1.x");
assert.equal(brace9.version, "2.1.4", "minimatch 9 must use patched brace-expansion 2.x");
assert.equal(minimatch3("foo.js", "{foo,bar}.js"), true);
assert.equal(minimatch3("baz.js", "{foo,bar}.js"), false);
assert.equal(minimatch9.minimatch("bar.js", "{foo,bar}.js"), true);
assert.equal(minimatch9.minimatch("baz.js", "{foo,bar}.js"), false);

console.log(
  `PASS dependency compatibility minimatch3/brace-${brace3.version} minimatch9/brace-${brace9.version}`,
);
