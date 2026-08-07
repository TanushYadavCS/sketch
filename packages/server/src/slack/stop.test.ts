import { describe, expect, it } from "vitest";
import { isSlackStopCommand, normalizeSlackStopCommand } from "./stop";

describe("Slack stop command normalisation", () => {
  it.each([
    ["<@UBOT> stop it please!", "stop", true],
    ["<@UBOT> KILL", "kill", true],
    ["<@UBOT> stop the deploy", "stop deploy", false],
    ["<@UBOT> can you stop", "can you stop", false],
    ["<@UBOT> <https://x.test|stop>", "", false],
    ["<@UBOT> <@U123> stop", "stop", true],
    ["<@UBOT> `*cancel*`!!!", "cancel", true],
    ["<@UBOT> please kill it", "kill", true],
    ["<@UBOT> please stop this", "stop this", false],
    ["<@UBOT> 😤 stop 🤖", "stop", true],
    ["<@UBOT> arrête", "arrête", false],
    ["<@UBOT> detente", "detente", false],
    ["<@UBOT> stopping", "stopping", false],
    ["<@UBOT> stop me", "stop me", false],
  ])("normalises %s", (input, expected, shouldMatch) => {
    expect(normalizeSlackStopCommand(input)).toBe(expected);
    expect(isSlackStopCommand(input)).toBe(shouldMatch);
  });
});
