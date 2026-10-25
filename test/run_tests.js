#!/usr/bin/env node
'use strict';

/**
 * Automated test harness:
 *   mini-C source -> compileSource() -> .s  ->  as  ->  .o  ->  gcc  ->  .exe
 *   run the binary, compare its process exit code (as a 32-bit int)
 *   against the expected value.
 *
 * Requires: gcc + as on PATH (Linux: any GNU toolchain;
 * Windows: MinGW-W64, verified with gcc 8.1 / binutils 2.30).
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { compileSource } = require('../src/index');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const EXE_EXT = process.platform === 'win32' ? '.exe' : '';

const CASES = [
  {
    // The MVP requirement: 10 + 20 must come back as the exit code.
    name: 'basic',
    source: `int a = 10;
int b = 20;
return a + b;
`,
    expect: 30,
  },
  {
    // Function definitions + calls (args through rcx/rdx, shadow space).
    name: 'funcs',
    source: `int add(int x, int y) {
  return x + y;
}

int mul(int x, int y) {
  return x * y;
}

int main() {
  int r = add(1, 2);
  return add(r, mul(3, 4));
}
`,
    expect: 15, // add(3, 12)
  },
  {
    // Operator precedence: x = 2 + 3*4 = 14.
    name: 'precedence',
    source: `int x = 2 + 3 * 4;
return x;
`,
    expect: 14,
  },
  {
    // Division + unary minus: 10/3 + (-10) = 3 - 10 = -7 (two's complement).
    name: 'div_neg',
    source: `int a = 10;
int b = 3;
return a / b + (-a);
`,
    expect: -7,
  },
  {
    // Fifth argument goes through the stack (Microsoft x64: [rbp+40]).
    name: 'stack_args',
    source: `int sum5(int a, int b, int c, int d, int e) {
  return a + b + c + d + e;
}

int main() {
  return sum5(1, 2, 3, 4, 5);
}
`,
    expect: 15,
  },
  {
    // if with a true condition: control flow + `>` comparison, exit 42.
    name: 'if_true',
    source: `int a = 10;
if (a > 5) return 42;
return 0;
`,
    expect: 42,
  },
  {
    // if/else, condition false via `!=`: jumps past the `jmp end`.
    name: 'if_else_false',
    source: `int x = 0;
if (x != 0) return 1; else return 2;
return 99;
`,
    expect: 2,
  },
  {
    // while loop with an assignments-in-block body: 1+2+...+10.
    name: 'while_sum',
    source: `int sum = 0;
int i = 1;
while (i <= 10) {
  sum = sum + i;
  i = i + 1;
}
return sum;
`,
    expect: 55,
  },
  {
    // Comparisons are expressions yielding 0/1: 1 + 1 - 0 = 2.
    name: 'comparison_values',
    source: `int a = 5;
int b = 3;
int c = (a > b) + (a == 5) - (a != a);
return c;
`,
    expect: 2,
  },
];

/** Normalize a process exit code to a signed 32-bit int. */
function toInt32(code) {
  if (code === null || code === undefined) return null;
  code = code >>> 0;
  return code >= 0x80000000 ? code - 0x100000000 : code;
}

function toolAvailable(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!toolAvailable('gcc') || !toolAvailable('as')) {
    console.error(
      'No usable gcc/as toolchain on this machine.\n' +
        'Skipped execution; the generated .s files are kept in build/.\n' +
        'Please run this suite on a Linux box with gcc: `npm test`.'
    );
    process.exit(2);
  }

  fs.mkdirSync(BUILD, { recursive: true });
  let failed = 0;

  for (const c of CASES) {
    process.stdout.write(`\n=== case: ${c.name} (expect exit ${c.expect}) ===\n`);
    let asm = null;
    try {
      asm = compileSource(c.source);
      const sPath = path.join(BUILD, c.name + '.s');
      const oPath = path.join(BUILD, c.name + '.o');
      const ePath = path.join(BUILD, c.name + EXE_EXT);
      fs.writeFileSync(sPath, asm);
      if (c.name === 'basic') process.stdout.write(asm); // show the MVP artifact

      const asRes = execFileSync('as', [sPath, '-o', oPath], { stdio: 'pipe' });
      const ccRes = execFileSync('gcc', [oPath, '-o', ePath], { stdio: 'pipe' });

      const r = spawnSync(ePath, [], { stdio: 'pipe' });
      if (r.error) throw new Error(`failed to run ${ePath}: ${r.error.message}`);
      const exit = toInt32(r.status);
      if (exit !== c.expect) {
        throw new Error(`wrong exit code: expected ${c.expect}, got ${exit}`);
      }
      process.stdout.write(`PASS: ${ePath} exited with ${exit}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAIL: ${err.message}\n`);
      if (asm) process.stdout.write(`--- generated assembly ---\n${asm}\n`);
    }
  }

  process.stdout.write(
    `\n${failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED'} ` +
      `(${CASES.length - failed}/${CASES.length})\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
