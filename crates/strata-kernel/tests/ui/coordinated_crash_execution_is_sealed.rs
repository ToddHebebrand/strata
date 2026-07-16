fn cannot_crash_production_execution(
    kernel: &strata_kernel::Kernel,
    claim: &strata_kernel::ClaimHandle,
) {
    let _ = kernel.execute_claimed_with_failpoint(claim, 0, ());
}

fn main() {}
