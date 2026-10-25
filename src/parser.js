'use strict';

/**
 * Parser: recursive-descent parser producing an AST, plus a small
 * semantic analysis pass (unknown identifiers / functions, duplicates).
 *
 * Grammar (mini-C):
 *   program    : item*
 *   item       : funcDef | varDecl | returnStmt
 *   funcDef    : 'int' IDENT '(' [ 'int' IDENT (',' 'int' IDENT)* ] ')' '{' item* '}'
 *   varDecl    : 'int' IDENT ['=' expr] ';'
 *   returnStmt : 'return' expr? ';'
 *   expr       : additive
 *   additive   : multiplicative (('+' | '-') multiplicative)*
 *   multiplicative : unary (('*' | '/') unary)*
 *   unary      : '-' unary | primary
 *   primary    : NUMBER | IDENT ['(' [expr (',' expr)*] ')'] | '(' expr ')'
 *
 * Disambiguation: after `int IDENT` a '(' means a function definition,
 * otherwise it is a variable declaration.
 *
 * A program may also be a bare list of statements (the MVP test case);
 * wrapProgram() lifts those into a synthesized `main`.
 */

class ParseError extends Error {
  constructor(message, tok) {
    const at = tok ? ` at line ${tok.line}, col ${tok.col}` : '';
    super(`Parser error: ${message}${at}`);
    this.token = tok || null;
  }
}

class SemanticError extends Error {
  constructor(message) {
    super(`Semantic error: ${message}`);
  }
}

class Parser {
  constructor(tokens) {
    this.tok = tokens;
    this.i = 0;
  }

  peek(off = 0) {
    return this.tok[Math.min(this.i + off, this.tok.length - 1)];
  }

  next() {
    return this.tok[this.i++];
  }

  atEOF() {
    return this.peek().type === 'EOF';
  }

  isOp(v) {
    const t = this.peek();
    return t.type === 'OP' && t.value === v;
  }

  isKw(v) {
    const t = this.peek();
    return t.type === 'KEYWORD' && t.value === v;
  }

  describe() {
    const t = this.peek();
    return t.type === 'EOF' ? 'end of input' : `${t.type} '${t.value}'`;
  }

  eatOp(v) {
    if (this.isOp(v)) return this.next();
    throw new ParseError(`expected '${v}', got '${this.describe()}'`, this.peek());
  }

  eatOpIf(v) {
    if (this.isOp(v)) {
      this.next();
      return true;
    }
    return false;
  }

  eatKw(v) {
    if (this.isKw(v)) return this.next();
    throw new ParseError(`expected '${v}', got '${this.describe()}'`, this.peek());
  }

  parseProgram() {
    const body = [];
    while (!this.atEOF()) body.push(this.parseItem());
    return { type: 'Program', body };
  }

  parseItem() {
    if (this.isKw('int')) {
      // Lookahead: `int IDENT (` => function definition, else var declaration.
      const saved = this.i;
      this.next(); // 'int'
      const nameTok = this.next();
      if (nameTok.type !== 'IDENT') {
        throw new ParseError(`expected identifier after 'int', got '${this.describe()}'`, nameTok);
      }
      const isFuncDef = this.isOp('('); // check BEFORE rewinding
      this.i = saved;
      return isFuncDef ? this.parseFuncDef() : this.parseVarDecl();
    }
    if (this.isKw('return')) return this.parseReturn();
    throw new ParseError(`unexpected token '${this.describe()}'`, this.peek());
  }

  parseItemInFunc() {
    if (this.isKw('int')) return this.parseVarDecl();
    if (this.isKw('return')) return this.parseReturn();
    throw new ParseError(`unexpected token '${this.describe()}' in function body`, this.peek());
  }

  parseFuncDef() {
    this.eatKw('int');
    const nameTok = this.next();
    if (nameTok.type !== 'IDENT') {
      throw new ParseError(`expected function name, got '${this.describe()}'`, nameTok);
    }
    this.eatOp('(');
    const params = [];
    if (!this.isOp(')')) {
      do {
        this.eatKw('int');
        const p = this.next();
        if (p.type !== 'IDENT') {
          throw new ParseError(`expected parameter name, got '${this.describe()}'`, p);
        }
        params.push(p.value);
      } while (this.eatOpIf(','));
    }
    this.eatOp(')');
    this.eatOp('{');
    const body = [];
    while (!this.isOp('}')) {
      if (this.atEOF()) throw new ParseError(`unterminated function body of '${nameTok.value}'`);
      body.push(this.parseItemInFunc());
    }
    this.eatOp('}');
    return { type: 'FuncDef', name: nameTok.value, params, body, line: nameTok.line };
  }

  parseVarDecl() {
    this.eatKw('int');
    const nameTok = this.next();
    if (nameTok.type !== 'IDENT') {
      throw new ParseError(`expected variable name, got '${this.describe()}'`, nameTok);
    }
    let init = null;
    if (this.isOp('=')) {
      this.next();
      init = this.parseExpr();
    }
    this.eatOp(';');
    return { type: 'VarDecl', name: nameTok.value, init, line: nameTok.line };
  }

  parseReturn() {
    this.eatKw('return');
    let expr = null;
    if (!this.isOp(';')) expr = this.parseExpr();
    this.eatOp(';');
    return { type: 'Return', expr };
  }

  parseExpr() {
    return this.parseAdditive();
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  parseUnary() {
    if (this.isOp('-')) {
      this.next();
      return { type: 'UnaryOp', op: '-', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'NUMBER') {
      this.next();
      return { type: 'NumLit', value: t.value };
    }
    if (t.type === 'IDENT') {
      this.next();
      if (this.isOp('(')) {
        this.next();
        const args = [];
        if (!this.isOp(')')) {
          do {
            args.push(this.parseExpr());
          } while (this.eatOpIf(','));
        }
        this.eatOp(')');
        return { type: 'Call', callee: t.value, args, line: t.line };
      }
      return { type: 'Ident', name: t.value, line: t.line };
    }
    if (this.isOp('(')) {
      this.next();
      const e = this.parseExpr();
      this.eatOp(')');
      return e;
    }
    throw new ParseError(`expected expression, got '${this.describe()}'`, t);
  }
}

function parseProgram(tokens) {
  return new Parser(tokens).parseProgram();
}

/** Lift top-level statements (the bare test snippet) into a synthetic main. */
function wrapProgram(program) {
  const defs = program.body.filter((s) => s.type === 'FuncDef');
  const loose = program.body.filter((s) => s.type !== 'FuncDef');
  const hasMain = defs.some((f) => f.name === 'main');
  if (loose.length > 0 && hasMain) {
    throw new SemanticError(
      "top-level statements imply a synthesized 'main', but 'main' is already defined"
    );
  }
  const body = [...defs];
  if (loose.length > 0) {
    body.push({ type: 'FuncDef', name: 'main', params: [], body: loose, line: 1, synthetic: true });
  }
  return { type: 'Program', body };
}

/** Semantic analysis: function table, duplicate detection, name resolution. */
function analyzeProgram(program) {
  const funcs = new Map();
  for (const item of program.body) {
    if (item.type === 'FuncDef') {
      if (funcs.has(item.name)) throw new SemanticError(`duplicate definition of '${item.name}'`);
      funcs.set(item.name, item);
    }
  }
  if (!funcs.has('main')) throw new SemanticError("program has no 'main' function");
  for (const item of program.body) {
    if (item.type === 'FuncDef') analyzeFunc(item, funcs);
  }
  return { funcs };
}

function analyzeFunc(func, funcs) {
  const scope = new Map();
  const seen = new Set();
  for (const p of func.params) {
    if (seen.has(p)) throw new SemanticError(`duplicate parameter '${p}' in ${func.name}`);
    seen.add(p);
    scope.set(p, 'param');
  }
  for (const stmt of func.body) {
    if (stmt.type === 'VarDecl') {
      if (seen.has(stmt.name)) {
        throw new SemanticError(`duplicate declaration of '${stmt.name}' in ${func.name}`);
      }
      seen.add(stmt.name);
      scope.set(stmt.name, 'local');
      walkExpr(stmt.init, scope, funcs, func.name);
    } else if (stmt.type === 'Return') {
      walkExpr(stmt.expr, scope, funcs, func.name);
    }
  }
}

function walkExpr(e, scope, funcs, fname) {
  if (!e) return;
  switch (e.type) {
    case 'NumLit':
      return;
    case 'Ident':
      if (!scope.has(e.name)) {
        throw new SemanticError(`unknown identifier '${e.name}' in ${fname}`);
      }
      return;
    case 'UnaryOp':
      walkExpr(e.operand, scope, funcs, fname);
      return;
    case 'BinaryOp':
      walkExpr(e.left, scope, funcs, fname);
      walkExpr(e.right, scope, funcs, fname);
      return;
    case 'Call':
      if (!funcs.has(e.callee)) {
        throw new SemanticError(`unknown function '${e.callee}' in ${fname}`);
      }
      for (const a of e.args) walkExpr(a, scope, funcs, fname);
      return;
    default:
      throw new SemanticError(`unknown AST node '${e.type}'`);
  }
}

module.exports = {
  parseProgram,
  wrapProgram,
  analyzeProgram,
  ParseError,
  SemanticError,
};
