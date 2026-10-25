    .file   "main.s"
    .section .text

    .globl  main
main:
    pushq   %rbp
    movq    %rsp, %rbp
    subq    $64, %rsp

    movl    $0, -8(%rbp)
    movl    $1, -16(%rbp)
.L0:
    movslq  -16(%rbp), %rax
    movq    %rax, -24(%rbp)
    movl    $10, %eax
    movq    %rax, %rbx
    movq    -24(%rbp), %rax
    cmpq    %rbx, %rax
    setle   %al
    movzbl  %al, %eax
    cmpl    $0, %eax
    je      .L1
    movslq  -8(%rbp), %rax
    movq    %rax, -32(%rbp)
    movslq  -16(%rbp), %rax
    movq    %rax, %rbx
    movq    -32(%rbp), %rax
    addq    %rbx, %rax
    movl    %eax, -8(%rbp)
    movslq  -16(%rbp), %rax
    movq    %rax, -40(%rbp)
    movl    $1, %eax
    movq    %rax, %rbx
    movq    -40(%rbp), %rax
    addq    %rbx, %rax
    movl    %eax, -16(%rbp)
    jmp     .L0
.L1:
    movslq  -8(%rbp), %rax
    movq    %rax, -48(%rbp)
    movl    $55, %eax
    movq    %rax, %rbx
    movq    -48(%rbp), %rax
    cmpq    %rbx, %rax
    setge   %al
    movzbl  %al, %eax
    cmpl    $0, %eax
    je      .L3
    movslq  -8(%rbp), %rax

    movq    %rbp, %rsp
    popq    %rbp
    ret
    jmp     .L2
.L3:
    movl    $0, %eax

    movq    %rbp, %rsp
    popq    %rbp
    ret
.L2:
    xorl    %eax, %eax

    movq    %rbp, %rsp
    popq    %rbp
    ret

