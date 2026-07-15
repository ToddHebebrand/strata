// Task 6 deliberately compiles the sealed bridge before Tasks 7/8 wire its
// provider/executor consumers into the kernel.
#![allow(dead_code)]

pub(crate) mod process;
pub(crate) mod protocol;
