# mini-c-compiler

一个手搓的微型 C 语言编译器（MVP），纯 Node.js 实现，无第三方依赖：
**词法分析 → 语法分析（AST）→ 代码生成（x86_64 汇编）**。

输入：

```c
int a = 10;
int b = 20;
return a + b;
```

输出（节选，AT&T 语法 / GNU as）：

```asm
main:
    pushq   %rbp
    movq    %rsp, %rbp
    subq    $32, %rsp
    movl    $10, -8(%rbp)
    movl    $20, -16(%rbp)
    ...
    addq    %rbx, %rax
    movq    %rbp, %rsp
    popq    %rbp
    ret
```

链接执行后进程退出码为 `30`。

## 语言子集

- 关键字：`int`、`return`
- 标识符、十进制整数字面量
- 运算符：`+ - * /`（含一元负号 ` -`）、赋值 `=`；分隔符 `( ) { } ; ,`
- 变量声明（`int a = 10;`）、函数定义（`int add(int x, int y) { ... }`）、函数调用
- 顶层语句自动包装进合成 `main`（已有显式 `main` 则直接使用）
- `//` 与 `/* */` 注释

## 项目结构

```
mini-c-compiler/
├── src/
│   ├── lexer.js     # tokenize(): 关键字/标识符/数字/运算符 -> token 流
│   ├── parser.js    # 递归下降 -> AST（Program/FuncDef/VarDecl/Return/BinaryOp/...）
│   ├── codegen.js   # 树遍历 AST -> x86_64 汇编（AT&T 语法，GNU as 兼容）
│   └── index.js     # CLI 入口 + compileSource() 流水线
├── test/
│   └── run_tests.js # 自动化测试：compile -> as -> gcc -> 执行，校验退出码
├── examples/        # 示例输入与编译产物（.c / .s）
├── build/           # 测试中间产物（.s/.o/.exe，已 gitignore）
├── package.json
└── README.md
```

## 用法

```bash
# 编译文件
node src/index.js examples/basic.c --asm examples/basic.s

# 无参数时编译内置示例（int a=10; int b=20; return a+b;）
node src/index.js

# 自动化测试
npm test
```

## 目标平台与 ABI

代码生成针对 **x86_64 + Microsoft x64 ABI**（整数参数 `rcx/rdx/r8/r9`，
第 5 个参数起走栈，32 字节 shadow space，`call` 时 `rsp` 16 字节对齐，
返回值在 `eax`），因为本机工具链是 Windows 上的 MinGW-W64 gcc。
指令只使用 `.file/.section/.globl` 三种指令，不依赖 PE 专有段指令，
因此同一份 `.s` 在 ELF 目标上也能汇编通过（ABI 不同的只是调用约定）。

## 测试

### 本机验证结果（Windows）

已在 **Windows + MinGW-W64 gcc 8.1.0 / GNU as (binutils) 2.30** 上实测通过：

```
$ npm test
=== case: basic (expect exit 30) ===        PASS
=== case: funcs (expect exit 15) ===        PASS
=== case: precedence (expect exit 14) ===   PASS
=== case: div_neg (expect exit -7) ===      PASS
=== case: stack_args (expect exit 15) ===   PASS
ALL TESTS PASSED (5/5)
```

`npm test` 的流程：`compileSource()` 生成 `build/<case>.s` → `as` 汇编为
`.o` → `gcc` 链接为 `.exe` → 执行并校验退出码（exit code 按 int32 归一化）。
若本机没有 `as`/`gcc`，测试脚本会退出并提示去 Linux 环境运行。

### 请在 Linux 环境下用 gcc 测试

仓库中已保存编译产物 `examples/basic.s`、`examples/funcs.s`
（可用 `node src/index.js examples/basic.c --asm examples/basic.s` 重新生成）。
在 Linux 上可直接复现：

```bash
gcc examples/basic.s -o basic && ./basic; echo $?   # 期望 30
gcc examples/funcs.s -o funcs && ./funcs; echo $?   # 期望 15
```

> **注意（重要）**：生成的汇编遵循 **Microsoft x64 ABI**（参数走
> `rcx/rdx/r8/r9`）。Linux 原生 gcc 遵循 System V AMD64 ABI（参数走
> `rdi/rsi/rdx/rcx/r8/r9`），所以含函数调用的用例（`funcs`、`stack_args`）
> 在 Linux 原生 gcc 上链接执行**得不到正确结果**——这是调用约定差异，不是
> 编译器 bug。若要在 Linux 上完整验证，请使用 MinGW 交叉工具链：
>
> ```bash
> x86_64-w64-mingw32-gcc examples/funcs.s -o funcs && wine ./funcs; echo $?
> ```
>
> 不涉及函数调用的 `basic`、`precedence`、`div_neg` 用例在 Linux 原生 gcc 下
> 即可正常工作（入口帧布局只依赖通用的 `rbp` 约定）。

## 实现要点

- **词法**：单遍扫描，token 带 `line/col`，错误信息含源码位置。
- **语法**：递归下降 + 一级 lookahead 回溯区分「函数定义 vs 变量声明」
  （`int IDENT (` 为函数，否则为声明）。
- **语义**：重复定义检查、未定义标识符检查、`main` 冲突检查。
- **代码生成**：每个函数一个栈帧；参数与局部变量统一放 `[rbp-8k]` 槽位
  （入口处从寄存器溢出）；每个二元运算节点独占一个 temp 槽（表达式求值
  结果全程在寄存器，不做表达式压栈，栈对齐始终干净）。
