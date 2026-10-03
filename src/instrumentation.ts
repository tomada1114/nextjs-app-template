/** Validate deployment configuration before the server accepts requests. */
export async function register(): Promise<void> {
  const { readServerEnv } = await import("./server/env");
  const { ADAPTER_BILLS_A_PROVIDER } = await import("./server/adapter-policy");
  try {
    readServerEnv({ billsAProvider: ADAPTER_BILLS_A_PROVIDER });
  } catch (error) {
    // Next.js logs preparation failures but can keep the listener alive.
    // A deployment missing required configuration must fail its startup.
    const details = error instanceof Error ? error.message : "Invalid environment.";
    await new Promise<void>((resolve) => {
      process.stderr.write(
        `Server startup configuration is invalid:\n${details}\n`,
        () => {
          resolve();
        },
      );
    });
    process.exit(1);
  }
}
