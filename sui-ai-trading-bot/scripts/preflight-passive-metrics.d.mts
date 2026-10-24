export function installPreflightMetrics(
  prototype: object,
  emit: (record: any) => void,
): { sample(): void; stop(): void };
