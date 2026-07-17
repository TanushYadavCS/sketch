import { describe, expect, it } from "vitest";
import { sidebarDefaultOpen } from "./dashboard";

describe("sidebarDefaultOpen", () => {
  it("restores a collapsed sidebar from its cookie", () => {
    expect(sidebarDefaultOpen("theme=dark; sidebar_state=false; session=abc")).toBe(false);
  });

  it("keeps the sidebar open when its cookie is true or absent", () => {
    expect(sidebarDefaultOpen("sidebar_state=true")).toBe(true);
    expect(sidebarDefaultOpen("theme=dark")).toBe(true);
  });
});
