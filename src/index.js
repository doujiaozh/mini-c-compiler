#!/usr/bin/env node
'use strict';

/**
 * minic - a tiny C compiler front end + x86_64 back end.
 *
 * Usage:
 *   node src/index.js [input.c] [--asm out.s]
 *
 * With no input file, compiles the built-in demo (10 + 20).
 */

const fs = require('fs');
const path = require('path');

const { tokenize } = require('./lexer');
const { parseProgram, wrapProgram, analyzeProgram } = require('./parser');
const { generateAssembly } = require('./codegen');

const DEFAULT_SOURCE = `int a = 10;
int b = 20;
return a + b;
`;

/**
 * Full pipeline: source text -> tokens -> AST -> semantic checks -> assembly.
 * @returns {string} x86_64 assembly text (GNU as / AT&T syntax)
 */
function compileSource(src) {
  const tokens = tokenize(src);
  const ast = parseProgram(tokens);
  const wrapped = wrapProgram(ast);
  analyzeProgram(wrapped);
  return generateAssembly(wrapped);
}

function main(argv) {
  const args = argv.slice(2);
  let inputFile = null;
  let outFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asm' || args[i] === '-o') {
      if (i + 1 >= args.length) {
        console.error('[minic] missing file after ' + args[i]);
        process.exit(2);
      }
      outFile = args[++i];
    } else {
      inputFile = args[i];
    }
  }

  const src = inputFile
    ? fs.readFileSync(path.resolve(inputFile), 'utf8')
    : DEFAULT_SOURCE;

  let asm;
  try {
    asm = compileSource(src);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (outFile) {
    fs.writeFileSync(outFile, asm);
    console.error(`[minic] wrote ${asm.length} bytes of assembly to ${outFile}`);
  } else {
    process.stdout.write(asm);
  }
}

if (require.main === module) main(process.argv);

module.exports = { compileSource, DEFAULT_SOURCE };
