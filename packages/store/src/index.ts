export { nodeId } from "./ids";
export {
  appendOperations,
  listOperationsByTx,
  type OperationRow
} from "./operations";
export {
  getReferenceFrom,
  getReferencesByTo,
  insertReferences,
  type Reference,
  type ReferenceKind
} from "./references";
export {
  find_declarations,
  findDeclarations,
  get_references,
  getReferences,
  type DeclarationKind,
  type FindDeclarationsInput
} from "./queries";
export {
  findNodeById,
  insertNodes,
  listChildren,
  listModules,
  loadModule,
  modulePathOf,
  type LoadedModule,
  type NodeRow
} from "./nodes";
export {
  resolveCallsites,
  type Callsite,
  type CallsiteResolution,
  type CallsiteResolutionCounts,
  type NonCallReference,
  type UnresolvedReference
} from "./callsites";
export {
  readNode,
  read_node,
  type ReadNodeOptions,
  type ReadNodeResult
} from "./read_node";
export {
  add_parameter,
  addParameter,
  type AddParameterManifest,
  type AddParameterCallsiteEdit,
  type AddParameterArityRiskSite
} from "./addParameter";
export { add_import, addImport, type AddImportResult } from "./addImport";
export {
  find_declarations_in_module,
  findDeclarationsInModule,
  list_module_exports,
  listModuleExports,
  type DiscoveryKind,
  type FindInModuleInput,
  type ModuleExport
} from "./discovery";
export { change_return_type, changeReturnType } from "./changeReturnType";
export {
  create_function,
  createFunction,
  type CreateFunctionResult
} from "./createFunction";
export { replace_body, replaceBody } from "./replaceBody";
export { rename_symbol, renameSymbol } from "./rename";
export { EMBEDDING_DIM, isVecAvailable, openDb, type Db } from "./schema";
export {
  buildDeclarationEmbeddingText,
  embedDeclarations,
  OpenAIEmbeddingProvider,
  type EmbedDeclarationsResult,
  type EmbeddingProvider,
  type OpenAIEmbeddingProviderOptions
} from "./embed";
export {
  semantic_search,
  semanticSearch,
  type SemanticHit
} from "./semanticSearch";
export {
  buildCommitPattern,
  embedCommitPattern,
  renderCommitPatternForEmbedding,
  retrieveSimilarPastTasks,
  type CommitPattern,
  type PastTaskHit
} from "./commitPatterns";
export { locateSpan, type Span, type SpanKind } from "./spanReparse";
export {
  begin,
  commitWithoutValidate,
  getOverlay,
  queueIdentifierUpdate,
  queueTextSpanEdit,
  queuePendingOp,
  rollback,
  startupRecoverOpenTransactions,
  trackInsertedNode,
  type PendingOp,
  type TextSpanEdit,
  type TxHandle,
  type TxOverlay
} from "./transactions";
