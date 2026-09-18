import { describe, expect, it } from "vitest";
import { readMcpOAuthPassword } from "../src/commands/mcp.js";

describe("MCP OAuth password input", () => {
  it("reads a non-blocking stream and removes its final newline", async () => {
    async function* input(): AsyncGenerator<Buffer> {
      yield Buffer.from("operator-password\n");
    }
    await expect(readMcpOAuthPassword(input())).resolves.toBe("operator-password");
  });
});
