use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use strata_kernel::{
    BeginChangeSet, ChangeSetState as KernelChangeSetState, ClaimOutcome, CoordinationEventKind,
    GraphSnapshot, IntentParameters, Kernel, NodeBridgeConfig, PublishClaimOutcome,
    TicketState as KernelTicketState,
};

use super::audit::{
    AuditEvent, PendingRequest, RequestJournal, RequestLedgerEntry, ServiceAudit, action_body_hash,
    client_hash, request_identity,
};
use super::protocol::{
    CancelledState, ChangeSetState, Diagnostic, InspectedNode, Intent, LocalServiceRequest,
    LocalServiceResponse, NodeRelationship, RequestAction, ResponseResult, ServiceEvent,
    TicketState, WireU64, parse_request_frame,
};

const MAX_INTENTS: usize = 256;
const MAX_RELATIONSHIPS: usize = 256;

pub(super) struct ServiceConfig {
    pub db_path: PathBuf,
    pub snapshot_path: PathBuf,
    pub bridge_config: NodeBridgeConfig,
    pub audit_path: PathBuf,
}

pub(super) struct ServiceSession {
    kernel: Arc<Kernel>,
    journal: Mutex<RequestJournal>,
    audit: Mutex<ServiceAudit>,
    next_tick: AtomicU64,
    change_set_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    delivered_events: Mutex<BTreeMap<String, u64>>,
    recovered: bool,
}

impl ServiceSession {
    pub fn open(config: ServiceConfig) -> Result<(Arc<Self>, u64)> {
        let existed = config.db_path.exists();
        let (kernel, recovery) = if existed {
            Kernel::open_with_node_bridge(&config.db_path, config.bridge_config)?
        } else {
            let snapshot: GraphSnapshot =
                serde_json::from_slice(&std::fs::read(&config.snapshot_path).with_context(
                    || format!("read initial snapshot {}", config.snapshot_path.display()),
                )?)?;
            Kernel::create_with_node_bridge(&config.db_path, snapshot, config.bridge_config)?
        };
        let journal_path = private_journal_path(&config.db_path);
        let journal = RequestJournal::open(&journal_path)?;
        let next_tick = journal
            .max_tick()
            .checked_add(1)
            .context("service logical tick overflow")?;
        let session = Arc::new(Self {
            kernel: Arc::new(kernel),
            journal: Mutex::new(journal),
            audit: Mutex::new(ServiceAudit::open(&config.audit_path)?),
            next_tick: AtomicU64::new(next_tick),
            change_set_locks: Mutex::new(BTreeMap::new()),
            delivered_events: Mutex::new(BTreeMap::new()),
            recovered: existed,
        });
        session.resolve_pending_before_bind()?;
        session.append_audit(AuditEvent {
            kind: if existed {
                "service_recovered".into()
            } else {
                "service_started".into()
            },
            tick: None,
            request_hash: None,
            client_hash: None,
            action: None,
            change_set_id: None,
            state: None,
            graph_generation: session.kernel.snapshot().generation().to_string(),
        })?;
        Ok((session, recovery.service_epoch))
    }

    pub fn recovered(&self) -> bool {
        self.recovered
    }

    pub fn handle_frame(&self, bytes: &[u8]) -> LocalServiceResponse {
        let parsed = parse_request_frame(bytes, None);
        match parsed {
            Ok(request) => self.handle_request(request),
            Err(error) => LocalServiceResponse::error(
                request_id_from_untrusted_frame(bytes),
                "invalid_request",
                bounded_message(&error.to_string()),
                false,
                Vec::new(),
            ),
        }
    }

    fn handle_request(&self, request: LocalServiceRequest) -> LocalServiceResponse {
        if !request.action.is_mutating() {
            return match self.execute_read(&request.client_id, &request.action) {
                Ok(result) => {
                    let response = LocalServiceResponse::success(&request.request_id, result);
                    let _ = self.audit_request(&request, None, &response, "request_completed");
                    response
                }
                Err(error) => LocalServiceResponse::error(
                    &request.request_id,
                    "request_failed",
                    bounded_message(&error.to_string()),
                    false,
                    Vec::new(),
                ),
            };
        }

        match self.handle_mutation(&request) {
            Ok(response) => response,
            Err(_error) => LocalServiceResponse::error(
                &request.request_id,
                "request_failed",
                "request could not be completed",
                false,
                Vec::new(),
            ),
        }
    }

    fn handle_mutation(&self, request: &LocalServiceRequest) -> Result<LocalServiceResponse> {
        let key = request
            .idempotency_key
            .as_deref()
            .context("mutating request is missing idempotency key")?;
        let identity = request_identity(&request.client_id, key);
        let body_hash = action_body_hash(&request.client_id, &request.action)?;
        {
            let journal = self.journal.lock().map_err(lock_error)?;
            if let Some(entry) = journal.entry(&identity) {
                match entry {
                    RequestLedgerEntry::Completed {
                        body_hash: previous,
                        response,
                    } if previous == &body_hash => {
                        let replay = response.with_request_id(&request.request_id);
                        drop(journal);
                        self.audit_request(request, None, &replay, "request_replayed")?;
                        return Ok(replay);
                    }
                    RequestLedgerEntry::Completed { .. } => {
                        return Ok(LocalServiceResponse::error(
                            &request.request_id,
                            "idempotency_conflict",
                            "idempotency key was already used with a different action",
                            false,
                            Vec::new(),
                        ));
                    }
                    RequestLedgerEntry::Pending(pending) => {
                        if pending.body_hash != body_hash {
                            return Ok(LocalServiceResponse::error(
                                &request.request_id,
                                "idempotency_conflict",
                                "idempotency key was already used with a different action",
                                false,
                                Vec::new(),
                            ));
                        }
                    }
                }
            }
        }

        let lock = self.change_set_lock(request.action.change_set_id().unwrap_or(&identity))?;
        let _guard = lock.lock().map_err(lock_error)?;
        {
            let journal = self.journal.lock().map_err(lock_error)?;
            if let Some(entry) = journal.entry(&identity) {
                return match entry {
                    RequestLedgerEntry::Completed {
                        body_hash: previous,
                        response,
                    } if previous == &body_hash => {
                        let replay = response.with_request_id(&request.request_id);
                        drop(journal);
                        self.audit_request(request, None, &replay, "request_replayed")?;
                        Ok(replay)
                    }
                    RequestLedgerEntry::Completed { .. } => Ok(LocalServiceResponse::error(
                        &request.request_id,
                        "idempotency_conflict",
                        "idempotency key was already used with a different action",
                        false,
                        Vec::new(),
                    )),
                    RequestLedgerEntry::Pending(pending) => {
                        if pending.body_hash != body_hash {
                            Ok(LocalServiceResponse::error(
                                &request.request_id,
                                "idempotency_conflict",
                                "idempotency key was already used with a different action",
                                false,
                                Vec::new(),
                            ))
                        } else {
                            Ok(LocalServiceResponse::error(
                                &request.request_id,
                                "request_in_progress",
                                "idempotent request is still in progress",
                                true,
                                Vec::new(),
                            ))
                        }
                    }
                };
            }
        }
        self.authorize_actor(&request.client_id, &request.action)?;
        self.authorize_event_ack(&request.client_id, &request.action)?;

        let tick = self.next_tick.fetch_add(1, Ordering::SeqCst);
        if tick == u64::MAX {
            bail!("service logical tick overflow");
        }
        let baseline_intents = match &request.action {
            RequestAction::AddIntent { change_set_id, .. } => self
                .kernel
                .intents_for_change_set_bounded(change_set_id, MAX_INTENTS)?,
            _ => Vec::new(),
        };
        let pending = PendingRequest {
            identity: identity.clone(),
            client_id: request.client_id.clone(),
            idempotency_key: key.to_owned(),
            body_hash: body_hash.clone(),
            tick,
            action: request.action.clone(),
            baseline_intents,
        };
        self.journal
            .lock()
            .map_err(lock_error)?
            .append_pending(pending.clone())?;
        let response = self
            .execute_pending(&pending, &request.request_id)
            .unwrap_or_else(|_error| {
                LocalServiceResponse::error(
                    &request.request_id,
                    "request_failed",
                    "request could not be completed",
                    false,
                    Vec::new(),
                )
            });
        self.journal.lock().map_err(lock_error)?.append_completed(
            identity,
            body_hash,
            response.clone(),
        )?;
        self.audit_request(request, Some(tick), &response, "request_completed")?;
        Ok(response)
    }

    fn resolve_pending_before_bind(&self) -> Result<()> {
        let pending = self
            .journal
            .lock()
            .map_err(lock_error)?
            .entries()
            .values()
            .filter_map(|entry| match entry {
                RequestLedgerEntry::Pending(request) => Some(request.clone()),
                RequestLedgerEntry::Completed { .. } => None,
            })
            .collect::<Vec<_>>();
        for request in pending {
            let lock = self.change_set_lock(
                request
                    .action
                    .change_set_id()
                    .unwrap_or(request.identity.as_str()),
            )?;
            let _guard = lock.lock().map_err(lock_error)?;
            self.authorize_actor(&request.client_id, &request.action)?;
            let response = if self.add_intent_was_committed(&request)? {
                let change_set_id = request
                    .action
                    .change_set_id()
                    .context("reconciled add intent has no change set")?;
                LocalServiceResponse::success(
                    "recovered",
                    self.change_set_result(change_set_id, None, None)?,
                )
            } else {
                self.execute_pending(&request, "recovered")
                    .unwrap_or_else(|_error| {
                        LocalServiceResponse::error(
                            "recovered",
                            "request_failed",
                            "request could not be completed",
                            false,
                            Vec::new(),
                        )
                    })
            };
            self.journal.lock().map_err(lock_error)?.append_completed(
                request.identity.clone(),
                request.body_hash.clone(),
                response,
            )?;
            self.append_audit(AuditEvent {
                kind: "request_recovered".into(),
                tick: Some(request.tick.to_string()),
                request_hash: None,
                client_hash: Some(client_hash(&request.client_id)),
                action: Some(request.action.name().into()),
                change_set_id: request.action.change_set_id().map(str::to_owned),
                state: None,
                graph_generation: self.kernel.snapshot().generation().to_string(),
            })?;
        }
        Ok(())
    }

    fn add_intent_was_committed(&self, pending: &PendingRequest) -> Result<bool> {
        let (change_set_id, expected) = match &pending.action {
            RequestAction::AddIntent {
                change_set_id,
                intent,
            } => (change_set_id, wire_intent(intent)),
            _ => return Ok(false),
        };
        let current = self
            .kernel
            .intents_for_change_set_bounded(change_set_id, MAX_INTENTS)?;
        let baseline_ids = pending
            .baseline_intents
            .iter()
            .map(|intent| intent.intent_id.as_str())
            .collect::<BTreeSet<_>>();
        if !pending.baseline_intents.iter().all(|baseline| {
            current
                .iter()
                .any(|intent| intent.intent_id == baseline.intent_id && intent == baseline)
        }) {
            bail!("pending add-intent baseline no longer matches durable state");
        }
        let added = current
            .iter()
            .filter(|intent| !baseline_ids.contains(intent.intent_id.as_str()))
            .collect::<Vec<_>>();
        match added.as_slice() {
            [] => Ok(false),
            [intent] if intent.parameters == expected => Ok(true),
            _ => bail!("pending add-intent reconciliation is ambiguous"),
        }
    }

    fn execute_pending(
        &self,
        pending: &PendingRequest,
        request_id: &str,
    ) -> Result<LocalServiceResponse> {
        let result = match &pending.action {
            RequestAction::BeginChangeSet { reasoning } => {
                let change_set_id =
                    deterministic_change_set_id(&pending.client_id, &pending.idempotency_key);
                self.kernel.begin_change_set(
                    BeginChangeSet {
                        change_set_id: change_set_id.clone(),
                        actor: pending.client_id.clone(),
                        reasoning: reasoning.clone(),
                        submission_idempotency_key: pending.identity.clone(),
                    },
                    pending.tick,
                )?;
                self.change_set_result(&change_set_id, None, None)?
            }
            RequestAction::AddIntent {
                change_set_id,
                intent,
            } => {
                self.kernel.add_intent(change_set_id, wire_intent(intent))?;
                self.change_set_result(change_set_id, None, None)?
            }
            RequestAction::SubmitChangeSet { change_set_id } => {
                self.kernel.submit_change_set(change_set_id, pending.tick)?;
                self.change_set_result(change_set_id, None, None)?
            }
            RequestAction::AdvanceChangeSet { change_set_id } => {
                return self.advance(change_set_id, pending.tick, request_id);
            }
            RequestAction::AckEvents { through_sequence } => {
                self.kernel
                    .ack_events(&pending.client_id, through_sequence.get())?;
                ResponseResult::EventsAcked {
                    through_sequence: *through_sequence,
                }
            }
            RequestAction::CancelChangeSet { change_set_id } => {
                self.kernel.cancel_change_set(change_set_id, pending.tick)?;
                ResponseResult::Cancelled {
                    change_set_id: change_set_id.clone(),
                    state: CancelledState::Cancelled,
                }
            }
            RequestAction::Hello { .. }
            | RequestAction::InspectNodes { .. }
            | RequestAction::ReadEvents { .. } => {
                bail!("read-only action cannot be in the mutation journal")
            }
        };
        Ok(LocalServiceResponse::success(request_id, result))
    }

    fn advance(
        &self,
        change_set_id: &str,
        tick: u64,
        request_id: &str,
    ) -> Result<LocalServiceResponse> {
        let change_set = self
            .kernel
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
        if change_set.state != KernelChangeSetState::Ready {
            return Ok(LocalServiceResponse::success(
                request_id,
                self.change_set_result(change_set_id, None, None)?,
            ));
        }
        let offer = self
            .kernel
            .ready_offer_for_change_set(change_set_id)?
            .context("ready change set is missing its server offer")?;
        match self
            .kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, tick)?
        {
            ClaimOutcome::Claimed(claim) => {
                self.append_audit(AuditEvent {
                    kind: "claim_retained".into(),
                    tick: Some(tick.to_string()),
                    request_hash: Some(client_hash(request_id)),
                    client_hash: None,
                    action: Some("advance_change_set".into()),
                    change_set_id: Some(change_set_id.into()),
                    state: Some("claimed".into()),
                    graph_generation: self.kernel.snapshot().generation().to_string(),
                })?;
                match self.kernel.execute_claimed(&claim, tick) {
                    Ok(PublishClaimOutcome::Published(report)) => {
                        Ok(LocalServiceResponse::success(
                            request_id,
                            self.change_set_result(change_set_id, Some(report.digest), None)?,
                        ))
                    }
                    Ok(PublishClaimOutcome::Requeued { .. })
                    | Ok(PublishClaimOutcome::NeedsDecision { .. }) => {
                        Ok(LocalServiceResponse::success(
                            request_id,
                            self.change_set_result(change_set_id, None, None)?,
                        ))
                    }
                    Err(_error) => {
                        self.append_audit(AuditEvent {
                            kind: "validation_failed".into(),
                            tick: Some(tick.to_string()),
                            request_hash: Some(client_hash(request_id)),
                            client_hash: None,
                            action: Some("advance_change_set".into()),
                            change_set_id: Some(change_set_id.into()),
                            state: Some("validation_failed".into()),
                            graph_generation: self.kernel.snapshot().generation().to_string(),
                        })?;
                        self.kernel.cancel_change_set(change_set_id, tick)?;
                        Ok(LocalServiceResponse::success(
                            request_id,
                            self.change_set_result(
                                change_set_id,
                                None,
                                Some(Diagnostic {
                                    code: "candidate_validation_failed".into(),
                                    message: "candidate validation failed".into(),
                                    node_id: None,
                                }),
                            )?
                            .with_state(ChangeSetState::ValidationFailed),
                        ))
                    }
                }
            }
            ClaimOutcome::Requeued { .. } | ClaimOutcome::NeedsDecision { .. } => {
                Ok(LocalServiceResponse::success(
                    request_id,
                    self.change_set_result(change_set_id, None, None)?,
                ))
            }
        }
    }

    fn execute_read(&self, client_id: &str, action: &RequestAction) -> Result<ResponseResult> {
        match action {
            RequestAction::Hello { .. } => Ok(ResponseResult::Ready {}),
            RequestAction::InspectNodes { node_ids } => self.inspect_nodes(node_ids),
            RequestAction::ReadEvents {
                after_sequence,
                limit,
            } => {
                let events =
                    self.kernel
                        .events_after(client_id, after_sequence.get(), *limit as usize)?;
                if let Some(last) = events.last() {
                    self.delivered_events
                        .lock()
                        .map_err(lock_error)?
                        .entry(client_id.to_owned())
                        .and_modify(|sequence| *sequence = (*sequence).max(last.sequence))
                        .or_insert(last.sequence);
                }
                Ok(ResponseResult::Events {
                    events: events
                        .into_iter()
                        .map(|event| self.safe_event(event))
                        .collect::<Result<Vec<_>>>()?,
                })
            }
            _ => bail!("mutating action cannot use the read path"),
        }
    }

    fn inspect_nodes(&self, node_ids: &[String]) -> Result<ResponseResult> {
        let graph = self.kernel.snapshot();
        let mut nodes = Vec::with_capacity(node_ids.len());
        for node_id in node_ids {
            let node = graph
                .node(node_id)
                .with_context(|| format!("node {node_id} does not exist"))?;
            let mut relationships = Vec::new();
            if let Some(parent) = &node.parent_id {
                relationships.push(NodeRelationship {
                    kind: "parent".into(),
                    node_id: parent.clone(),
                });
            }
            for child in graph.children_bounded(node_id, MAX_RELATIONSHIPS)? {
                relationships.push(NodeRelationship {
                    kind: "child".into(),
                    node_id: child.id.clone(),
                });
            }
            if let Some(reference) = graph.reference_from(node_id) {
                relationships.push(NodeRelationship {
                    kind: format!("outgoing:{}", reference.kind),
                    node_id: reference.to_node_id.clone(),
                });
            }
            for reference in graph.references_to(node_id) {
                if relationships.len() >= MAX_RELATIONSHIPS {
                    bail!("node {node_id} immediate relationships exceed bound");
                }
                relationships.push(NodeRelationship {
                    kind: format!("incoming:{}", reference.kind),
                    node_id: reference.from_node_id.clone(),
                });
            }
            if relationships.len() > MAX_RELATIONSHIPS {
                bail!("node {node_id} immediate relationships exceed bound");
            }
            nodes.push(InspectedNode {
                node_id: node.id.clone(),
                kind: node.kind.clone(),
                payload: node.payload.clone(),
                relationships,
            });
        }
        Ok(ResponseResult::Nodes {
            graph_generation: WireU64::new(graph.generation()),
            nodes,
        })
    }

    fn safe_event(&self, event: strata_kernel::CoordinationEvent) -> Result<ServiceEvent> {
        let operation = if event.kind == CoordinationEventKind::IntentCommitted {
            self.kernel.operation(event.graph_generation)?
        } else {
            None
        };
        let digest = if event.kind == CoordinationEventKind::IntentCommitted
            && self.kernel.snapshot().generation() == event.graph_generation
        {
            Some(self.kernel.snapshot().digest().to_owned())
        } else {
            None
        };
        Ok(ServiceEvent {
            sequence: WireU64::new(event.sequence),
            change_set_id: event.change_set_id,
            state: event_state(&event.kind),
            operation_id: operation.as_ref().map(|record| record.operation_id.clone()),
            affected_node_ids: operation
                .map(|record| record.affected_node_ids)
                .unwrap_or_default(),
            diagnostics: Vec::new(),
            publication_digest: digest,
        })
    }

    fn change_set_result(
        &self,
        change_set_id: &str,
        publication_digest: Option<String>,
        diagnostic: Option<Diagnostic>,
    ) -> Result<ResponseResult> {
        let change_set = self
            .kernel
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
        let ticket = self.kernel.ticket_for_change_set(change_set_id)?;
        let operation = change_set
            .committed_generation
            .map(|generation| self.kernel.operation(generation))
            .transpose()?
            .flatten();
        Ok(ResponseResult::ChangeSet {
            change_set_id: change_set.change_set_id,
            state: kernel_state(&change_set.state),
            ticket_state: ticket.as_ref().map(|ticket| kernel_ticket(&ticket.state)),
            graph_generation: WireU64::new(self.kernel.snapshot().generation()),
            operation_id: operation.as_ref().map(|record| record.operation_id.clone()),
            affected_node_ids: operation
                .map(|record| record.affected_node_ids)
                .unwrap_or_default(),
            diagnostics: diagnostic.into_iter().collect(),
            publication_digest,
        })
    }

    fn authorize_actor(&self, client_id: &str, action: &RequestAction) -> Result<()> {
        if let Some(change_set_id) = action.change_set_id() {
            let change_set = self
                .kernel
                .change_set(change_set_id)?
                .with_context(|| format!("change set {change_set_id} does not exist"))?;
            if change_set.actor != client_id {
                bail!("change set belongs to a different client");
            }
        }
        Ok(())
    }

    fn authorize_event_ack(&self, client_id: &str, action: &RequestAction) -> Result<()> {
        if let RequestAction::AckEvents { through_sequence } = action {
            let delivered = self
                .delivered_events
                .lock()
                .map_err(lock_error)?
                .get(client_id)
                .copied()
                .unwrap_or(0);
            if through_sequence.get() > delivered {
                bail!("cannot acknowledge an event sequence not delivered to this client");
            }
        }
        Ok(())
    }

    fn change_set_lock(&self, id: &str) -> Result<Arc<Mutex<()>>> {
        Ok(self
            .change_set_locks
            .lock()
            .map_err(lock_error)?
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    fn audit_request(
        &self,
        request: &LocalServiceRequest,
        tick: Option<u64>,
        response: &LocalServiceResponse,
        kind: &str,
    ) -> Result<()> {
        self.append_audit(AuditEvent {
            kind: kind.into(),
            tick: tick.map(|value| value.to_string()),
            request_hash: Some(client_hash(&request.request_id)),
            client_hash: Some(client_hash(&request.client_id)),
            action: Some(request.action.name().into()),
            change_set_id: response_change_set_id(response)
                .or_else(|| request.action.change_set_id().map(str::to_owned)),
            state: response_state(response),
            graph_generation: self.kernel.snapshot().generation().to_string(),
        })
    }

    fn append_audit(&self, event: AuditEvent) -> Result<()> {
        self.audit.lock().map_err(lock_error)?.append(event)
    }
}

trait ResponseResultStateOverride {
    fn with_state(self, state: ChangeSetState) -> Self;
}

impl ResponseResultStateOverride for ResponseResult {
    fn with_state(self, state: ChangeSetState) -> Self {
        match self {
            Self::ChangeSet {
                change_set_id,
                ticket_state,
                graph_generation,
                operation_id,
                affected_node_ids,
                diagnostics,
                publication_digest,
                ..
            } => Self::ChangeSet {
                change_set_id,
                state,
                ticket_state,
                graph_generation,
                operation_id,
                affected_node_ids,
                diagnostics,
                publication_digest,
            },
            other => other,
        }
    }
}

fn wire_intent(intent: &Intent) -> IntentParameters {
    match intent {
        Intent::RenameSymbol {
            declaration_id,
            new_name,
        } => IntentParameters::RenameSymbol {
            declaration_id: declaration_id.clone(),
            new_name: new_name.clone(),
        },
        Intent::AddParameter {
            function_id,
            name,
            type_text,
            position,
            value,
        } => IntentParameters::AddParameter {
            function_id: function_id.clone(),
            name: name.clone(),
            type_text: type_text.clone(),
            position: *position,
            default_value: Some(value.clone()),
        },
    }
}

fn deterministic_change_set_id(client_id: &str, key: &str) -> String {
    let digest = Sha256::digest(format!("{client_id}\0{key}").as_bytes());
    format!("change:{digest:x}")
}

fn kernel_state(state: &KernelChangeSetState) -> ChangeSetState {
    match state {
        KernelChangeSetState::Draft => ChangeSetState::Draft,
        KernelChangeSetState::Queued => ChangeSetState::Queued,
        KernelChangeSetState::Ready => ChangeSetState::Ready,
        KernelChangeSetState::Executing => ChangeSetState::Claimed,
        KernelChangeSetState::Committed => ChangeSetState::Published,
        KernelChangeSetState::NeedsDecision => ChangeSetState::NeedsDecision,
        KernelChangeSetState::Cancelled => ChangeSetState::Cancelled,
        KernelChangeSetState::Failed => ChangeSetState::Failed,
    }
}

fn kernel_ticket(state: &KernelTicketState) -> TicketState {
    match state {
        KernelTicketState::Queued => TicketState::Queued,
        KernelTicketState::Ready => TicketState::Ready,
        KernelTicketState::Claimed => TicketState::Claimed,
        KernelTicketState::Completed => TicketState::Completed,
        KernelTicketState::NeedsDecision => TicketState::NeedsDecision,
        KernelTicketState::Cancelled => TicketState::Cancelled,
        KernelTicketState::Failed => TicketState::Failed,
    }
}

fn event_state(kind: &CoordinationEventKind) -> ChangeSetState {
    match kind {
        CoordinationEventKind::IntentQueued | CoordinationEventKind::ScopeExpanded => {
            ChangeSetState::Queued
        }
        CoordinationEventKind::IntentReady => ChangeSetState::Ready,
        CoordinationEventKind::IntentNeedsDecision => ChangeSetState::NeedsDecision,
        CoordinationEventKind::IntentCommitted => ChangeSetState::Published,
        CoordinationEventKind::IntentCancelled => ChangeSetState::Cancelled,
        CoordinationEventKind::IntentFailed => ChangeSetState::Failed,
        CoordinationEventKind::LeaseExpired => ChangeSetState::Queued,
    }
}

fn response_change_set_id(response: &LocalServiceResponse) -> Option<String> {
    match response {
        LocalServiceResponse::Success(success) => match &success.result {
            ResponseResult::ChangeSet { change_set_id, .. }
            | ResponseResult::Cancelled { change_set_id, .. } => Some(change_set_id.clone()),
            _ => None,
        },
        LocalServiceResponse::Error(_) => None,
    }
}

fn response_state(response: &LocalServiceResponse) -> Option<String> {
    match response {
        LocalServiceResponse::Success(success) => match &success.result {
            ResponseResult::ChangeSet { state, .. } => Some(format!("{state:?}").to_lowercase()),
            ResponseResult::Cancelled { .. } => Some("cancelled".into()),
            _ => None,
        },
        LocalServiceResponse::Error(_) => Some("error".into()),
    }
}

fn private_journal_path(db_path: &Path) -> PathBuf {
    let mut path = db_path.as_os_str().to_os_string();
    path.push(".service-journal.jsonl");
    PathBuf::from(path)
}

fn bounded_message(message: &str) -> String {
    const LIMIT: usize = 16_384;
    if message.len() <= LIMIT {
        return message.to_owned();
    }
    let mut end = LIMIT;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_owned()
}

fn request_id_from_untrusted_frame(bytes: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(bytes.strip_suffix(b"\n").unwrap_or(bytes))
        .ok()
        .and_then(|value| value.get("requestId")?.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .unwrap_or_else(|| "invalid".into())
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> anyhow::Error {
    anyhow::anyhow!("service state lock is poisoned")
}
