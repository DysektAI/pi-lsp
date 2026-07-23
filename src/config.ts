import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type InstallMode = "prompt" | "auto" | "off";
export type LspConfig = { installMode: InstallMode; warmup: boolean };
export const DEFAULT_CONFIG: LspConfig = { installMode: "prompt", warmup: true };

export function configDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function loadConfig(): LspConfig {
  const path = join(configDir(), "lsp.json");
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      installMode: ["prompt", "auto", "off"].includes(value.installMode) ? value.installMode : "prompt",
      warmup: typeof value.warmup === "boolean" ? value.warmup : true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
