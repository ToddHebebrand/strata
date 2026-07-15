// Task 6 deliberately compiles the sealed bridge before Tasks 7/8 wire its
// provider/executor consumers into the kernel.
#![allow(dead_code)]

pub(crate) mod process;
pub(crate) mod protocol;
pub(crate) mod provider;

pub(crate) use process::NodeBridgeClient;
pub use process::NodeBridgeConfig;
pub(crate) use provider::NodeSemanticProvider;
