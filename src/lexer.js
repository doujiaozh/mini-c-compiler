'use strict';

/**
 * Lexer: turns mini-C source text into a flat token stream.
 *
 * Supported:
 *   - keywords: int, return
 *   - identifiers: [A-Za-z_][A-Za-z0-9_]*
 *   - decimal integer literals
 *   - operators / punctuation: + - * / ( ) , = ; { }
 *   - whitespace, // line comments, /* ... *\/ block comments
 */

const KEYWORDS = new Set(['int', 'return']);
const OPS = new Set(['+', '-', '*', '/', '(', ')', ',', '=', ';', '{', '}']);

class LexError extends Error {
  constructor(message, line, col) {
    super(`Lexer error: ${message} at line ${line}, col ${col}`);
    this.line = line;
    this.col = col;
  }
}

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);

/**
 * @param {string} src source text
 * @returns {Array<{type:string, value:(string|number|null), line:number, col:number}>}
 */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // --- whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      if (c === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
      continue;
    }

    // --- line comment
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // --- block comment
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      i += 2;
      col += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++;
          col = 1;
        } else {
          col++;
        }
        i++;
      }
      if (i >= n) throw new LexError('unterminated block comment', startLine, startCol);
      i += 2;
      col += 2;
      continue;
    }

    const startLine = line;
    const startCol = col;

    // --- number
    if (isDigit(c)) {
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      const value = parseInt(src.slice(i, j), 10);
      tokens.push({ type: 'NUMBER', value, line: startLine, col: startCol });
      col += j - i;
      i = j;
      continue;
    }

    // --- identifier / keyword
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j])) j++;
      const value = src.slice(i, j);
      const type = KEYWORDS.has(value) ? 'KEYWORD' : 'IDENT';
      tokens.push({ type, value, line: startLine, col: startCol });
      col += j - i;
      i = j;
      continue;
    }

    // --- operator / punctuation
    if (OPS.has(c)) {
      tokens.push({ type: 'OP', value: c, line: startLine, col: startCol });
      i++;
      col++;
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(c)}`, startLine, startCol);
  }

  tokens.push({ type: 'EOF', value: null, line, col });
  return tokens;
}

module.exports = { tokenize, LexError, KEYWORDS };
