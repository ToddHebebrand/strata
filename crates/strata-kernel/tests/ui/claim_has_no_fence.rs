use strata_kernel::ClaimHandle;

fn cannot_publish_or_extract_authority(claim: ClaimHandle) {
    let _tokens = claim.resource_tokens;
    let _delta = claim.delta;
    claim.publish();
}

fn main() {}
