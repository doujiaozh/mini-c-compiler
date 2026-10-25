    .file   "main.s"
    .section .text

    .globl  add
add:
    pushq   %rbp
    movq    %rsp, %rbp
    subq    $32, %rsp
    movq    %rcx, -8(%rbp)
    movq    %rdx, -16(%rbp)

    movl    -8(%rbp), %eax
    movq    %rax, -24(%rbp)
    movl    -16(%rbp), %eax
    movq    %rax, %rbx
    movq    -24(%rbp), %rax
    addq    %rbx, %rax

    movq    %rbp, %rsp
    popq    %rbp
    ret

    .globl  mul
mul:
    pushq   %rbp
    movq    %rsp, %rbp
    subq    $32, %rsp
    movq    %rcx, -8(%rbp)
    movq    %rdx, -16(%rbp)

    movl    -8(%rbp), %eax
    movq    %rax, -24(%rbp)
    movl    -16(%rbp), %eax
    movq    %rax, %rbx
    movq    -24(%rbp), %rax
    imulq   %rbx, %rax

    movq    %rbp, %rsp
    popq    %rbp
    ret

    .globl  main
main:
    pushq   %rbp
    movq    %rsp, %rbp
    subq    $16, %rsp

    subq    $32, %rsp
    movl    $2, %eax
    movq    %rax, %rdx
    movl    $1, %eax
    movq    %rax, %rcx
    call    add
    addq    $32, %rsp
    movl    %eax, -8(%rbp)
    subq    $32, %rsp
    subq    $32, %rsp
    movl    $4, %eax
    movq    %rax, %rdx
    movl    $3, %eax
    movq    %rax, %rcx
    call    mul
    addq    $32, %rsp
    movq    %rax, %rdx
    movl    -8(%rbp), %eax
    movq    %rax, %rcx
    call    add
    addq    $32, %rsp

    movq    %rbp, %rsp
    popq    %rbp
    ret

