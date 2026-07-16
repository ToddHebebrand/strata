use strata_kernel::{
    DurableStore, FenceClaim, Publication, PublishFailpoint, PublishOutcome,
};

fn cannot_call_raw_methods(kernel: &strata_kernel::Kernel, publication: Publication) {
    let _ = kernel.issue_fence(&[]);
    let _ = kernel.publish(publication);
}

fn main() {}
