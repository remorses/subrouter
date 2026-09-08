// Public API of the subrouter package: stores, routing engine and adapters.
export * from './store.ts'
export * from './router.ts'
export {
  AUTH_SCHEMA_URL,
  CONFIG_SCHEMA_URL,
  SCHEMA_URL,
  authJsonSchema,
  configJsonSchema,
} from './schemas.ts'
export {
  adapters,
  classifyFailure,
  failureDetailsFromError,
  isPermanentRefreshFailure,
  closeOpenAIWebSockets,
  emitLog,
  loadModelsDevCatalog,
  modelsDevInputModalities,
  modelsDevLimit,
  modelsDevModel,
  parsePresetEntry,
  OPENAI_WEBSOCKET_SESSION_HEADER,
  OPENAI_WEBSOCKET_TITLE_HEADER,
  OPENCODE_GO_SESSION_HEADER,
  type FailureDetails,
  type ProviderAdapter,
  type LoginArgs,
  type PersistTokens,
  type SubrouterLog,
  type SubrouterLogEntry,
  type SubrouterLogExtra,
  type SubrouterLogLevel,
} from './adapters/index.ts'
