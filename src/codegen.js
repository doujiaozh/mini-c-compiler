'use strict';

/**
 * Codegen: tree-walking AST -> x86_64 assembly (GNU as, AT&T syntax).
 *
 * Target ABI: Microsoft x64 (MinGW-W64 on Windows), the ABI of the
 * system gcc used to assemble and link the output:
 *   - integer args: rcx, rdx, r8, r9, then stack (32-byte shadow space)
 *   - return value in eax
 *   - rbx/rbp are callee-saved; rsp is 16-byte aligned at every `call`
 *
 * Frame layout (all slots 8 bytes, ints live in the low 32 bits):
 *   [rbp-8]                 local 0
 *   [rbp-16]                local 1
 *   ...
 *   [rbp-8*(n+1)]           temp 0 (one slot per binary-op node)
 *   ...
 * Expressions evaluate to eax. A binary op stores its LHS in a temp slot
 * while evaluating the RHS (no stack pushes for expression state, so stack
 * alignment stays 16-byte clean even with nested calls).
 *
 * Directives are kept minimal (.file / .section / .globl) so the same
 * file assembles on both PE-COFF (Windows/MinGW) and ELF (Linux) targets.
 */

const ARG_REGS = ['rcx', 'rdx', 'r8', 'r9'];

class CodegenError extends Error {
  constructor(message) {
    super(`Codegen error: ${message}`);
  }
}

/** Count binary-op nodes in an expression tree (one temp slot each). */
function countBinaryOps(node, acc) {
  if (!node) return acc;
  switch (node.type) {
    case 'BinaryOp':
      return countBinaryOps(node.right, countBinaryOps(node.left, acc + 1));
    case 'UnaryOp':
      return countBinaryOps(node.operand, acc);
    case 'Call': {
      let a = acc;
      for (const arg of node.args) a = countBinaryOps(arg, a);
      return a;
    }
    default:
      return acc;
  }
}

function countFuncBinaryOps(func) {
  let n = 0;
  for (const stmt of func.body) {
    if (stmt.type === 'VarDecl') n = countBinaryOps(stmt.init, n);
    else if (stmt.type === 'Return') n = countBinaryOps(stmt.expr, n);
  }
  return n;
}

function emitExpr(node, ctx) {
  const P = (s) => ctx.push(s);
  switch (node.type) {
    case 'NumLit':
      P(`    movl    $${node.value}, %eax`);
      break;

    case 'Ident': {
      const off = ctx.localOff(node.name);
      P(`    movl    -${off}(%rbp), %eax`);
      break;
    }

    case 'UnaryOp':
      if (node.op !== '-') throw new CodegenError(`unsupported unary op '${node.op}'`);
      emitExpr(node.operand, ctx);
      P(`    negl    %eax`);
      break;

    case 'BinaryOp': {
      const toff = ctx.tempOff(ctx.nextTemp());
      emitExpr(node.left, ctx);
      P(`    movq    %rax, -${toff}(%rbp)`);
      emitExpr(node.right, ctx);
      P(`    movq    %rax, %rbx`); // rbx = right
      P(`    movq    -${toff}(%rbp), %rax`); // rax = left
      switch (node.op) {
        case '+': P(`    addq    %rbx, %rax`); break;
        case '-': P(`    subq    %rbx, %rax`); break;
        case '*': P(`    imulq   %rbx, %rax`); break;
        case '/':
          P(`    cdq`);
          P(`    idivq   %rbx`);
          break;
        default:
          throw new CodegenError(`unsupported binary op '${node.op}'`);
      }
      break;
    }

    case 'Call':
      emitCall(node, ctx);
      break;

    default:
      throw new CodegenError(`unsupported expression node '${node.type}'`);
  }
}

function emitCall(node, ctx) {
  const P = (s) => ctx.push(s);
  const args = node.args;
  const k = args.length;
  const nreg = Math.min(k, ARG_REGS.length);
  const extra = k - nreg; // args spilled past the register arguments
  // Microsoft x64: one 32-byte shadow space, stack args at [rsp+32+8j].
  // Padded so rsp is 16-byte aligned at the `call` (frame is 16-aligned
  // when we get here, so total must be a multiple of 16).
  const total = 32 + 8 * extra + (extra % 2) * 8;

  P(`    subq    $${total}, %rsp`);
  for (let i = k - 1; i >= nreg; i--) {
    emitExpr(args[i], ctx);
    P(`    movq    %rax, ${32 + 8 * (i - nreg)}(%rsp)`);
  }
  for (let i = nreg - 1; i >= 0; i--) {
    emitExpr(args[i], ctx);
    P(`    movq    %rax, %${ARG_REGS[i]}`);
  }
  P(`    call    ${node.callee}`);
  P(`    addq    $${total}, %rsp`);
}

function emitFunction(func, push) {
  // Parameters are the first "locals": the prologue spills them from the
  // argument registers into frame slots, after which codegen is uniform.
  const locals = [];
  for (const p of func.params) locals.push(p);
  for (const s of func.body) if (s.type === 'VarDecl') locals.push(s.name);
  const nslots = locals.length;
  const ntemps = countFuncBinaryOps(func);
  const frame = Math.ceil((8 * (nslots + ntemps) + 8) / 16) * 16;

  const ctx = {
    push,
    localOff: (name) => 8 * (locals.indexOf(name) + 1),
    tempOff: (t) => 8 * (nslots + t + 1),
    tempIdx: 0,
    nextTemp: () => ctx.tempIdx++,
  };

  push(`    .globl  ${func.name}`);
  push(`${func.name}:`);
  push(`    pushq   %rbp`);
  push(`    movq    %rsp, %rbp`);
  push(`    subq    $${frame}, %rsp`);
  // Microsoft x64: args 0-3 in rcx/rdx/r8/r9; arg 5+ is on the caller's
  // stack at [rbp + 8*(i+2)] (32-byte shadow + return addr accounting).
  // Both loads/stores must not be memory-to-memory, so route through %rax.
  for (let i = 0; i < func.params.length; i++) {
    const dst = 8 * (i + 1);
    if (i < ARG_REGS.length) {
      push(`    movq    %${ARG_REGS[i]}, -${dst}(%rbp)`);
    } else {
      const src = 8 * (i + 2);
      push(`    movq    ${src}(%rbp), %rax`);
      push(`    movq    %rax, -${dst}(%rbp)`);
    }
  }
  push('');

  const epilogue = () => {
    push(`    movq    %rbp, %rsp`);
    push(`    popq    %rbp`);
    push(`    ret`);
  };

  for (const stmt of func.body) {
    if (stmt.type === 'VarDecl') {
      if (stmt.init === null) continue;
      const off = ctx.localOff(stmt.name);
      if (stmt.init.type === 'NumLit') {
        push(`    movl    $${stmt.init.value}, -${off}(%rbp)`);
      } else {
        emitExpr(stmt.init, ctx);
        push(`    movl    %eax, -${off}(%rbp)`);
      }
    } else if (stmt.type === 'Return') {
      if (stmt.expr) emitExpr(stmt.expr, ctx);
      else push(`    xorl    %eax, %eax`);
      push('');
      epilogue();
    }
  }

  // Fall through: implicit return 0 (only if the body does not end in `return`).
  const last = func.body[func.body.length - 1];
  if (!last || last.type !== 'Return') {
    push(`    xorl    %eax, %eax`);
    push('');
    epilogue();
  }
}

function generateAssembly(program) {
  const lines = [];
  const push = (s) => lines.push(s);

  push('    .file   "main.s"');
  push('    .section .text');
  push('');
  for (const func of program.body) {
    emitFunction(func, push);
    push('');
  }

  return lines.join('\n') + '\n';
}

module.exports = { generateAssembly, CodegenError };
