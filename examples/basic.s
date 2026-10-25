    .file   "main.s"
    .section .text

    .globl  main
main:
    pushq   %rbp
    movq    %rsp, %rbp
    subq    $32, %rsp

    movl    $10, -8(%rbp)
    movl    $20, -16(%rbp)
    movl    -8(%rbp), %eax
    movq    %rax, -24(%rbp)
    movl    -16(%rbp), %eax
    movq    %rax, %rbx
    movq    -24(%rbp), %rax
    addq    %rbx, %rax

    movq    %rbp, %rsp
    popq    %rbp
    ret

