import { describe, expect, it, vi } from "vitest";
import { requestPairingCode } from "../src/commands/link.js";

describe("pairing-code readiness", () => {
  it("waits for the WebSocket before requesting a code", async () => {
    let releaseReady!: () => void;
    const waitForSocketOpen = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReady = resolve;
        }),
    );
    const requestPairingCodeMock = vi.fn().mockResolvedValue("ABCD1234");
    const socket = {
      waitForSocketOpen,
      requestPairingCode: requestPairingCodeMock,
    };

    const result = requestPairingCode(socket, "49123456789");
    await Promise.resolve();

    expect(waitForSocketOpen).toHaveBeenCalledOnce();
    expect(requestPairingCodeMock).not.toHaveBeenCalled();

    releaseReady();
    await expect(result).resolves.toBe("ABCD1234");
    expect(requestPairingCodeMock).toHaveBeenCalledWith("49123456789");
  });

  it("does not request a code when the socket readiness wait fails", async () => {
    const requestPairingCodeMock = vi.fn();
    const socket = {
      waitForSocketOpen: vi.fn().mockRejectedValue(new Error("closed")),
      requestPairingCode: requestPairingCodeMock,
    };

    await expect(requestPairingCode(socket, "49123456789")).rejects.toThrow(
      "closed",
    );
    expect(requestPairingCodeMock).not.toHaveBeenCalled();
  });
});
