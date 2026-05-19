import { api } from "@/lib/api";
import {
  ArrowLeftIcon,
  ChatCircleIcon,
  EnvelopeIcon,
  EyeIcon,
  EyeSlashIcon,
  ShieldIcon,
  SlackLogoIcon,
  WhatsappLogoIcon,
} from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Card, CardContent, CardHeader } from "@sketch/ui/components/card";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { useMutation } from "@tanstack/react-query";
import { createRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { redirectToManagedLogin } from "./managed-redirect";
import { rootRoute } from "./root";

type LoginStep = "choose" | "password" | "magic-link" | "magic-link-sent";

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: async () => {
    const status = await api.setup.status();
    if (!status.completed) {
      throw redirect({ to: "/onboarding" });
    }
    if (status.managedUrl) {
      redirectToManagedLogin(status.managedUrl);
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { logoSrc } = useTheme();
  const [step, setStep] = useState<LoginStep>("choose");
  const [magicLinkEmail, setMagicLinkEmail] = useState("");
  const [sentChannels, setSentChannels] = useState<string[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorParam = params.get("error");
    if (errorParam === "expired_link") {
      toast.error("Your login link has expired. Please request a new one.");
    } else if (errorParam === "invalid_link") {
      toast.error("Invalid login link.");
    } else if (errorParam === "server_error") {
      toast.error("Something went wrong. Please try again.");
    }
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-8">
      <div className="mb-8 flex flex-col items-center gap-2">
        <img src={logoSrc} alt="Sketch" className="size-8" />
        <span className="text-lg font-semibold tracking-tight">Sketch</span>
      </div>

      {step === "choose" && (
        <ChooseStep onPassword={() => setStep("password")} onMagicLink={() => setStep("magic-link")} />
      )}
      {step === "password" && (
        <PasswordStep onBack={() => setStep("choose")} onSuccess={() => navigate({ to: "/channels" })} />
      )}
      {step === "magic-link" && (
        <MagicLinkStep
          email={magicLinkEmail}
          onEmailChange={setMagicLinkEmail}
          onBack={() => setStep("choose")}
          onSent={(channels) => {
            setSentChannels(channels);
            setStep("magic-link-sent");
          }}
        />
      )}
      {step === "magic-link-sent" && (
        <MagicLinkSentStep email={magicLinkEmail} channels={sentChannels} onBack={() => setStep("magic-link")} />
      )}
    </div>
  );
}

function ChooseStep({ onPassword, onMagicLink }: { onPassword: () => void; onMagicLink: () => void }) {
  return (
    <Card className="w-full max-w-[400px]">
      <CardHeader className="text-center">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="text-sm text-muted-foreground">Choose how you'd like to sign in</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" className="w-full justify-start gap-3 h-12" onClick={onPassword}>
          <ShieldIcon size={18} />
          <div className="text-left">
            <div className="text-sm font-medium">Sign in with password</div>
            <div className="text-xs text-muted-foreground">Email and password</div>
          </div>
        </Button>
        <Button variant="outline" className="w-full justify-start gap-3 h-12" onClick={onMagicLink}>
          <EnvelopeIcon size={18} />
          <div className="text-left">
            <div className="text-sm font-medium">Sign in with magic link</div>
            <div className="text-xs text-muted-foreground">We'll send you a sign-in link</div>
          </div>
        </Button>
      </CardContent>
    </Card>
  );
}

function PasswordStep({ onBack, onSuccess }: { onBack: () => void; onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const loginMutation = useMutation({
    mutationFn: () => api.auth.login(email, password),
    onSuccess,
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate();
  };

  return (
    <Card className="w-full max-w-[400px]">
      <CardHeader className="text-center">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="text-sm text-muted-foreground">Sign in with your email and password</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@yourorg.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-0 right-0 h-full px-3 hover:bg-transparent"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
              </Button>
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
            {loginMutation.isPending ? "Signing in..." : "Sign in"}
          </Button>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeftIcon size={12} />
            Back
          </button>
        </form>
      </CardContent>
    </Card>
  );
}

function MagicLinkStep({
  email,
  onEmailChange,
  onBack,
  onSent,
}: { email: string; onEmailChange: (v: string) => void; onBack: () => void; onSent: (channels: string[]) => void }) {
  const magicLinkMutation = useMutation({
    mutationFn: () => api.auth.magicLink.request(email),
    onSuccess: (data) => onSent(data.channels),
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    magicLinkMutation.mutate();
  };

  return (
    <Card className="w-full max-w-[400px]">
      <CardHeader className="text-center">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="text-sm text-muted-foreground">We'll send a sign-in link to your email</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="member-email">Email</Label>
            <Input
              id="member-email"
              type="email"
              placeholder="you@yourorg.com"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              required
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" disabled={magicLinkMutation.isPending}>
            {magicLinkMutation.isPending ? "Sending..." : "Send magic link"}
          </Button>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeftIcon size={12} />
            Back
          </button>
        </form>
      </CardContent>
    </Card>
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  slack: "Slack DM",
  email: "email",
  whatsapp: "WhatsApp",
};

function formatChannelList(channels: string[]): string {
  const labels = channels.map((ch) => CHANNEL_LABELS[ch] ?? ch);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function ChannelIcon({ channels }: { channels: string[] }) {
  if (channels.includes("slack")) return <SlackLogoIcon size={24} className="text-primary" />;
  if (channels.includes("whatsapp")) return <WhatsappLogoIcon size={24} className="text-primary" />;
  if (channels.includes("email")) return <EnvelopeIcon size={24} className="text-primary" />;
  return <ChatCircleIcon size={24} className="text-primary" />;
}

function MagicLinkSentStep({ email, channels, onBack }: { email: string; channels: string[]; onBack: () => void }) {
  const resendMutation = useMutation({
    mutationFn: () => api.auth.magicLink.request(email),
    onSuccess: () => toast.success("Magic link resent!"),
    onError: (error: Error) => toast.error(error.message),
  });

  const hasChannels = channels.length > 0;

  return (
    <Card className="w-full max-w-[400px]">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
          <ChannelIcon channels={channels} />
        </div>
        <h1 className="text-xl font-semibold">{hasChannels ? "Check your messages" : "Magic link generated"}</h1>
        <p className="text-sm text-muted-foreground">
          {hasChannels
            ? `We sent a sign-in link to your ${formatChannelList(channels)}. Click the link to sign in.`
            : "No delivery channels configured. The sign-in link has been logged to the server console."}
        </p>
      </CardHeader>
      <CardContent className="text-center">
        <p className="text-xs text-muted-foreground">The link expires in 15 minutes and can only be used once.</p>
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            type="button"
            className="text-xs text-primary hover:text-primary/80 disabled:opacity-50"
            onClick={() => resendMutation.mutate()}
            disabled={resendMutation.isPending}
          >
            {resendMutation.isPending ? "Resending..." : "Resend magic link"}
          </button>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeftIcon size={12} />
            Try a different email
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
