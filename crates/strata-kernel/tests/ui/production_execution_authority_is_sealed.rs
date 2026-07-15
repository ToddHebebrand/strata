use strata_kernel::{
    BridgeRequest, BuildValidateCandidateRequest, CandidateBinding, CandidateEnvelope,
    CandidateExecutor, NodeSemanticProvider, PreparedCandidate, ValidationProfile,
};

struct ClientProvider;
struct ClientBuilder;

fn cannot_construct_candidate_envelope(delta: strata_kernel::GraphDelta) {
    let _ = strata_kernel::CandidateEnvelope {
        delta,
        candidate_digest: "client-minted".to_owned(),
    };
}

fn cannot_inject_execution_authority(
    kernel: &strata_kernel::Kernel,
    claim: &strata_kernel::ClaimHandle,
) {
    let provider = ClientProvider;
    let builder = ClientBuilder;
    let worker_path = "client-controlled-worker";
    let validation_profile = "client-controlled-profile";
    let _ = kernel.execute_claimed(
        claim,
        0,
        &provider,
        &builder,
        worker_path,
        validation_profile,
    );
}

fn main() {}
