// FIX1-FULLREV2(G1): next-args.mjs 의 타입(apps/web tsconfig 는 allowJs=false — 시험 파일이 이 선언으로 타입 검사된다).
export function nextSubcommand(argv: readonly string[]): string | undefined;
export function explicitHostname(args: readonly string[]): { value: string | undefined } | null;
export function isLoopbackHostname(host: unknown): boolean;
export function defaultDevHostname(appBaseUrl: string | undefined): 'localhost' | '127.0.0.1';
export function devHostnameWarning(value: string): string;
export function buildNextArgs(argv: readonly string[], options?: { appBaseUrl?: string }): { args: string[]; warning: string | null };
export function readAppBaseUrl(
  env: Record<string, string | undefined>,
  appRoot: string,
  readText: (p: string) => string,
): string | undefined;
