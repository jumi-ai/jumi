export function engineExitMessage(engine: string, exitCode: number | null, detail: string): string {
  return `${engine} exited with code ${exitCode}${detail ? `:\n${detail}` : ""}`;
}
