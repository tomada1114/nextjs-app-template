/**
 * Whether the default adapter wired by the composition root bills a provider.
 *
 * @remarks
 * Startup validation and route composition share this declaration so neither
 * can silently use different credential requirements. Reconsider it whenever
 * the composition root changes its default adapter; the boundary suite checks
 * that the declaration agrees with the adapter actually wired there.
 * `LLM_ADAPTER=fake` explicitly replaces that adapter, and `readServerEnv`
 * handles that exception as well as the production-build phase.
 */
export const ADAPTER_BILLS_A_PROVIDER = true;
