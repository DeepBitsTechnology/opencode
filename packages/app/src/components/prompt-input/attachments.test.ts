import { describe, expect, test } from "bun:test"
import { ACCEPTED_FILE_TYPES, attachmentMime, pickAttachmentFiles } from "./files"
import { pasteMode } from "./paste"

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})

describe("pickAttachmentFiles", () => {
  test("opens the native picker without a project default path", async () => {
    const options: { multiple?: boolean; accept?: string[]; defaultPath?: string }[] = []
    const files: File[] = []
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    const picker = async (
      option?: { multiple?: boolean; accept?: string[]; defaultPath?: string },
      onFile?: (file: File) => Promise<unknown>,
    ) => {
      options.push(option ?? {})
      await onFile?.(file)
    }

    pickAttachmentFiles({
      picker,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    pickAttachmentFiles({
      picker,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    expect(files).toEqual([file, file])
    expect(options).toEqual([
      { multiple: true, accept: ACCEPTED_FILE_TYPES },
      { multiple: true, accept: ACCEPTED_FILE_TYPES },
    ])
  })

  test("uses the browser file input when no native picker exists", async () => {
    let fallback = 0
    pickAttachmentFiles({
      fallback: () => {
        fallback += 1
      },
      onFile: async () => undefined,
      onError: () => undefined,
    })
    expect(fallback).toBe(1)
  })

  test("reports native picker failures without rejecting", async () => {
    const error = new Error("picker unavailable")
    const errors: unknown[] = []
    const handled = Promise.withResolvers<void>()
    pickAttachmentFiles({
      picker: async () => Promise.reject(error),
      fallback: () => undefined,
      onFile: async () => undefined,
      onError: (cause) => {
        errors.push(cause)
        handled.resolve()
      },
    })
    await handled.promise
    expect(errors).toEqual([error])
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})
