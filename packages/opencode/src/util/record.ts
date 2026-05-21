import { isRecord } from "@opencode-ai/tui/util/record"

export * from "@opencode-ai/tui/util/record"

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}
