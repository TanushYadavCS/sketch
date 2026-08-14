import { describe, expect, it } from "vitest";
import {
  buildAutomationMessageDeliveryLines,
  buildSketchContext,
  buildSystemContext,
  formatTimeAgo,
  getImageAttachmentPathsFromSketchContext,
} from "./prompt";

describe("buildAutomationMessageDeliveryLines", () => {
  it("provides Slack-safe human-readable delivery rules", () => {
    const result = buildAutomationMessageDeliveryLines("slack").join("\n");

    expect(result).toContain("human-readable message body as plain text");
    expect(result).toContain("JSON.stringify output");
    expect(result).toContain("short headings and bullet lists");
    expect(result).toContain("relevant time window");
    expect(result).toContain("Slack mrkdwn");
  });

  it("provides WhatsApp-safe link rules", () => {
    expect(buildAutomationMessageDeliveryLines("whatsapp").join("\n")).toContain("write URLs inline");
  });
});

describe("buildSystemContext", () => {
  describe("agent instructions overlay", () => {
    it("does not add an Agent Instructions section when not provided", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).not.toContain("## Agent Instructions");
    });

    it("does not add an Agent Instructions section for whitespace-only instructions", () => {
      const result = buildSystemContext({ platform: "slack", agentInstructions: "   \n  " });
      expect(result).not.toContain("## Agent Instructions");
    });

    it("appends agent instructions after platform formatting when provided", () => {
      const result = buildSystemContext({
        platform: "slack",
        agentInstructions: "You are the marketing maven. Always cite source URLs.",
      });
      expect(result).toContain("## Agent Instructions");
      expect(result).toContain("You are the marketing maven. Always cite source URLs.");

      const platformIdx = result.indexOf("## Platform");
      const agentIdx = result.indexOf("## Agent Instructions");
      expect(platformIdx).toBeGreaterThan(-1);
      expect(agentIdx).toBeGreaterThan(platformIdx);
    });
  });

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

    it("appends the org description when provided, and omits the line otherwise", () => {
      const withDescription = buildSystemContext({
        platform: "slack",
        botName: "Atlas",
        orgName: "Canvas Labs",
        orgDescription: "AI services company. Sketch is one of our products.",
      });
      expect(withDescription).toContain("About Canvas Labs: AI services company. Sketch is one of our products.");

      const without = buildSystemContext({
        platform: "slack",
        botName: "Atlas",
        orgName: "Canvas Labs",
      });
      expect(without).not.toContain("About Canvas Labs");
    });
  });

  describe("memory section", () => {
    it("includes memory section without encouraging unsupported memory claims", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("## Memory");
      expect(result).not.toContain("You have persistent memory across conversations");
      expect(result).toContain("Do not claim to remember past conversations unless");
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

  describe("chat history section", () => {
    it("distinguishes chronological reads from chat-history search", () => {
      const result = buildSystemContext({ platform: "slack" });

      expect(result).toContain("## Chat History");
      expect(result).toContain("Use ReadChatHistory for chronological paging");
      expect(result).toContain("Use SearchChatHistory to find relevant stored chat messages");
      expect(result).toContain("must call SearchChatHistory first");
      expect(result).toContain('scope: "current_thread"');
      expect(result).toContain('scope: "conversation"');
      expect(result).toContain('scope: "all_chats"');
      expect(result).toContain('"all_chats" works in any context, including shared channels and groups');
      expect(result).toContain("does not replace the existing Search tool");
      expect(result).toContain("call ReadChatHistory with the returned conversation ref and anchor message id");
      expect(result).toContain("Never infer from an empty result that matching messages were never persisted");
      expect(result).not.toContain("WhatsAppGroupHistory");
      expect(result).not.toContain("SlackChannelHistory");
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

    it("tells scheduled tasks to return final text instead of sending chat messages", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("Sketch will automatically deliver your returned text");
      expect(result).toContain("do not try to find or use a chat-sending tool");
    });

    it("tells reminder automations to use durable follow-up state before chat history", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("must call ListFollowups first");
      expect(result).toContain("durable follow-up state is authoritative");
    });

    it("uses the same plain-language execution mode names as the builder", () => {
      const result = buildSystemContext({ platform: "slack" });

      expect(result).toContain("Deterministic is code-only with no agent");
      expect(result).toContain("Hybrid combines code and agent steps");
      expect(result).toContain("Agent is agent-only");
      expect(result).toContain("with Deterministic, Hybrid, and Agent as the choices");
    });

    it("prefers deterministic action steps for fixed automation work", () => {
      const result = buildSystemContext({ platform: "slack" });

      expect(result).toContain("Prefer explicit workflow steps for deterministic automations");
      expect(result).toContain("mapping fields, filtering records, normalizing data, calculations");
      expect(result).toContain("bounded JSON transformations");
      expect(result).toContain("action steps with script content");
      expect(result).toContain("legacy shorthand creates an agent step");
      expect(result).toContain("only when the workflow needs interpretation, classification, planning, summarization");
      expect(result).toContain("Operational actions remain deterministic");
    });

    it("routes semantic authoring through natural-language ManageScheduledTasks requests when configured", () => {
      const result = buildSystemContext({ platform: "slack", automationAuthoringEnabled: true });

      expect(result).toContain("use only the admitted schedule, webhook, or Slack channel-message trigger types");
      expect(result).toContain("Do not invent a Canvas-managed app trigger or component key");
      expect(result).toContain("if polling versus a native event is unclear, ask the user to choose");
      expect(result).not.toContain("prefer a Canvas-managed trigger only when a Canvas skill/MCP is available");
      expect(result).toContain("pass the user's requested change as a natural-language request");
      expect(result).toContain("Do not construct or pass automation definition fields");
      expect(result).toContain("Never use updateStepContent");
      expect(result).toContain("list, pause, resume, run, delete, and inspect run history");
      expect(result).toContain("include the resolved target ID and label in the natural-language");
      expect(result).toContain("call SearchDeliveryTargets with platform='slack' and targetType='channel' first");
      expect(result).toContain("never invent a channel ID");
    });

    it("guides legacy structured authoring to Sketch-native webhooks", () => {
      const result = buildSystemContext({ platform: "slack" });

      expect(result).toContain("use Sketch's native webhook trigger");
      expect(result).toContain("schedule_type='external'");
      expect(result).toContain("schedule_value='webhook'");
      expect(result).toContain("Never use the Canvas componentKey='webhook-trigger'");
      expect(result).not.toContain("prefer a Canvas-managed trigger only when a Canvas skill/MCP is available");
      expect(result).not.toContain("use only the admitted schedule, webhook, or Slack channel-message trigger types");
      expect(result).not.toContain("Do not construct or pass automation definition fields");
      expect(result).not.toContain("Never use updateStepContent");
      expect(result).toContain("pass the resolved target ID in ManageScheduledTasks delivery");
      expect(result).toContain("Operational actions remain deterministic");
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

    it("keeps audio attachment guidance stable", () => {
      expect(buildSystemContext({ platform: "slack" })).toContain(
        "If no transcript is provided and a TranscribeAudio tool is available",
      );
    });

    it("does not mention VisualAnalysis when vision analysis is unavailable", () => {
      expect(buildSystemContext({ platform: "slack" })).not.toContain("VisualAnalysis");
    });

    it("mentions VisualAnalysis when vision analysis is available", () => {
      const result = buildSystemContext({ platform: "slack", visionAnalysisEnabled: true });
      expect(result).toContain("VisualAnalysis");
      expect(result).toContain("visual tasks");
      expect(result).toContain("OCR");
      expect(result).not.toContain("Image and GIF files");
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

  describe("web chat platform formatting", () => {
    it("includes GitHub-flavored Markdown rules", () => {
      const result = buildSystemContext({ platform: "web" });
      expect(result).toContain("Sketch web chat");
      expect(result).toContain("GitHub-flavored Markdown");
      expect(result).toContain("[descriptive link text](url)");
      expect(result).toContain("fenced code blocks");
    });

    it("teaches web agents to ask bounded choice questions", () => {
      const result = buildSystemContext({ platform: "web" });
      expect(result).toContain("use AskUserQuestion with two to four concrete options");
      expect(result).toContain("stop after the tool call");
    });

    it("routes web automation authoring into the builder", () => {
      const result = buildSystemContext({ platform: "web", automationAuthoringEnabled: true });

      expect(result).toContain("route automation work instead of authoring it");
      expect(result).toContain("call action 'open' with that task_id");
      expect(result).toContain("The builder conversation owns all setup questions and edits");
      expect(result).not.toContain("Create or update the automation directly with ManageScheduledTasks");
    });

    it("tells the agent to resolve integration status without UI-render side effects", () => {
      const result = buildSystemContext({ platform: "web" });
      expect(result).toContain("use the integration search-apps capability");
      expect(result).toContain("Call search-apps without queries when the user asks what integration accounts");
      expect(result).toContain("Never ask whether to show, pull up, open, or display a connection card");
      expect(result).toContain("Should I pull up the connection card?");
      expect(result).toContain("I can pull up the right card");
      expect(result).toContain("Which Zoho product should I use?");
      expect(result).toContain("do not give manual navigation, API-key, or 'look for this app' setup instructions");
      expect(result).toContain("Do not include a separate 'connect these apps' section");
      expect(result).toContain("Do not send users to Settings -> Integrations unless no setup card/link");
      expect(result).toContain("Do not tell the user how to use the setup card/link");
      expect(result).toContain("Do not describe card or link rendering mechanics");
      expect(result).toContain("it will add an app-specific setup option automatically");
      expect(result).toContain("do not mention that rendering step");
      expect(result).not.toContain("SearchIntegrationApps");
      expect(result).not.toContain("RequestIntegrationConnection");
    });

    it("includes connection-link guidance for Slack and WhatsApp", () => {
      const slack = buildSystemContext({ platform: "slack" });
      const whatsapp = buildSystemContext({ platform: "whatsapp" });

      expect(slack).toContain("use the integration search-apps capability");
      expect(slack).toContain("Sketch will resolve the returned app identity into the right connection target");
      expect(slack).toContain("Do not send users to Settings -> Integrations unless no setup card/link");
      expect(slack).toContain("Do not tell the user how to use the setup card/link");
      expect(whatsapp).toContain("Do not tell the user how to use the setup card/link");
      expect(whatsapp).toContain("Do not include a separate 'connect these apps' section");
      expect(whatsapp).not.toContain("RequestIntegrationConnection");
    });

    it("does not include Slack or WhatsApp link formatting", () => {
      const result = buildSystemContext({ platform: "web" });
      expect(result).not.toContain("<url|text>");
      expect(result).not.toContain("write URLs inline");
    });

    it("uses plain-language automation link guidance", () => {
      const result = buildSystemContext({ platform: "web" });
      expect(result).toContain("automation link");
      expect(result).toContain("ManageScheduledTasks with action 'share'");
      expect(result).not.toContain("builder URL");
    });

    it("can mention delivery context without overriding web reply formatting", () => {
      const result = buildSystemContext({ platform: "web", deliveryPlatform: "slack" });
      expect(result).toContain("visible reply is rendered in web chat");
      expect(result).toContain("must use web Markdown formatting");
      expect(result).toContain("slack delivery context");
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
  });

  describe("Information Discovery", () => {
    it("with indexed sources: includes the tool chain, dynamic source list, and integration nudge", () => {
      const result = buildSystemContext({
        platform: "slack",
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
      const result = buildSystemContext({ platform: "slack", indexedSources: [] });
      expect(result).toContain("## Information Discovery");
      expect(result).toContain("No organizational sources are indexed yet");
      expect(result).not.toContain("**Search**");
      expect(result).not.toContain("**GetFileContent**");
      expect(result).toContain("once per conversation");
    });

    it("defaults to empty state when indexedSources is omitted", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("No organizational sources are indexed yet");
    });

    it("Information Discovery appears before Platform section", () => {
      const result = buildSystemContext({
        platform: "slack",
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

    it("documents local Claude session event context", () => {
      const result = buildSystemContext({ platform: "slack" });
      expect(result).toContain("<local_claude_session_event>");
      expect(result).toContain("Capture the session pane before acting");
      expect(result).toContain("Any final response you write is visible to the user");
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

  describe("<local_claude_session_event> tag", () => {
    it("renders local Claude Code hook events as internal context", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "Handle the local Claude Code event.",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        localClaudeSessionEvent: {
          sessionId: "session-1",
          eventId: "event-1",
          eventType: "Stop",
          status: "completed_turn",
          message: "Claude Code completed a turn.",
          payload: { last_assistant_message: "Done" },
        },
      });

      expect(result).toContain("<local_claude_session_event>");
      expect(result).toContain("It is internal context, not a user message");
      expect(result).toContain("sessionId: session-1");
      expect(result).toContain("eventId: event-1");
      expect(result).toContain("eventType: Stop");
      expect(result).toContain('"last_assistant_message": "Done"');
      expect(result).toContain("</local_claude_session_event>");
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

    it("renders persisted conversation backlog inside the thread section", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "what did I miss?",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        conversationBacklog: {
          afterMessageId: 10,
          beforeMessageId: 13,
          hasMore: false,
          messages: [
            {
              id: 11,
              senderName: "Bob",
              text: "first missed message",
              attachments: [],
              providerTimestamp: "2026-01-01T00:00:00.000Z",
              receivedAt: "2026-01-01T00:00:01.000Z",
            },
            {
              id: 12,
              senderName: "Carol",
              text: "",
              attachments: [
                {
                  originalName: "note.txt",
                  mimeType: "text/plain",
                  localPath: "/ws/attachments/note.txt",
                  sizeBytes: 12,
                },
              ],
              providerTimestamp: null,
              receivedAt: "2026-01-01T00:00:02.000Z",
            },
          ],
        },
      });

      expect(result).toContain("Missed chat messages are shown below using durable row ids.");
      expect(result).toContain("Bob [messageId=11]: first missed message");
      expect(result).toContain("Carol [messageId=12]: See attached files.");
      expect(result).toContain('path="/ws/attachments/note.txt"');
    });

    it("adds vision hints and collects image paths from backlog attachments", () => {
      const sketchContext = {
        messages: [],
        currentUserName: "Alice",
        currentMessage: "what did I miss?",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        visionAnalysisEnabled: true,
        conversationBacklog: {
          afterMessageId: 10,
          beforeMessageId: 12,
          hasMore: false,
          messages: [
            {
              id: 11,
              senderName: "Carol",
              text: "",
              attachments: [
                {
                  originalName: "photo.jpg",
                  mimeType: "image/jpeg",
                  localPath: "/ws/attachments/photo.jpg",
                  sizeBytes: 120,
                },
              ],
              providerTimestamp: null,
              receivedAt: "2026-01-01T00:00:02.000Z",
            },
          ],
        },
      };

      const result = buildSketchContext(sketchContext);

      expect(result).toContain('hint="Use mcp__sketch__VisualAnalysis with this path to understand the image."');
      expect(getImageAttachmentPathsFromSketchContext(sketchContext)).toEqual(["/ws/attachments/photo.jpg"]);
    });

    it("renders quoted WhatsApp message context separately from missed backlog", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "please create this ticket",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        quotedMessage: {
          id: 42,
          providerMessageId: "wa-parent-1",
          senderName: "Bob",
          senderJid: "111@s.whatsapp.net",
          text: "Checkout keeps failing for paid members",
          attachments: [],
          providerTimestamp: "2026-01-01T00:00:00.000Z",
          receivedAt: "2026-01-01T00:00:01.000Z",
        },
      });

      expect(result).toContain("<quoted_message>");
      expect(result).toContain("The current message is a WhatsApp reply to this quoted message.");
      expect(result).toContain("sender: Bob");
      expect(result).not.toContain("111@s.whatsapp.net");
      expect(result).not.toContain("messageId=42");
      expect(result).not.toContain("providerMessageId: wa-parent-1");
      expect(result).toContain("text: Checkout keeps failing for paid members");
    });

    it("collects image paths from quoted WhatsApp message attachments", () => {
      const sketchContext = {
        messages: [],
        currentUserName: "Alice",
        currentMessage: "please create a ticket for this",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        quotedMessage: {
          providerMessageId: "wa-parent-1",
          senderName: "Bob",
          text: "",
          attachments: [
            {
              originalName: "screenshot.jpg",
              mimeType: "image/jpeg",
              localPath: "/ws/attachments/screenshot.jpg",
              sizeBytes: 120,
            },
          ],
        },
      };

      const result = buildSketchContext(sketchContext);

      expect(result).toContain("text: See attached files.");
      expect(result).toContain('path="/ws/attachments/screenshot.jpg"');
      expect(getImageAttachmentPathsFromSketchContext(sketchContext)).toEqual(["/ws/attachments/screenshot.jpg"]);
    });

    it("tells the agent how to continue when backlog is truncated", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "summarize",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        conversationBacklog: {
          afterMessageId: null,
          beforeMessageId: 50,
          hasMore: true,
          nextCursor: 25,
          messages: [],
        },
      });

      expect(result).toContain("<thread>");
      expect(result).toContain("after messageId 0 and before the current messageId 50");
      expect(result).toContain(
        "If the user asks for a targeted keyword, topic, decision, person, project, or phrase lookup, you must call SearchChatHistory first instead of paging sequentially.",
      );
      expect(result).toContain("Only the newest 0 missed messages are inlined.");
      expect(result).toContain(
        "For the omitted older messages, use ReadChatHistory with beforeMessageId 25, and includeBotMessages false.",
      );
      expect(result).not.toContain("ReadChatHistory with afterMessageId 0");
    });

    it("preserves an existing lower bound when continuing a truncated backlog", () => {
      const result = buildSketchContext({
        messages: [],
        currentUserName: "Alice",
        currentMessage: "summarize",
        workspaceDir: "/data/workspaces/u123",
        orgDir: "/data/.claude",
        conversationBacklog: {
          afterMessageId: 10,
          beforeMessageId: 50,
          hasMore: true,
          nextCursor: 25,
          messages: [],
        },
      });

      expect(result).toContain(
        "For the omitted older messages, use ReadChatHistory with afterMessageId 10, beforeMessageId 25, and includeBotMessages false.",
      );
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
