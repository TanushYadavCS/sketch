import { describe, expect, it } from "vitest";
import { buildSketchContext, buildSystemContext, formatTimeAgo } from "./prompt";

describe("buildSystemContext", () => {
  describe("slack platform (DM)", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Alice",
      workspaceDir: "/data/workspaces/u123",
      orgDir: "/data/.claude",
      orgName: "Acme Corp",
      botName: "Sketch",
    });

    it("includes mrkdwn formatting rules", () => {
      expect(result).toContain("mrkdwn");
      expect(result).toContain("*bold*");
      expect(result).toContain("_italic_");
      expect(result).toContain("`code`");
      expect(result).toContain("<url|text>");
    });

    it("includes no-tables instruction", () => {
      expect(result).toContain("Do not use markdown tables");
    });

    it("includes workspace isolation section with the workspace path", () => {
      expect(result).toContain("Workspace Isolation");
      expect(result).toContain("/data/workspaces/u123");
    });

    it("includes file restriction rule", () => {
      expect(result).toContain("NEVER access files outside these two directories");
    });

    it("includes user name under User heading", () => {
      expect(result).toContain("## User");
      expect(result).toContain("Alice");
    });

    it("includes bot identity section when org/bot provided", () => {
      expect(result).toContain("## Bot Identity");
      expect(result).toContain("You are Sketch from Acme Corp.");
    });

    it("does not include channel context sections", () => {
      expect(result).not.toContain("Slack Channel #");
      expect(result).not.toContain("Sent by");
      expect(result).not.toContain("Recent Channel Messages");
    });
  });

  describe("whatsapp platform", () => {
    const result = buildSystemContext({
      platform: "whatsapp",
      userName: "Bob",
      workspaceDir: "/data/workspaces/u456",
      orgDir: "/data/.claude",
    });

    it("includes WhatsApp formatting rules", () => {
      expect(result).toContain("## Platform: WhatsApp");
      expect(result).toContain("*bold*");
      expect(result).toContain("_italic_");
      expect(result).toContain("~strikethrough~");
      expect(result).toContain("```monospace```");
    });

    it("does not include Slack-specific rules", () => {
      expect(result).not.toContain("mrkdwn");
      expect(result).not.toContain("<url|text>");
    });

    it("includes no-tables instruction", () => {
      expect(result).toContain("Do not use tables");
    });

    it("includes no-markdown-links instruction", () => {
      expect(result).toContain("Do not use markdown links");
      expect(result).toContain("write URLs inline");
    });

    it("includes workspace isolation section with the workspace path", () => {
      expect(result).toContain("Workspace Isolation");
      expect(result).toContain("/data/workspaces/u456");
    });

    it("includes file restriction rule", () => {
      expect(result).toContain("NEVER access files outside these two directories");
    });

    it("includes file attachments section", () => {
      expect(result).toContain("## File Attachments");
      expect(result).toContain("SendFileToChat");
    });

    it("includes user name under User heading", () => {
      expect(result).toContain("## User");
      expect(result).toContain("Bob");
    });
  });

  describe("channel context", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Carol",
      workspaceDir: "/data/workspaces/channel-C001",
      orgDir: "/data/.claude",
      channelContext: {
        channelName: "general",
      },
    });

    it("includes channel name", () => {
      expect(result).toContain("Slack Channel #general");
    });

    it("includes shared workspace note", () => {
      expect(result).toContain("Multiple users share this workspace");
    });

    it("does not include sender name in system prompt", () => {
      expect(result).not.toContain("## Sent by");
      expect(result).not.toContain("## User");
    });

    it("includes address-by-name instruction", () => {
      expect(result).toContain("Address the user who mentioned you by name");
    });

    it("still includes Slack formatting rules", () => {
      expect(result).toContain("mrkdwn");
    });

    it("still includes workspace isolation", () => {
      expect(result).toContain("Workspace Isolation");
      expect(result).toContain("/data/workspaces/channel-C001");
    });
  });

  describe("file attachments", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Eve",
      workspaceDir: "/data/workspaces/u789",
      orgDir: "/data/.claude",
    });

    it("includes file attachments section", () => {
      expect(result).toContain("## File Attachments");
    });

    it("mentions the attachments directory", () => {
      expect(result).toContain("attachments/");
    });

    it("mentions images shown directly", () => {
      expect(result).toContain("Images are shown directly");
    });

    it("mentions Read tool for non-image files", () => {
      expect(result).toContain("Read tool");
    });

    it("mentions SendFileToChat tool for sending files back", () => {
      expect(result).toContain("SendFileToChat");
    });
  });

  describe("memory", () => {
    it("includes memory section in DM context", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("## Memory");
      expect(result).toContain("Personal memory");
      expect(result).toContain("Org memory");
      expect(result).toContain("/data/.claude/CLAUDE.md");
    });

    it("includes concise writing instruction", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("single concise line");
      expect(result).toContain("topic headings");
    });

    it("does not include shared memory note in DM context", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).not.toContain("shared by all users");
    });

    it("includes shared memory note in channel context", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        channelContext: {
          channelName: "general",
        },
      });
      expect(result).toContain("shared by all users");
    });
  });

  describe("group context", () => {
    const result = buildSystemContext({
      platform: "whatsapp",
      userName: "Alice",
      workspaceDir: "/data/workspaces/wa-group-123",
      orgDir: "/data/.claude",
      groupContext: {
        groupName: "Engineering Team",
        groupDescription: "Daily standups and discussions",
      },
    });

    it("includes group name", () => {
      expect(result).toContain('WhatsApp Group "Engineering Team"');
    });

    it("includes group description", () => {
      expect(result).toContain("Group description: Daily standups and discussions");
    });

    it("includes shared workspace note", () => {
      expect(result).toContain("Multiple users share this workspace");
    });

    it("does not include sender name in system prompt", () => {
      expect(result).not.toContain("## Sent by");
      expect(result).not.toContain("## User");
    });

    it("includes address-by-name instruction", () => {
      expect(result).toContain("Address the user who mentioned you by name");
    });

    it("includes shared memory note", () => {
      expect(result).toContain("shared by all users");
    });

    it("includes WhatsApp formatting rules", () => {
      expect(result).toContain("## Platform: WhatsApp");
    });
  });

  describe("about sketch section", () => {
    it("is always present", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("## About Sketch");
      expect(result).toContain("managed by the admin");
    });
  });

  describe("context protocol section", () => {
    it("is always present", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("## Context Protocol");
    });

    it("mentions all context sub-tags", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("<context>");
      expect(result).toContain("<outreach>");
      expect(result).toContain("<thread>");
      expect(result).toContain("<sender>");
    });

    it("instructs agent never to mention context to users", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("Never mention <context>");
    });
  });

  describe("user email", () => {
    it("includes email when provided", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        userEmail: "alice@example.com",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("Email: alice@example.com");
    });

    it("shows 'not configured' when email is null", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        userEmail: null,
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("Email: not configured");
    });

    it("shows 'not configured' when email is omitted", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("Email: not configured");
    });

    it("does not include email in channel context", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        userEmail: "alice@example.com",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        channelContext: { channelName: "general" },
      });
      expect(result).not.toContain("Email:");
    });
  });

  describe("user phone", () => {
    it("includes phone when provided in DM context", () => {
      const result = buildSystemContext({
        platform: "whatsapp",
        userName: "Alice",
        userPhone: "+1234567890",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("Phone: +1234567890");
    });

    it("omits phone line when null (no noise for platforms without phone)", () => {
      const result = buildSystemContext({
        platform: "whatsapp",
        userName: "Alice",
        userPhone: null,
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).not.toContain("Phone:");
    });

    it("does not include phone in channel context", () => {
      const result = buildSystemContext({
        platform: "slack",
        userName: "Alice",
        userPhone: "+1234567890",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        channelContext: { channelName: "general" },
      });
      expect(result).not.toContain("Phone:");
    });

    it("does not include phone in group context", () => {
      const result = buildSystemContext({
        platform: "whatsapp",
        userName: "Alice",
        userPhone: "+1234567890",
        workspaceDir: "/data/workspaces/wa-group-123",
        orgDir: "/data/.claude",
        groupContext: { groupName: "Engineering Team" },
      });
      expect(result).not.toContain("Phone:");
    });

    it("phone and email coexist in DM context", () => {
      const result = buildSystemContext({
        platform: "whatsapp",
        userName: "Alice",
        userEmail: "alice@example.com",
        userPhone: "+1234567890",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("Email: alice@example.com");
      expect(result).toContain("Phone: +1234567890");
    });
  });

  describe("group context without description", () => {
    const result = buildSystemContext({
      platform: "whatsapp",
      userName: "Bob",
      workspaceDir: "/data/workspaces/wa-group-456",
      orgDir: "/data/.claude",
      groupContext: {
        groupName: "Casual Chat",
      },
    });

    it("includes group name", () => {
      expect(result).toContain('WhatsApp Group "Casual Chat"');
    });

    it("does not include group description line", () => {
      expect(result).not.toContain("Group description:");
    });
  });
});

describe("buildSketchContext", () => {
  it("returns plain message when no messages, no outreach, and DM context (isSharedContext=false)", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "what do you think?",
    });
    expect(result).toBe("what do you think?");
  });

  it("returns plain message when empty messages and isSharedContext not set", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "hello",
      currentUserEmail: "alice@example.com",
    });
    expect(result).toBe("hello");
  });

  it("wraps with context block when isSharedContext=true even with no thread messages", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "What do you think?",
      currentUserEmail: "alice@example.com",
      isSharedContext: true,
    });
    expect(result).toBe("<context>\n<sender>Alice (alice@example.com)</sender>\n</context>\n\nWhat do you think?");
  });

  it("includes sender name only when email is absent", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "message",
      isSharedContext: true,
    });
    expect(result).toBe("<context>\n<sender>Alice</sender>\n</context>\n\nmessage");
  });

  it("includes sender name only when email is null", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "message",
      currentUserEmail: null,
      isSharedContext: true,
    });
    expect(result).toBe("<context>\n<sender>Alice</sender>\n</context>\n\nmessage");
  });

  it("renders thread section when messages are provided", () => {
    const messages = [
      { userName: "Bob", text: "I like option A", ts: "1111.0001" },
      { userName: "Carol", text: "Me too", ts: "1111.0002" },
    ];
    const result = buildSketchContext({
      messages,
      currentUserName: "Alice",
      currentMessage: "what do you think?",
    });
    expect(result).toContain("<thread>");
    expect(result).toContain("Bob: I like option A");
    expect(result).toContain("Carol: Me too");
    expect(result).toContain("</thread>");
    expect(result).toContain("what do you think?");
  });

  it("prepends header inside thread section when provided", () => {
    const messages = [{ userName: "Bob", text: "hey there", ts: "1111.0001" }];
    const result = buildSketchContext({
      messages,
      currentUserName: "Alice",
      currentMessage: "hello",
      header: "[Thread context before you joined]",
    });
    expect(result).toContain("[Thread context before you joined]");
    const threadStart = result.indexOf("<thread>");
    const headerIdx = result.indexOf("[Thread context before you joined]");
    const msgIdx = result.indexOf("Bob: hey there");
    expect(headerIdx).toBeGreaterThan(threadStart);
    expect(headerIdx).toBeLessThan(msgIdx);
  });

  it("renders thread and sender in correct order when both are present", () => {
    const messages = [{ userName: "Bob", text: "hi", ts: "1111.0001" }];
    const result = buildSketchContext({
      messages,
      currentUserName: "Alice",
      currentMessage: "hello",
      currentUserEmail: "alice@example.com",
      isSharedContext: true,
    });
    const threadIdx = result.indexOf("<thread>");
    const senderIdx = result.indexOf("<sender>");
    expect(threadIdx).toBeLessThan(senderIdx);
    expect(result).toContain("<sender>Alice (alice@example.com)</sender>");
  });

  it("includes phone and email in sender tag when both provided", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "hello",
      currentUserEmail: "alice@example.com",
      currentUserPhone: "+1234567890",
      isSharedContext: true,
    });
    expect(result).toContain("<sender>Alice (+1234567890, alice@example.com)</sender>");
  });

  it("includes only phone in sender tag when email absent", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "hello",
      currentUserPhone: "+1234567890",
      isSharedContext: true,
    });
    expect(result).toContain("<sender>Alice (+1234567890)</sender>");
  });

  it("includes only email in sender tag when phone absent", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "hello",
      currentUserEmail: "alice@example.com",
      isSharedContext: true,
    });
    expect(result).toContain("<sender>Alice (alice@example.com)</sender>");
  });

  it("includes only name in sender tag when both phone and email absent", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "hello",
      isSharedContext: true,
    });
    expect(result).toContain("<sender>Alice</sender>");
  });

  it("includes attachment formatting inside thread section", () => {
    const messages = [
      {
        userName: "Bob",
        text: "here's the report",
        ts: "1111.0001",
        attachments: [
          {
            originalName: "report.pdf",
            mimeType: "application/pdf",
            localPath: "/ws/attachments/report.pdf",
            sizeBytes: 2048,
          },
        ],
      },
    ];
    const result = buildSketchContext({
      messages,
      currentUserName: "Alice",
      currentMessage: "looks good?",
    });
    expect(result).toContain("Bob: here's the report");
    expect(result).toContain("<attachments>");
    expect(result).toContain('name="report.pdf"');
    expect(result).toContain('path="/ws/attachments/report.pdf"');
    const attachIdx = result.indexOf("<attachments>");
    const msgIdx = result.indexOf("looks good?");
    expect(attachIdx).toBeLessThan(msgIdx);
  });

  it("preserves chronological message order", () => {
    const messages = [
      { userName: "Alice", text: "first", ts: "1111.0001" },
      { userName: "Bob", text: "second", ts: "1111.0002" },
      { userName: "Carol", text: "third", ts: "1111.0003" },
    ];
    const result = buildSketchContext({
      messages,
      currentUserName: "Dave",
      currentMessage: "fourth",
    });
    const firstIdx = result.indexOf("Alice: first");
    const secondIdx = result.indexOf("Bob: second");
    const thirdIdx = result.indexOf("Carol: third");
    const fourthIdx = result.indexOf("fourth");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
    expect(thirdIdx).toBeLessThan(fourthIdx);
  });

  it("current message appears after the closing context tag", () => {
    const messages = [{ userName: "Bob", text: "hey", ts: "1111.0001" }];
    const result = buildSketchContext({
      messages,
      currentUserName: "Alice",
      currentMessage: "hello",
      isSharedContext: true,
    });
    const contextCloseIdx = result.indexOf("</context>");
    const messageIdx = result.lastIndexOf("hello");
    expect(contextCloseIdx).toBeLessThan(messageIdx);
  });
});

describe("formatTimeAgo", () => {
  it("returns 'just now' for very recent timestamps (under 1 minute)", () => {
    const recent = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatTimeAgo(recent)).toBe("just now");
  });

  it("returns minutes ago for timestamps under 1 hour", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatTimeAgo(fiveMinAgo)).toBe("5m ago");
  });

  it("returns hours ago for timestamps under 1 day", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(twoHoursAgo)).toBe("2h ago");
  });

  it("returns days ago for timestamps over 1 day", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(threeDaysAgo)).toBe("3d ago");
  });

  it("returns '1m ago' for exactly 60 seconds ago", () => {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    expect(formatTimeAgo(oneMinAgo)).toBe("1m ago");
  });
});

describe("buildSketchContext with outreach", () => {
  const createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  it("renders <outreach> section with pendingOutreach", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Bob",
      currentMessage: "hello",
      isSharedContext: false,
      pendingOutreach: [
        {
          id: "o1",
          message: "What's the status?",
          taskContext: null,
          status: "pending",
          createdAt,
          requesterName: "Alice",
        },
      ],
    });
    expect(result).toContain("<outreach>");
    expect(result).toContain("[o1] from Alice");
    expect(result).toContain('"What\'s the status?"');
    expect(result).toContain("</outreach>");
  });

  it("includes taskContext as 'Context:' line when present", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Bob",
      currentMessage: "hello",
      isSharedContext: false,
      pendingOutreach: [
        {
          id: "o1",
          message: "Any updates?",
          taskContext: "Working on Q4 strategy",
          status: "pending",
          createdAt,
          requesterName: "Alice",
        },
      ],
    });
    expect(result).toContain("Context: Working on Q4 strategy");
  });

  it("renders responded outreach in outreachResponses", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "ok",
      isSharedContext: false,
      outreachResponses: [
        {
          id: "o1",
          message: "What's the budget?",
          taskContext: null,
          status: "responded",
          response: "Budget is $50k",
          createdAt,
          recipientName: "Bob",
        },
      ],
    });
    expect(result).toContain("Bob responded to your outreach:");
    expect(result).toContain('"Budget is $50k"');
  });

  it("renders pending (no response) outreach in outreachResponses", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "waiting",
      isSharedContext: false,
      outreachResponses: [
        {
          id: "o1",
          message: "Can you help?",
          taskContext: null,
          status: "pending",
          createdAt,
          recipientName: "Carol",
        },
      ],
    });
    expect(result).toContain("Carol has not responded");
    expect(result).toContain("sent");
  });

  it("renders outreach before thread and sender in correct order", () => {
    const result = buildSketchContext({
      messages: [{ userName: "Dave", text: "hi", ts: "1111.0001" }],
      currentUserName: "Alice",
      currentMessage: "hello",
      currentUserEmail: "alice@example.com",
      isSharedContext: true,
      pendingOutreach: [
        {
          id: "o1",
          message: "Question",
          taskContext: null,
          status: "pending",
          createdAt,
          requesterName: "Bob",
        },
      ],
    });
    const outreachIdx = result.indexOf("<outreach>");
    const threadIdx = result.indexOf("<thread>");
    const senderIdx = result.indexOf("<sender>");
    expect(outreachIdx).toBeGreaterThanOrEqual(0);
    expect(outreachIdx).toBeLessThan(threadIdx);
    expect(threadIdx).toBeLessThan(senderIdx);
  });

  it("returns plain message when both pendingOutreach and outreachResponses are empty", () => {
    const result = buildSketchContext({
      messages: [],
      currentUserName: "Alice",
      currentMessage: "hello",
      isSharedContext: false,
      pendingOutreach: [],
      outreachResponses: [],
    });
    expect(result).toBe("hello");
  });
});

describe("buildSystemContext Information Discovery section", () => {
  it("includes ## Information Discovery section", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Alice",
      workspaceDir: "/data/workspaces/u123",
      orgDir: "/data/.claude",
    });
    expect(result).toContain("## Information Discovery");
  });

  it("instructs to check workspace and org directory first, then reach out", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Alice",
      workspaceDir: "/data/workspaces/u123",
      orgDir: "/data/.claude",
    });
    expect(result).toContain("find it yourself first");
    expect(result).toContain("workspace files");
    expect(result).toContain("org directory (/data/.claude/)");
    expect(result).toContain("reach out to team members");
  });

  it("includes max 2 people limit", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Alice",
      workspaceDir: "/data/workspaces/u123",
      orgDir: "/data/.claude",
    });
    expect(result).toContain("max 2");
  });

  it("mentions follow-up scheduled task", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Alice",
      workspaceDir: "/data/workspaces/u123",
      orgDir: "/data/.claude",
    });
    expect(result).toContain("scheduled task to follow up");
  });

  it("marks failure to follow process as a failure", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Alice",
      workspaceDir: "/data/workspaces/u123",
      orgDir: "/data/.claude",
    });
    expect(result).toContain("considered a failure");
  });
});

describe("buildSystemContext workspace and org directory", () => {
  it("mentions ~/.claude/ as shared org directory in workspace isolation", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Alice",
      workspaceDir: "/data/workspaces/u123",
      orgDir: "/data/.claude",
    });
    expect(result).toContain("/data/.claude/ (the shared org directory)");
  });

  it("includes org directory line in memory section", () => {
    const result = buildSystemContext({
      platform: "slack",
      userName: "Alice",
      workspaceDir: "/data/workspaces/u123",
      orgDir: "/data/.claude",
    });
    expect(result).toContain("Org directory");
    expect(result).toContain("/data/.claude/ is the shared org workspace");
  });
});
