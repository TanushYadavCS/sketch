import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatInput } from "./chat-input";

describe("ChatInput", () => {
  it("hides inactive attachment and add-context affordances", () => {
    render(<ChatInput onSubmit={() => undefined} />);

    expect(screen.queryByLabelText("Attach a file")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add context")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });
});
