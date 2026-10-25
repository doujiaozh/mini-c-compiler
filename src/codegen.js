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
 * Control flow (if / else / while) uses `.L<n>` labels from a single
 * program-wide counter, so labels never collide between functions.
 * Comparisons are setCC-style: `cmpq` sets the flags, `setCC %al` +
 * `movzbl` materialises a 0/1 int in eax, so a condition works both as a
 * jump test (`cmpl $0, %eax; je ...`) and as a plain expression value.
 *
 * Directives are kept minimal (.file / .section / .globl) so the same
 * file assembles on both PE-COFF (Windows/MinGW) and ELF (Linux) targets.
 */

const ARG_REGS = ['rcx', 'rdx', 'r8', 'r9'];

/** Relational/equality operators: emit cmpq + setCC and a 0/1 result. */
const COMPARISON_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

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
    case 'Assign':
      return countBinaryOps(node.value, acc);
    case 'Call': {
      let a = acc;
      for (const arg of node.args) a = countBinaryOps(arg, a);
      return a;
    }
    default:
      return acc;
  }
}

/** Statements nest (if/while/block bodies), so temp-slot counting recurses. */
function countStmtBinaryOps(stmt, acc) {
  switch (stmt.type) {
    case 'VarDecl':
      return countBinaryOps(stmt.init, acc);
    case 'Return':
      return countBinaryOps(stmt.expr, acc);
    case 'ExprStmt':
      return countBinaryOps(stmt.expr, acc);
    case 'If': {
      let a = countBinaryOps(stmt.cond, acc);
      a = countStmtBinaryOps(stmt.then, a);
      if (stmt.else) a = countStmtBinaryOps(stmt.else, a);
      return a;
    }
    case 'While':
      return countStmtBinaryOps(stmt.body, countBinaryOps(stmt.cond, acc));
    case 'Block':
      return stmt.body.reduce((a, s) => countStmtBinaryOps(s, a), acc);
    default:
      throw new CodegenError(`unsupported statement '${stmt.type}'`);
  }
}

function countFuncBinaryOps(func) {
  return func.body.reduce((a, s) => countStmtBinaryOps(s, a), 0);
}

function emitExpr(node, ctx) {
  const P = (s) => ctx.push(s);
  switch (node.type) {
    case 'NumLit':
      P(`    movl    $${node.value}, %eax`);
      break;

    case 'Ident': {
      const off = ctx.localOff(node.name);
      // Sign-extend the 32-bit slot to the full register: arithmetic and
      // cmpq below are 64-bit signed, and zero-extension would turn
      // negatives into huge unsigned values (and break `< 0` etc.).
      P(`    movslq  -${off}(%rbp), %rax`);
      break;
    }

    case 'UnaryOp':
      if (node.op !== '-') throw new CodegenError(`unsupported unary op '${node.op}'`);
      emitExpr(node.operand, ctx);
      // Full-register negate keeps the sign extension intact (negl would
      // zero the upper half and turn -3 into 4294967293 for cmpq/idivq).
      P(`    negq    %rax`);
      break;

    case 'Assign': {
      // Right side first; eax keeps the value, which is also the result of
      // the assignment expression.
      emitExpr(node.value, ctx);
      const off = ctx.localOff(node.name);
      P(`    movl    %eax, -${off}(%rbp)`);
      break;
    }

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
          // cqto sign-extends rax into rdx:rax, the 128-bit dividend
          // idivq expects. (cdq would leave garbage in rdx's upper half.)
          P(`    cqto`);
          P(`    idivq   %rbx`);
          break;
        // cmpq computes rax - rbx; setCC reads those flags (signed).
        case '==': P(`    cmpq    %rbx, %rax`); P(`    sete    %al`); break;
        case '!=': P(`    cmpq    %rbx, %rax`); P(`    setne   %al`); break;
        case '<': P(`    cmpq    %rbx, %rax`); P(`    setl    %al`); break;
        case '<=': P(`    cmpq    %rbx, %rax`); P(`    setle   %al`); break;
        case '>': P(`    cmpq    %rbx, %rax`); P(`    setg    %al`); break;
        case '>=': P(`    cmpq    %rbx, %rax`); P(`    setge   %al`); break;
        default:
          throw new CodegenError(`unsupported binary op '${node.op}'`);
      }
      if (COMPARISON_OPS.has(node.op)) P(`    movzbl  %al, %eax`); // 0/1, zeroes upper bits
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

/** Collect declared names from every (possibly nested) block into one
 *  function-level frame. Same flat lifetime as the semantic scope. */
function collectLocals(stmt, locals) {
  switch (stmt.type) {
    case 'VarDecl':
      locals.push(stmt.name);
      return;
    case 'If':
      collectLocals(stmt.then, locals);
      if (stmt.else) collectLocals(stmt.else, locals);
      return;
    case 'While':
      collectLocals(stmt.body, locals);
      return;
    case 'Block':
      for (const s of stmt.body) collectLocals(s, locals);
      return;
    default:
      return;
  }
}

function emitStmt(stmt, ctx, epilogue) {
  const P = (s) => ctx.push(s);
  switch (stmt.type) {
    case 'VarDecl':
      if (stmt.init === null) return;
      {
        const off = ctx.localOff(stmt.name);
        if (stmt.init.type === 'NumLit') {
          P(`    movl    $${stmt.init.value}, -${off}(%rbp)`);
        } else {
          emitExpr(stmt.init, ctx);
          P(`    movl    %eax, -${off}(%rbp)`);
        }
      }
      return;

    case 'Return':
      if (stmt.expr) emitExpr(stmt.expr, ctx);
      else P(`    xorl    %eax, %eax`);
      P('');
      epilogue();
      return;

    case 'ExprStmt':
      emitExpr(stmt.expr, ctx);
      return;

    case 'If': {
      const end = ctx.nextLabel();
      const elseL = stmt.else ? ctx.nextLabel() : end;
      emitExpr(stmt.cond, ctx);
      P(`    cmpl    $0, %eax`); // false => jump
      P(`    je      ${elseL}`);
      emitStmt(stmt.then, ctx, epilogue);
      if (stmt.else) {
        P(`    jmp     ${end}`);
        P(`${elseL}:`);
        emitStmt(stmt.else, ctx, epilogue);
      }
      P(`${end}:`);
      return;
    }

    case 'While': {
      const cond = ctx.nextLabel();
      const end = ctx.nextLabel();
      P(`${cond}:`);
      emitExpr(stmt.cond, ctx);
      P(`    cmpl    $0, %eax`);
      P(`    je      ${end}`);
      emitStmt(stmt.body, ctx, epilogue);
      P(`    jmp     ${cond}`);
      P(`${end}:`);
      return;
    }

    case 'Block':
      for (const s of stmt.body) emitStmt(s, ctx, epilogue);
      return;

    default:
      throw new CodegenError(`unsupported statement '${stmt.type}'`);
  }
}

function emitFunction(func, push, nextLabel) {
  // Parameters are the first "locals": the prologue spills them from the
  // argument registers into frame slots, after which codegen is uniform.
  const locals = [];
  for (const p of func.params) locals.push(p);
  for (const s of func.body) collectLocals(s, locals);
  const nslots = locals.length;
  const ntemps = countFuncBinaryOps(func);
  const frame = Math.ceil((8 * (nslots + ntemps) + 8) / 16) * 16;

  const ctx = {
    push,
    localOff: (name) => 8 * (locals.indexOf(name) + 1),
    tempOff: (t) => 8 * (nslots + t + 1),
    tempIdx: 0,
    nextTemp: () => ctx.tempIdx++,
    nextLabel,
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

  for (const stmt of func.body) emitStmt(stmt, ctx, epilogue);

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
  // One label sequence for the whole translation unit: `.L` labels are
  // file-scoped in GNU as, so sharing the counter prevents collisions
  // between functions.
  let labelSeq = 0;
  const nextLabel = () => `.L${labelSeq++}`;

  push('    .file   "main.s"');
  push('    .section .text');
  push('');
  for (const func of program.body) {
    emitFunction(func, push, nextLabel);
    push('');
  }

  return lines.join('\n') + '\n';
}

module.exports = { generateAssembly, CodegenError };
