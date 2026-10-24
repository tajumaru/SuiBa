export const requiredNodeRange: string;
export function isSupportedNodeVersion(version: string): boolean;
export function assertNodeVersion(options?: { report?: boolean }): {
  version: string;
  execPath: string;
  platform: NodeJS.Platform;
  arch: string;
};
