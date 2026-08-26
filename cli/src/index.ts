// Public API of the subrouter package: stores, routing engine and adapters.
export * from './store.ts'
export * from './router.ts'
export {
  adapters,
  classifyFailure,
  failureDetailsFromError,
  isPermanentRefreshFailure,
  type FailureDetails,
  type ProviderAdapter,
  type LoginArgs,
  type PersistTokens,
} from './adapters/index.ts'
