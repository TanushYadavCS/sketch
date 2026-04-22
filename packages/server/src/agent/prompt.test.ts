import { describe, expect, it } from "vitest";
import { buildSketchContext, buildSystemContext, formatTimeAgo } from "./prompt";

describe("buildSystemContext", () => {
  describe("identity variants", () => {
    it("uses botName + orgName identity line when both provided", () => {
      const result = buildSystemContext({
        platform: "slack",
        botName: "Atlas",
        orgName: "CanvasX AI",
      });
      expect(result).toContain(
        "You are Atlas, working for CanvasX AI. An intelligent agent powered by Sketch, created by Canvas AI.",
      );
    });

    it("uses botName-only identity line when orgName is absent", () => {
      const result = buildSystemContext({
        platform: "slack",
        botName: "Atlas",
      });
      expect(result).toContain("You are Atlas, an intelligent agent powered by Sketch, created by Canvas AI.");
      expect(result).not.toContain("working for");
    });

    it("uses botName-only identity line when orgName is null", () => {
      const result = buildSystemContext({
        platform: "slack",
        botName: "Atlas",
        orgName: null,
      });
      expect(result).toContain("You are Atlas, an intelligent agent powered by Sketch, created by Canvas AI.");
    });

    it("falls back to Sketch identity when neither botName nor orgName provided", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("You are Sketch, an intelligent agent created by Canvas AI.");
    });

    it("falls back to Sketch identity when both are null", () => {
      const result = buildSystemContext({
        platform: "slack",
        botName: null,
        orgName: null,
      });
      expect(result).toContain("You are Sketch, an intelligent agent created by Canvas AI.");
    });

    it("always includes teammate framing", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("member of the team");
    });

    it("always includes capability description", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("knowledgeable, direct, and action-oriented");
    });
  });

  describe("memory section", () => {
    it("includes memory section with persistent memory guidance", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("## Memory");
      expect(result).toContain("persistent memory across conversations");
    });

    it("mentions reducing future steering", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("reduces future steering");
    });

    it("instructs not to save task progress", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("Do NOT save task progress");
    });

    it("mentions org-level memory in shared org directory", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("shared org directory");
    });
  });

  describe("skills section", () => {
    it("includes skills section", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("## Skills");
    });

    it("mentions complex task threshold", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("complex task (5+ tool calls)");
    });

    it("instructs to patch outdated skills immediately", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("patch it immediately");
    });
  });

  describe("scheduled tasks section", () => {
    it("includes scheduled tasks section", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("## Scheduled Tasks");
    });

    it("mentions ManageScheduledTasks tool", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("ManageScheduledTasks tool");
    });
  });

  describe("file attachments section", () => {
    it("includes file attachments section", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("## File Attachments");
    });

    it("mentions attachments/ directory", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("attachments/");
    });

    it("mentions SendFileToChat tool", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("SendFileToChat");
    });
  });

  describe("context protocol section", () => {
    it("includes context protocol section", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("## Context Protocol");
    });

    it("mentions all new context tags", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("<time>");
      expect(result).toContain("<workspace>");
      expect(result).toContain("<inbox>");
      expect(result).toContain("<user>");
      expect(result).toContain("<sender>");
      expect(result).toContain("<channel>");
      expect(result).toContain("<group>");
      expect(result).toContain("<thread>");
      expect(result).toContain("<channel_history>");
      expect(result).toContain("<task>");
    });

    it("instructs agent never to mention context to users", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("Never mention <context>");
    });
  });

  describe("workspace rules", () => {
    it("includes generic workspace security rule", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("NEVER access files outside");
    });

    it("does not include specific workspace paths", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).not.toContain("/data/workspaces/");
      expect(result).not.toContain("/data/.claude");
    });
  });

  describe("Slack platform formatting", () => {
    it("includes mrkdwn formatting rules", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("mrkdwn");
      expect(result).toContain("*bold*");
      expect(result).toContain("_italic_");
      expect(result).toContain("`code`");
      expect(result).toContain("<url|text>");
    });

    it("instructs not to use markdown tables", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("Do not use markdown tables");
    });

    it("does not include WhatsApp-specific formatting", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).not.toContain("~strikethrough~");
      expect(result).not.toContain("mobile-first platform");
    });
  });

  describe("WhatsApp platform formatting", () => {
    it("includes WhatsApp formatting rules", () => {
      const result = buildSystemContext({ platform: "whatsapp" });
      expect(result).toContain("You are responding on WhatsApp");
      expect(result).toContain("*bold*");
      expect(result).toContain("_italic_");
      expect(result).toContain("~strikethrough~");
      expect(result).toContain("```monospace```");
    });

    it("instructs not to use tables", () => {
      const result = buildSystemContext({ platform: "whatsapp" });
      expect(result).toContain("Do not use tables");
    });

    it("instructs not to use markdown links", () => {
      const result = buildSystemContext({ platform: "whatsapp" });
      expect(result).toContain("Do not use markdown links");
      expect(result).toContain("write URLs inline");
    });

    it("does not include Slack-specific formatting", () => {
      const result = buildSystemContext({ platform: "whatsapp" });
      expect(result).not.toContain("mrkdwn");
      expect(result).not.toContain("<url|text>");
    });
  });

  describe("no per-user content", () => {
    it("does not contain user names or emails", () => {
      const result = buildSystemContext({
        platform: "slack",
        botName: "Atlas",
        orgName: "Acme",
      });
      expect(result).not.toContain("alice@example.com");
      expect(result).not.toContain("Name: ");
      expect(result).not.toContain("Email: ");
      expect(result).not.toContain("Phone: ");
    });

    it("does not contain workspace paths", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).not.toContain("/data/workspaces/u123");
    });
  });

  describe("removed sections", () => {
    it("does not contain About Sketch section", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).not.toContain("## About Sketch");
    });

    it("does not contain Information Discovery section by default", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).not.toContain("## Information Discovery");
    });

    it("does not contain Information Discovery section when experimentalFlag is false", () => {
      const result = buildSystemContext({ platform: "slack", experimentalFlag: false });
      expect(result).not.toContain("## Information Discovery");
    });
  });

  describe("Information Discovery (experimental)", () => {
    it("with indexed sources: includes the tool chain, dynamic source list, and integration nudge", () => {
      const result = buildSystemContext({
        platform: "slack",
        experimentalFlag: true,
        indexedSources: [
          { source: "fireflies", fileCount: 83 },
          { source: "google_drive", fileCount: 247 },
        ],
      });
      expect(result).toContain("## Information Discovery");
      expect(result).toContain("**Search**");
      expect(result).toContain("**GetFileContent**");
      expect(result).toContain("**SearchEntities**");
      expect(result).toContain("**GetEntityContext**");
      expect(result).toContain("Fireflies");
      expect(result).toContain("83");
      expect(result).toContain("Google Drive");
      expect(result).toContain("247");
      expect(result).toContain("Search → integration handoff");
      expect(result).toContain("providerId");
      expect(result).toContain("at most once per conversation");
    });

    it("empty state: no tool chain, just the conditional indexing nudge", () => {
      const result = buildSystemContext({ platform: "slack", experimentalFlag: true, indexedSources: [] });
      expect(result).toContain("## Information Discovery");
      expect(result).toContain("No organizational sources are indexed yet");
      expect(result).not.toContain("**Search**");
      expect(result).not.toContain("**GetFileContent**");
      expect(result).toContain("once per conversation");
    });

    it("defaults to empty state when indexedSources is omitted", () => {
      const result = buildSystemContext({ platform: "slack", experimentalFlag: true });
      expect(result).toContain("No organizational sources are indexed yet");
    });

    it("Information Discovery appears before Platform section", () => {
      const result = buildSystemContext({
        platform: "slack",
        experimentalFlag: true,
        indexedSources: [{ source: "fireflies", fileCount: 10 }],
      });
      const idIdx = result.indexOf("## Information Discovery");
      const platformIdx = result.indexOf("## Platform");
      expect(idIdx).toBeGreaterThanOrEqual(0);
      expect(platformIdx).toBeGreaterThan(idIdx);
    });

    it("does not contain Bot Identity section header", () => {
      const result = buildSystemContext({ platform: "slack", botName: "Atlas", orgName: "Acme" });
      expect(result).not.toContain("## Bot Identity");
    });

    it("does not contain old channel context guidance", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).not.toContain("Slack Channel #");
      expect(result).toContain("In shared channels and groups");
    });

    it("does not contain outreach tag in context protocol", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).not.toContain("<outreach>");
    });
  });

  describe("section order", () => {
    it("identity appears before memory", () => {
      const result = buildSystemContext({ platform: "slack", botName: "Atlas" });
      const identityIdx = result.indexOf("You are Atlas");
      const memoryIdx = result.indexOf("## Memory");
      expect(identityIdx).toBeGreaterThanOrEqual(0);
      expect(identityIdx).toBeLessThan(memoryIdx);
    });

    it("memory appears before skills", () => {
      const result = buildSystemContext({ platform: "slack" });
      const memoryIdx = result.indexOf("## Memory");
      const skillsIdx = result.indexOf("## Skills");
      expect(memoryIdx).toBeLessThan(skillsIdx);
    });

    it("skills appears before scheduled tasks", () => {
      const result = buildSystemContext({ platform: "slack" });
      const skillsIdx = result.indexOf("## Skills");
      const scheduledTasksIdx = result.indexOf("## Scheduled Tasks");
      expect(skillsIdx).toBeLessThan(scheduledTasksIdx);
    });

    it("scheduled tasks appears before file attachments", () => {
      const result = buildSystemContext({ platform: "slack" });
      const scheduledTasksIdx = result.indexOf("## Scheduled Tasks");
      const fileAttachmentsIdx = result.indexOf("## File Attachments");
      expect(scheduledTasksIdx).toBeLessThan(fileAttachmentsIdx);
    });

    it("file attachments appears before context protocol", () => {
      const result = buildSystemContext({ platform: "slack" });
      const fileAttachmentsIdx = result.indexOf("## File Attachments");
      const contextProtocolIdx = result.indexOf("## Context Protocol");
      expect(fileAttachmentsIdx).toBeLessThan(contextProtocolIdx);
    });

    it("context protocol appears before workspace rules", () => {
      const result = buildSystemContext({ platform: "slack" });
      const contextProtocolIdx = result.indexOf("## Context Protocol");
      const workspaceIdx = result.indexOf("NEVER access files outside");
      expect(contextProtocolIdx).toBeLessThan(workspaceIdx);
    });

    it("workspace rules appear before platform formatting", () => {
      const result = buildSystemContext({ platform: "slack" });
      const workspaceIdx = result.indexOf("NEVER access files outside");
      const platformIdx = result.indexOf("You are responding on Slack");
      expect(workspaceIdx).toBeLessThan(platformIdx);
    });
  });
});

describe("buildSketchContext", () => {
  describe("<time> tag", () => {
    it("always includes time tag with formatted datetime and timezone", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        timezone: "Asia/Kolkata",
      });
      expect(result).toContain("<time>");
      expect(result).toContain("</time>");
      expect(result).toContain("GMT+5:30");
      expect(result).toContain("Asia/Kolkata");
    });

    it("includes UTC when timezone is null", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        timezone: null,
      });
      expect(result).toContain("<time>");
      expect(result).toContain("UTC");
    });

    it("includes UTC when timezone is omitted", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("<time>");
      expect(result).toContain("UTC");
    });

    it("includes day of week, date, and year in time tag", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        timezone: "UTC",
      });
      expect(result).toMatch(/<time>[\s\S]*\d{4}[\s\S]*<\/time>/);
    });
  });

  describe("<workspace> tag", () => {
    it("always includes workspace tag with workspace and org paths", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("<workspace>");
      expect(result).toContain("/data/workspaces/u123");
      expect(result).toContain("/data/.claude");
      expect(result).toContain("</workspace>");
    });
  });

  describe("<user> tag for DMs", () => {
    it("produces user tag for DM context (isSharedContext false)", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        currentUserEmail: "alice@example.com",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        isSharedContext: false,
      });
      expect(result).toContain("<user>");
      expect(result).toContain("Alice");
      expect(result).toContain("alice@example.com");
      expect(result).toContain("</user>");
    });

    it("produces user tag when isSharedContext is omitted", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        currentUserEmail: "alice@example.com",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("<user>");
      expect(result).not.toContain("<sender>");
    });

    it("includes name, email, and phone in user tag when all provided", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        currentUserEmail: "alice@example.com",
        currentUserPhone: "+1234567890",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        isSharedContext: false,
      });
      expect(result).toContain("<user>");
      expect(result).toContain("Alice");
      expect(result).toContain("alice@example.com");
      expect(result).toContain("+1234567890");
    });
  });

  describe("<sender> tag for shared contexts", () => {
    it("produces sender tag when isSharedContext is true", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        currentUserEmail: "alice@example.com",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        isSharedContext: true,
      });
      expect(result).toContain("<sender>");
      expect(result).toContain("Alice");
      expect(result).toContain("alice@example.com");
      expect(result).toContain("</sender>");
      expect(result).not.toContain("<user>");
    });

    it("sender tag contains name only when no email", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        isSharedContext: true,
      });
      expect(result).toContain("<sender>Alice</sender>");
    });

    it("sender tag includes phone when provided", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        currentUserPhone: "+1234567890",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        isSharedContext: true,
      });
      expect(result).toContain("+1234567890");
    });
  });

  describe("<thread> tag variants", () => {
    it("wraps messages in <thread> by default when no threadTag specified", () => {
      const messages = [{ userName: "Bob", text: "hello there", ts: "1111.0001" }];
      const result = buildSketchContext({
        messages,
        currentUserName: "Alice",
        currentMessage: "hey",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("<thread>");
      expect(result).toContain("Bob: hello there");
      expect(result).toContain("</thread>");
    });

    it("wraps messages in <thread> when threadTag is 'thread'", () => {
      const messages = [{ userName: "Bob", text: "hello there", ts: "1111.0001" }];
      const result = buildSketchContext({
        messages,
        currentUserName: "Alice",
        currentMessage: "hey",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        threadTag: "thread",
      });
      expect(result).toContain("<thread>");
      expect(result).not.toContain("<channel_history>");
    });

    it("wraps messages in <channel_history> when threadTag is 'channel_history'", () => {
      const messages = [{ userName: "Bob", text: "a message", ts: "1111.0001" }];
      const result = buildSketchContext({
        messages,
        currentUserName: "Alice",
        currentMessage: "hey",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        isSharedContext: true,
        threadTag: "channel_history",
      });
      expect(result).toContain("<channel_history>");
      expect(result).toContain("Bob: a message");
      expect(result).toContain("</channel_history>");
      expect(result).not.toContain("<thread>");
    });

    it("uses <thread> for bootstrap thread history", () => {
      const messages = [{ userName: "Bob", text: "a message", ts: "1111.0001" }];
      const result = buildSketchContext({
        messages,
        currentUserName: "Alice",
        currentMessage: "hey",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        isSharedContext: true,
        threadTag: "thread",
      });
      expect(result).toContain("<thread>");
      expect(result).toContain("Bob: a message");
      expect(result).toContain("</thread>");
    });

    it("does not include header text inside thread tags", () => {
      const messages = [{ userName: "Bob", text: "hey", ts: "1111.0001" }];
      const result = buildSketchContext({
        messages,
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        threadTag: "thread",
      });
      const threadStart = result.indexOf("<thread>");
      const threadEnd = result.indexOf("</thread>");
      const innerContent = result.slice(threadStart, threadEnd);
      expect(innerContent).not.toContain("[Thread context before you joined]");
      expect(innerContent).not.toContain("Thread context");
    });

    it("omits thread tag entirely when no messages", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).not.toContain("<thread>");
      expect(result).not.toContain("<channel_history>");
    });
  });

  describe("<inbox> tag", () => {
    it("renders inbox items with sender name, relative time, and original message", () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        inboxMessages: [
          { id: "inbox-1", senderName: "Bob", message: "Please send the latest update.", createdAt: tenMinutesAgo },
        ],
      });

      expect(result).toContain("<inbox>");
      expect(result).toContain("From Bob, 10m ago:");
      expect(result).toContain("Please send the latest update.");
      expect(result).toContain("</inbox>");
    });

    it("renders workflow inbox items with explicit fields", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        inboxMessages: [
          {
            id: "inbox-1",
            senderName: "System",
            message: "Fallback message",
            createdAt: new Date().toISOString(),
            kind: "managed_onboarding_intro",
            metadata: {
              stage: "awaiting_recipients",
              source: "managed_slack_onboarding",
              originalMessage: "Who should I introduce myself to first?",
              instructions: ["Resolve names", "Ask for confirmation"],
              selectedNames: [],
              draftMessage: null,
            },
          },
        ],
      });

      expect(result).toContain("Type: managed_onboarding_intro");
      expect(result).toContain("InboxMessageId: inbox-1");
      expect(result).toContain("Status: awaiting_recipients");
      expect(result).toContain("Source: managed_slack_onboarding");
      expect(result).toContain("Original message:");
      expect(result).toContain("Who should I introduce myself to first?");
      expect(result).toContain("- Resolve names");
      expect(result).toContain("Selected recipient user ids:");
      expect(result).toContain("None yet");
      expect(result).toContain("Selected recipients:");
      expect(result).toContain("Draft message:");
    });

    it("omits inbox tag when there are no inbox messages", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });

      expect(result).not.toContain("<inbox>");
    });
  });

  describe("<channel> and <group> tags", () => {
    it("renders channel metadata in shared Slack contexts", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        currentUserEmail: "alice@example.com",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        isSharedContext: true,
        channelContext: { channelName: "general" },
      });

      expect(result).toContain("<channel>");
      expect(result).toContain("name: #general");
      expect(result).toContain("</channel>");
    });

    it("renders group metadata in shared WhatsApp contexts", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        currentUserPhone: "+1234567890",
        workspaceDir: "/data/workspaces/wa-group-g1",
        orgDir: "/data/.claude",
        isSharedContext: true,
        groupContext: { groupName: "Leadership", groupDescription: "Weekly updates" },
      });

      expect(result).toContain("<group>");
      expect(result).toContain("name: Leadership");
      expect(result).toContain("description: Weekly updates");
      expect(result).toContain("</group>");
    });
  });

  describe("<task> tag", () => {
    it("produces task tag when taskPrompt is provided", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "Send daily summary",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        taskPrompt: "Send daily summary",
      });
      expect(result).toContain("<task>");
      expect(result).toContain("Send daily summary");
      expect(result).toContain("</task>");
    });

    it("does not produce task tag when taskPrompt is absent", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).not.toContain("<task>");
    });
  });

  describe("no outreach section", () => {
    it("does not produce outreach section", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).not.toContain("<outreach>");
    });
  });

  describe("context block structure", () => {
    it("always produces context block (time and workspace are always present)", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("<context>");
      expect(result).toContain("</context>");
    });

    it("current message appears after closing context tag", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "hello world",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      const contextCloseIdx = result.indexOf("</context>");
      const messageIdx = result.lastIndexOf("hello world");
      expect(contextCloseIdx).toBeLessThan(messageIdx);
    });

    it("context sections appear in order: time, workspace, user, thread, task", () => {
      const messages = [{ userName: "Bob", text: "hi", ts: "1111.0001" }];
      const result = buildSketchContext({
        messages,
        currentUserName: "Alice",
        currentMessage: "what's up?",
        currentUserEmail: "alice@example.com",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        taskPrompt: "Do the thing",
      });
      const timeIdx = result.indexOf("<time>");
      const workspaceIdx = result.indexOf("<workspace>");
      const userIdx = result.indexOf("<user>");
      const threadIdx = result.indexOf("<thread>");
      const taskIdx = result.indexOf("<task>");
      expect(timeIdx).toBeLessThan(workspaceIdx);
      expect(workspaceIdx).toBeLessThan(userIdx);
      expect(userIdx).toBeLessThan(threadIdx);
      expect(threadIdx).toBeLessThan(taskIdx);
    });

    it("context sections appear in order for shared context: time, workspace, sender, channel, channel_history", () => {
      const messages = [{ userName: "Dave", text: "hi", ts: "1111.0001" }];
      const result = buildSketchContext({
        messages,
        currentUserName: "Alice",
        currentMessage: "hello",
        currentUserEmail: "alice@example.com",
        workspaceDir: "/data/workspaces/channel-C001",
        orgDir: "/data/.claude",
        isSharedContext: true,
        threadTag: "channel_history",
        channelContext: { channelName: "general" },
      });
      const timeIdx = result.indexOf("<time>");
      const workspaceIdx = result.indexOf("<workspace>");
      const senderIdx = result.indexOf("<sender>");
      const channelIdx = result.indexOf("<channel>");
      const channelHistoryIdx = result.indexOf("<channel_history>");
      expect(timeIdx).toBeLessThan(workspaceIdx);
      expect(workspaceIdx).toBeLessThan(senderIdx);
      expect(senderIdx).toBeLessThan(channelIdx);
      expect(channelIdx).toBeLessThan(channelHistoryIdx);
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
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      const firstIdx = result.indexOf("Alice: first");
      const secondIdx = result.indexOf("Bob: second");
      const thirdIdx = result.indexOf("Carol: third");
      const fourthIdx = result.indexOf("fourth");
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
      expect(thirdIdx).toBeLessThan(fourthIdx);
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
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
      });
      expect(result).toContain("Bob: here's the report");
      expect(result).toContain("<attachments>");
      expect(result).toContain('name="report.pdf"');
      expect(result).toContain('path="/ws/attachments/report.pdf"');
    });
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
