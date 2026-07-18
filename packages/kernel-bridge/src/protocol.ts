import {
  compareCodeUnits,
  parseCanonicalU64,
  type CanonicalU64,
  type KernelSnapshotV1
} from "@strata/ingest";
import { z } from "zod";

export const MAX_PROTOCOL_ARRAY_ITEMS = 1_000_000;

const nonEmptyStringSchema = z.string().min(1);
const opaqueIdSchema = nonEmptyStringSchema;
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const canonicalU64Schema = z.custom<CanonicalU64>((value) => {
  try {
    parseCanonicalU64(value);
    return true;
  } catch {
    return false;
  }
}, "expected a canonical unsigned 64-bit decimal string");

export const kernelNodeV1Schema = z
  .object({
    id: opaqueIdSchema,
    kind: nonEmptyStringSchema,
    parentId: opaqueIdSchema.nullable(),
    childIndex: z.number().int().safe().nonnegative().nullable(),
    payload: z.string()
  })
  .strict();

export const kernelReferenceV1Schema = z
  .object({
    fromNodeId: opaqueIdSchema,
    toNodeId: opaqueIdSchema,
    kind: nonEmptyStringSchema
  })
  .strict();

function compareReferences(
  a: z.infer<typeof kernelReferenceV1Schema>,
  b: z.infer<typeof kernelReferenceV1Schema>
): number {
  return (
    compareCodeUnits(a.fromNodeId, b.fromNodeId) ||
    compareCodeUnits(a.toNodeId, b.toNodeId) ||
    compareCodeUnits(a.kind, b.kind)
  );
}

export const kernelSnapshotV1Schema: z.ZodType<KernelSnapshotV1> = z
  .object({
    schemaVersion: z.literal(1),
    generation: canonicalU64Schema,
    nodes: z.array(kernelNodeV1Schema).max(MAX_PROTOCOL_ARRAY_ITEMS),
    references: z.array(kernelReferenceV1Schema).max(MAX_PROTOCOL_ARRAY_ITEMS)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const nodeIds = new Set<string>();
    snapshot.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: `duplicate node id: ${node.id}`
        });
      }
      nodeIds.add(node.id);
      if (index > 0 && compareCodeUnits(snapshot.nodes[index - 1]!.id, node.id) >= 0) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index],
          message: "nodes must be uniquely sorted by id"
        });
      }
    });

    snapshot.nodes.forEach((node, index) => {
      if (node.parentId !== null && !nodeIds.has(node.parentId)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "parentId"],
          message: `dangling parent id: ${node.parentId}`
        });
      }
    });

    const referenceSources = new Set<string>();
    snapshot.references.forEach((reference, index) => {
      if (referenceSources.has(reference.fromNodeId)) {
        context.addIssue({
          code: "custom",
          path: ["references", index, "fromNodeId"],
          message: `duplicate reference source: ${reference.fromNodeId}`
        });
      }
      referenceSources.add(reference.fromNodeId);
      if (!nodeIds.has(reference.fromNodeId) || !nodeIds.has(reference.toNodeId)) {
        context.addIssue({
          code: "custom",
          path: ["references", index],
          message: "reference endpoint does not exist in snapshot"
        });
      }
      if (index > 0 && compareReferences(snapshot.references[index - 1]!, reference) >= 0) {
        context.addIssue({
          code: "custom",
          path: ["references", index],
          message: "references must be uniquely sorted"
        });
      }
    });
  });

export const bridgeKindSchema = z.enum(["analyzeIntent", "buildValidateCandidate"]);

export const bridgeBindingSchema = z
  .object({
    serviceEpoch: canonicalU64Schema,
    graphGeneration: canonicalU64Schema,
    graphDigest: hashSchema
  })
  .strict();

export const candidateResponseBindingSchema = bridgeBindingSchema
  .extend({
    attemptId: opaqueIdSchema,
    scopeFingerprint: hashSchema
  })
  .strict();

export const renameSymbolParametersSchema = z
  .object({
    type: z.literal("renameSymbol"),
    declarationId: opaqueIdSchema,
    newName: z.string()
  })
  .strict();

export const addParameterParametersSchema = z
  .object({
    type: z.literal("addParameter"),
    functionId: opaqueIdSchema,
    name: z.string(),
    typeText: z.string(),
    position: z.number().int().min(0).max(0xffff_ffff),
    defaultValue: z.string().nullable()
  })
  .strict();

export const intentParametersSchema = z.discriminatedUnion("type", [
  renameSymbolParametersSchema,
  addParameterParametersSchema
]);

export const intentRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    intentId: opaqueIdSchema,
    changeSetId: opaqueIdSchema,
    baseGeneration: canonicalU64Schema,
    parameters: intentParametersSchema
  })
  .strict();

const tscOnlyValidationProfileSchema = z
  .object({
    mode: z.literal("tscOnly"),
    sourceRoot: nonEmptyStringSchema,
    corpusRoot: nonEmptyStringSchema,
    behavioralFixtures: z.tuple([]),
    strictSrcOnlyTscScope: z.boolean()
  })
  .strict();

const behavioralValidationProfileSchema = z
  .object({
    mode: z.literal("behavioral"),
    sourceRoot: nonEmptyStringSchema,
    corpusRoot: nonEmptyStringSchema,
    behavioralFixtures: z.array(nonEmptyStringSchema).max(MAX_PROTOCOL_ARRAY_ITEMS),
    strictSrcOnlyTscScope: z.boolean()
  })
  .strict();

export const validationProfileSchema = z.discriminatedUnion("mode", [
  tscOnlyValidationProfileSchema,
  behavioralValidationProfileSchema
]);

export const analyzeIntentRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: opaqueIdSchema,
    kind: z.literal("analyzeIntent"),
    binding: bridgeBindingSchema,
    snapshot: kernelSnapshotV1Schema,
    intent: intentRecordSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (request.snapshot.generation !== request.binding.graphGeneration) {
      context.addIssue({ code: "custom", path: ["snapshot", "generation"], message: "snapshot generation does not match binding" });
    }
    if (request.intent.baseGeneration !== request.snapshot.generation) {
      context.addIssue({ code: "custom", path: ["intent", "baseGeneration"], message: "intent generation does not match snapshot" });
    }
  });

const changeSetSchema = z
  .object({
    changeSetId: opaqueIdSchema,
    actor: nonEmptyStringSchema,
    reasoning: z.string(),
    orderedIntents: z.array(intentRecordSchema).min(1).max(MAX_PROTOCOL_ARRAY_ITEMS)
  })
  .strict()
  .superRefine((changeSet, context) => {
    const intentIds = new Set<string>();
    changeSet.orderedIntents.forEach((intent, index) => {
      if (intentIds.has(intent.intentId)) {
        context.addIssue({
          code: "custom",
          path: ["orderedIntents", index, "intentId"],
          message: `duplicate intent id: ${intent.intentId}`
        });
      }
      intentIds.add(intent.intentId);
    });
  });

export const buildValidateCandidateRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: opaqueIdSchema,
    kind: z.literal("buildValidateCandidate"),
    binding: bridgeBindingSchema,
    snapshot: kernelSnapshotV1Schema,
    attemptId: opaqueIdSchema,
    scopeFingerprint: hashSchema,
    changeSet: changeSetSchema,
    validationProfile: validationProfileSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (request.snapshot.generation !== request.binding.graphGeneration) {
      context.addIssue({ code: "custom", path: ["snapshot", "generation"], message: "snapshot generation does not match binding" });
    }
    request.changeSet.orderedIntents.forEach((intent, index) => {
      if (intent.changeSetId !== request.changeSet.changeSetId) {
        context.addIssue({ code: "custom", path: ["changeSet", "orderedIntents", index, "changeSetId"], message: "intent change set id does not match" });
      }
      if (intent.baseGeneration !== request.snapshot.generation) {
        context.addIssue({ code: "custom", path: ["changeSet", "orderedIntents", index, "baseGeneration"], message: "intent generation does not match snapshot" });
      }
    });
  });

export const bridgeRequestSchema = z.union([
  analyzeIntentRequestSchema,
  buildValidateCandidateRequestSchema
]);

const boundedIdArraySchema = z
  .array(opaqueIdSchema)
  .max(MAX_PROTOCOL_ARRAY_ITEMS)
  .superRefine((values, context) => {
    values.forEach((value, index) => {
      if (index > 0 && compareCodeUnits(values[index - 1]!, value) >= 0) {
        context.addIssue({ code: "custom", path: [index], message: "IDs must be uniquely sorted" });
      }
    });
  });

const boundedReferenceArraySchema = z
  .array(kernelReferenceV1Schema)
  .max(MAX_PROTOCOL_ARRAY_ITEMS)
  .superRefine((values, context) => {
    values.forEach((value, index) => {
      if (index > 0 && compareReferences(values[index - 1]!, value) >= 0) {
        context.addIssue({ code: "custom", path: [index], message: "references must be uniquely sorted" });
      }
    });
  });

export const bridgeDiagnosticSchema = z
  .object({
    nodeId: opaqueIdSchema.nullable(),
    modulePath: z.string().nullable(),
    message: z.string(),
    code: z.number().int().safe()
  })
  .strict();

export const semanticFactsSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("renameSymbol"),
      declarationId: opaqueIdSchema,
      declarationNameIdentifierId: opaqueIdSchema,
      references: boundedReferenceArraySchema,
      writableStatementIds: boundedIdArraySchema,
      validationDependencyNodeIds: boundedIdArraySchema,
      validationDependencyReferenceFromNodeIds: boundedIdArraySchema
    })
    .strict(),
  z
    .object({
      type: z.literal("addParameter"),
      functionId: opaqueIdSchema,
      declarationNameIdentifierId: opaqueIdSchema,
      directCallReferences: boundedReferenceArraySchema,
      writableStatementIds: boundedIdArraySchema,
      arityRiskReferences: boundedReferenceArraySchema,
      arityRiskStatementIds: boundedIdArraySchema,
      unresolvedReferenceDiagnostics: z.array(bridgeDiagnosticSchema).max(MAX_PROTOCOL_ARRAY_ITEMS),
      functionBodyReadReferences: boundedReferenceArraySchema,
      contentDependencyDeclarationIds: boundedIdArraySchema,
      validationDependencyNodeIds: boundedIdArraySchema,
      validationDependencyReferenceFromNodeIds: boundedIdArraySchema
    })
    .strict()
]);

export const graphChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upsertNode"), node: kernelNodeV1Schema }).strict(),
  z.object({ type: z.literal("deleteNode"), nodeId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("upsertReference"), reference: kernelReferenceV1Schema }).strict(),
  z.object({ type: z.literal("deleteReference"), fromNodeId: opaqueIdSchema }).strict()
]);

export const kernelGraphDeltaV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    baseGeneration: canonicalU64Schema,
    changes: z.array(graphChangeSchema).max(MAX_PROTOCOL_ARRAY_ITEMS)
  })
  .strict();

const analyzeSuccessResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: opaqueIdSchema,
    kind: z.literal("analyzeIntent"),
    binding: bridgeBindingSchema,
    ok: z.literal(true),
    result: z.object({ facts: semanticFactsSchema }).strict()
  })
  .strict();

const candidateSuccessResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: opaqueIdSchema,
    kind: z.literal("buildValidateCandidate"),
    binding: candidateResponseBindingSchema,
    ok: z.literal(true),
    result: z
      .object({
        delta: kernelGraphDeltaV1Schema,
        diagnostics: z.tuple([])
      })
      .strict()
  })
  .strict()
  .superRefine((response, context) => {
    if (response.result.delta.baseGeneration !== response.binding.graphGeneration) {
      context.addIssue({
        code: "custom",
        path: ["result", "delta", "baseGeneration"],
        message: "candidate delta base generation does not match binding"
      });
    }
  });

export const bridgeErrorPayloadSchema = z
  .object({
    stage: z.enum(["protocol", "hydrate", "analyze", "mutate", "validate", "export"]),
    code: nonEmptyStringSchema,
    message: z.string(),
    diagnostics: z.array(bridgeDiagnosticSchema).max(MAX_PROTOCOL_ARRAY_ITEMS)
  })
  .strict();

const analyzeErrorResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: opaqueIdSchema,
    kind: z.literal("analyzeIntent"),
    binding: bridgeBindingSchema,
    ok: z.literal(false),
    error: bridgeErrorPayloadSchema
  })
  .strict();

const candidateErrorResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: opaqueIdSchema,
    kind: z.literal("buildValidateCandidate"),
    binding: candidateResponseBindingSchema,
    ok: z.literal(false),
    error: bridgeErrorPayloadSchema
  })
  .strict();

export const bridgeResponseSchema = z.union([
  analyzeSuccessResponseSchema,
  candidateSuccessResponseSchema,
  analyzeErrorResponseSchema,
  candidateErrorResponseSchema
]);

export type BridgeKind = z.infer<typeof bridgeKindSchema>;
export type BridgeBinding = z.infer<typeof bridgeBindingSchema>;
export type ValidationProfile = z.infer<typeof validationProfileSchema>;
export type IntentParameters = z.infer<typeof intentParametersSchema>;
export type IntentRecord = z.infer<typeof intentRecordSchema>;
export type AnalyzeIntentRequest = z.infer<typeof analyzeIntentRequestSchema>;
export type BuildValidateCandidateRequest = z.infer<typeof buildValidateCandidateRequestSchema>;
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;
export type BridgeErrorPayload = z.infer<typeof bridgeErrorPayloadSchema>;
export type BridgeDiagnostic = z.infer<typeof bridgeDiagnosticSchema>;
export type SemanticFacts = z.infer<typeof semanticFactsSchema>;
export type KernelGraphDeltaV1 = z.infer<typeof kernelGraphDeltaV1Schema>;
