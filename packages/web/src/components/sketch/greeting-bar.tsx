import { useEffect, useState } from "react";

const NUDGES = [
  "Ask me to summarize today's standup in Slack",
  "Ask me what's blocking the launch and I'll dig in",
  "Schedule a daily digest and future you will say thanks",
  "Connect Notion so I can actually read your docs",
];

const SUBTITLE_ROTATE_MS = 30 * 60 * 1000;

function getGreeting(hour: number): string {
  if (hour < 5) return "Hey";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Hey";
}

function pickGreetingForName(firstName: string, hour: number): string {
  if (firstName.length > 12) return "Hey";
  return getGreeting(hour);
}

function pickSubtitle(now = new Date()): string {
  const slot = Math.floor(now.getTime() / SUBTITLE_ROTATE_MS) % NUDGES.length;
  return NUDGES[slot] ?? NUDGES[0];
}

export function GreetingBar({ firstName }: { firstName: string }) {
  const [greeting, setGreeting] = useState(() => pickGreetingForName(firstName, new Date().getHours()));
  const [subtitle, setSubtitle] = useState(() => pickSubtitle());

  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      setGreeting(pickGreetingForName(firstName, now.getHours()));
      setSubtitle(pickSubtitle(now));
    }, SUBTITLE_ROTATE_MS);
    return () => clearInterval(id);
  }, [firstName]);

  return (
    <div className="min-w-0">
      <h1 className="text-xl font-semibold text-foreground">
        {greeting}, {firstName}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}
