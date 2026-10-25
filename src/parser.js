'use strict';

/**
 * Parser: recursive-descent parser producing an AST, plus a small
 * semantic analysis pass (unknown identifiers / functions, duplicates).
 *
 * Grammar (mini-C):
 *   program    : item*
 *   item       : funcDef | statement
 *   funcDef    : 'int' IDENT '(' [ 'int' IDENT (',' 'int' IDENT)* ] ')' '{' statement* '}'
 *   statement  : varDecl | returnStmt | ifStmt | whileStmt | block | exprStmt
 *   varDecl    : 'int' IDENT ['=' expr] ';'
 *   returnStmt : 'return' expr? ';'
 *   ifStmt     : 'if' '(' expr ')' statement ['else' statement]
 *   whileStmt  : 'while' '(' expr ')' statement
 *   block      : '{' statement* '}'
 *   exprStmt   : expr ';'
 *   expr       : assignment
 *   assignment : IDENT '=' assignment
 *               | equality
 *   equality   : relational (('==' | '!=') relational)*
 *   relational : additive (('<' | '<=' | '>' | '>=') additive)*
 *   additive   : multiplicative (('+' | '-') multiplicative)*
 *   multiplicative : unary (('*' | '/') unary)*
 *   unary      : '-' unary | primary
 *   primary    : NUMBER | IDENT ['(' [expr (',' expr)*] ')'] | '(' expr ')'
 *
 * Disambiguation: after `int IDENT` a '(' means a function definition,
 * otherwise it is a variable declaration.
 *
 * Comparison operators bind looser than arithmetic, equality looser
 * than relational (same shape as C, left-associative).
 * Assignment is right-associative and syntax-restricted to a plain
 * identifier on the left (the only lvalue in this subset).
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
    return this.parseStatement();
  }

  /** Any statement: declarations, returns, control flow, blocks, expressions. */
  parseStatement() {
    if (this.isKw('int')) return this.parseVarDecl();
    if (this.isKw('return')) return this.parseReturn();
    if (this.isKw('if')) return this.parseIf();
    if (this.isKw('while')) return this.parseWhile();
    if (this.isOp('{')) return this.parseBlock();
    return this.parseExprStmt();
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
      body.push(this.parseStatement());
    }
    this.eatOp('}');
    return { type: 'FuncDef', name: nameTok.value, params, body, line: nameTok.line };
  }

  parseIf() {
    this.eatKw('if');
    this.eatOp('(');
    const cond = this.parseExpr();
    this.eatOp(')');
    const then = this.parseStatement();
    let el = null;
    if (this.isKw('else')) {
      this.next();
      el = this.parseStatement(); // dangling-else binds to the innermost if
    }
    return { type: 'If', cond, then, else: el };
  }

  parseWhile() {
    this.eatKw('while');
    this.eatOp('(');
    const cond = this.parseExpr();
    this.eatOp(')');
    const body = this.parseStatement();
    return { type: 'While', cond, body };
  }

  parseBlock() {
    this.eatOp('{');
    const body = [];
    while (!this.isOp('}')) {
      if (this.atEOF()) throw new ParseError('unterminated block');
      body.push(this.parseStatement());
    }
    this.eatOp('}');
    return { type: 'Block', body };
  }

  parseExprStmt() {
    const expr = this.parseExpr();
    this.eatOp(';');
    return { type: 'ExprStmt', expr };
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
    return this.parseAssignment();
  }

  /** assignment : IDENT '=' assignment | equality  (right-associative). */
  parseAssignment() {
    const t = this.peek();
    const t2 = this.peek(1);
    if (t.type === 'IDENT' && t2.type === 'OP' && t2.value === '=') {
      this.next(); // IDENT
      this.next(); // '='
      const value = this.parseAssignment();
      return { type: 'Assign', name: t.value, value, line: t.line };
    }
    return this.parseEquality();
  }

  parseEquality() {
    let left = this.parseRelational();
    while (this.isOp('==') || this.isOp('!=')) {
      const op = this.next().value;
      const right = this.parseRelational();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  parseRelational() {
    let left = this.parseAdditive();
    while (this.isOp('<') || this.isOp('<=') || this.isOp('>') || this.isOp('>=')) {
      const op = this.next().value;
      const right = this.parseAdditive();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
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
  for (const stmt of func.body) analyzeStmt(stmt, scope, seen, funcs, func.name);
}

/**
 * Statements nest (if/while bodies, blocks), so name resolution walks the
 * tree. Declarations stay function-scoped: a VarDecl anywhere in the body
 * extends the single flat scope, and shadowing between blocks is rejected
 * as a duplicate.
 */
function analyzeStmt(stmt, scope, seen, funcs, fname) {
  switch (stmt.type) {
    case 'VarDecl':
      if (seen.has(stmt.name)) {
        throw new SemanticError(`duplicate declaration of '${stmt.name}' in ${fname}`);
      }
      seen.add(stmt.name);
      scope.set(stmt.name, 'local');
      walkExpr(stmt.init, scope, funcs, fname);
      return;
    case 'Return':
      walkExpr(stmt.expr, scope, funcs, fname);
      return;
    case 'ExprStmt':
      walkExpr(stmt.expr, scope, funcs, fname);
      return;
    case 'If':
      walkExpr(stmt.cond, scope, funcs, fname);
      analyzeStmt(stmt.then, scope, seen, funcs, fname);
      if (stmt.else) analyzeStmt(stmt.else, scope, seen, funcs, fname);
      return;
    case 'While':
      walkExpr(stmt.cond, scope, funcs, fname);
      analyzeStmt(stmt.body, scope, seen, funcs, fname);
      return;
    case 'Block':
      for (const s of stmt.body) analyzeStmt(s, scope, seen, funcs, fname);
      return;
    default:
      throw new SemanticError(`unknown statement node '${stmt.type}' in ${fname}`);
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
    case 'Assign':
      if (!scope.has(e.name)) {
        throw new SemanticError(`assignment to unknown identifier '${e.name}' in ${fname}`);
      }
      walkExpr(e.value, scope, funcs, fname);
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
