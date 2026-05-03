export function generateSlackManifest(botName = "Sketch"): string {
  const name = botName.trim() || "Sketch";

  return JSON.stringify(
    {
      display_information: { name },
      features: {
        app_home: {
          home_tab_enabled: true,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: name, always_online: true },
        assistant_view: {
          assistant_description: "Your AI assistant for the org",
        },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "assistant:write",
            "channels:history",
            "channels:read",
            "chat:write",
            "files:read",
            "files:write",
            "groups:history",
            "groups:read",
            "im:history",
            "im:read",
            "im:write",
            "mpim:history",
            "mpim:read",
            "reactions:read",
            "reactions:write",
            "team:read",
            "users:read",
            "users:read.email",
          ],
        },
        pkce_enabled: false,
      },
      settings: {
        event_subscriptions: {
          bot_events: [
            "app_mention",
            "app_home_opened",
            "assistant_thread_context_changed",
            "assistant_thread_started",
            "message.channels",
            "message.groups",
            "message.im",
            "message.mpim",
          ],
        },
        interactivity: { is_enabled: true },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
        is_mcp_enabled: false,
      },
    },
    null,
    2,
  );
}
