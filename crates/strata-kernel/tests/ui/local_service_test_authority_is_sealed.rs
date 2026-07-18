use std::path::PathBuf;
use std::time::Duration;

use strata_kernel::NodeBridgeConfig;

fn main() {
    let config = NodeBridgeConfig::tsc_only(
        "node",
        vec![],
        Duration::from_secs(1),
        PathBuf::from("src"),
        PathBuf::from("."),
        true,
    )
    .test_with_executable("fixture-worker");
    let _ = config;
}
