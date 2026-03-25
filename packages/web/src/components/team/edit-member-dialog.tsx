/**
 * EditMemberDialog — update an existing member's name, role, description,
 * reports-to, and contact details. Admins can edit all fields; members can
 * only edit their own record (and cannot change their own email).
 *
 * Also includes RemoveMemberDialog and LinkProviderDialog as they share
 * the same import surface and are only used together with this dialog.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import type { ProviderIdentity, User } from "@/lib/api";
import { api } from "@/lib/api";
import { getIntegration } from "@/lib/integrations";
import { CheckCircleIcon, ClockIcon, RobotIcon, SlackLogoIcon, SpinnerGapIcon, XIcon } from "@phosphor-icons/react";
import { emailSchema, whatsappNumberSchema } from "@sketch/shared";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Textarea } from "@sketch/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

const optionalEmail = z.literal("").or(emailSchema);
const optionalPhone = z.literal("").or(whatsappNumberSchema);

const editMemberSchema = z.object({
  name: z.string().min(1),
  email: optionalEmail,
  whatsappNumber: optionalPhone,
});

export function EditMemberDialog({
  user,
  users,
  isMember,
  onOpenChange,
  onSuccess,
}: {
  user: User | null;
  users: User[];
  isMember: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [description, setDescription] = useState("");
  const [reportsTo, setReportsTo] = useState("none");
  const [error, setError] = useState("");

  const isAgent = user?.type === "agent";

  useEffect(() => {
    if (user) {
      setName(user.name);
      setRole(user.role ?? "");
      setEmail(user.email ?? "");
      setPhone(user.whatsapp_number ?? "");
      setDescription(user.description ?? "");
      setReportsTo(user.reports_to ?? "none");
      setError("");
    }
  }, [user]);

  const updateMutation = useMutation({
    mutationFn: () =>
      api.users.update(user?.id ?? "", {
        name: name.trim(),
        role: role.trim() || null,
        reportsTo: reportsTo === "none" ? null : reportsTo || null,
        description: description.trim() || null,
        ...(isAgent
          ? {}
          : {
              ...(isMember ? {} : { email: email.trim() || null }),
              whatsappNumber: phone.trim() || null,
            }),
      }),
    onSuccess: (data) => {
      if (data.verificationSent) {
        toast.success("Member updated. Verification email sent.");
      } else {
        toast.success("Member updated");
      }
      onSuccess();
    },
    onError: (err: Error) => {
      if (err.message.includes("already linked")) {
        setError("This email or number is already linked to another member");
      } else {
        toast.error(err.message);
      }
    },
  });

  const resendMutation = useMutation({
    mutationFn: () => api.users.resendVerification(user?.id ?? ""),
    onSuccess: (data) => {
      if (data.sent) {
        toast.success("Verification email sent");
      } else {
        toast.success("Verification link logged to server console (SMTP not configured)");
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const currentReportsTo = reportsTo === "none" ? null : reportsTo || null;
  const originalReportsTo = user?.reports_to ?? null;

  const isDirty =
    user &&
    (name.trim() !== user.name ||
      (role.trim() || null) !== (user.role ?? null) ||
      currentReportsTo !== originalReportsTo ||
      (description.trim() || null) !== (user.description ?? null) ||
      (!isAgent &&
        ((email.trim() || null) !== (user.email ?? null) ||
          (phone.trim() || null) !== (user.whatsapp_number ?? null))));

  const canSubmit =
    isDirty &&
    editMemberSchema.safeParse({ name: name.trim(), email: email.trim(), whatsappNumber: phone.trim() }).success;

  const otherUsers = users.filter((u) => u.id !== user?.id);

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit member</DialogTitle>
          <DialogDescription>Update this member's details.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            {isAgent ? (
              <Badge variant="secondary">
                <RobotIcon size={12} weight="fill" className="mr-1" />
                Agent
              </Badge>
            ) : (
              <Badge variant="secondary">Human</Badge>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-name">Name</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={updateMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-role">Role</Label>
            <Input
              id="edit-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. VP Marketing, Research Assistant"
              disabled={updateMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this person do? e.g. Marketing Lead, handles competitive analysis"
              disabled={updateMutation.isPending}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-reports-to">Reports to</Label>
            <Select value={reportsTo} onValueChange={setReportsTo}>
              <SelectTrigger id="edit-reports-to">
                <SelectValue placeholder="None (root)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {otherUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                    {u.role ? ` — ${u.role}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isAgent && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  disabled={updateMutation.isPending || isMember}
                />
                {isMember && <p className="text-xs text-muted-foreground">Contact your admin to change your email.</p>}
                {user?.email && email === user.email && (
                  <div className="flex items-center gap-1.5">
                    {user.email_verified_at ? (
                      <span className="flex items-center gap-1 text-xs text-green-600">
                        <CheckCircleIcon size={14} weight="fill" />
                        Verified
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-amber-600">
                        <ClockIcon size={14} />
                        Pending verification
                        <button
                          type="button"
                          className="ml-1 text-xs underline hover:no-underline disabled:opacity-50"
                          disabled={resendMutation.isPending}
                          onClick={() => resendMutation.mutate()}
                        >
                          {resendMutation.isPending ? "Sending..." : "Resend"}
                        </button>
                      </span>
                    )}
                  </div>
                )}
              </div>

              {user?.slack_user_id && (
                <div className="space-y-1.5">
                  <Label className="text-muted-foreground">Slack</Label>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
                    <SlackLogoIcon size={16} style={{ color: "#E01E5A" }} />
                    <span className="text-sm text-muted-foreground">Connected</span>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="edit-phone">WhatsApp number</Label>
                <Input
                  id="edit-phone"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setError("");
                  }}
                  placeholder="+91 98765 43210"
                  disabled={updateMutation.isPending}
                />
                {error ? (
                  <p className="text-xs text-destructive">{error}</p>
                ) : phone.trim() ? (
                  <p className="text-xs text-muted-foreground">
                    This number will be linked to {user?.name}'s identity on WhatsApp.
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={updateMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => updateMutation.mutate()} disabled={!canSubmit || updateMutation.isPending}>
            {updateMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Saving...
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveMemberDialog({
  user,
  onOpenChange,
  onSuccess,
}: {
  user: User | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const removeMutation = useMutation({
    mutationFn: () => api.users.remove(user?.id ?? ""),
    onSuccess: () => {
      toast.success(`${user?.name} has been removed`);
      onSuccess();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove team member?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>{user?.name} will lose access to this Sketch workspace immediately.</p>
              <p className="text-muted-foreground">Their past conversations will be retained.</p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={removeMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={() => removeMutation.mutate()} disabled={removeMutation.isPending}>
            {removeMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Removing...
              </>
            ) : (
              "Remove"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LinkProviderDialog({
  user,
  onOpenChange,
}: {
  user: User | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const { data: connectorsData } = useQuery({
    queryKey: ["connectors"],
    queryFn: () => api.integrations.list(),
    enabled: !!user,
  });

  const { data: identitiesData, isLoading: identitiesLoading } = useQuery({
    queryKey: ["identities", user?.id],
    queryFn: () => api.identities.listForUser(user?.id ?? ""),
    enabled: !!user,
  });

  const connectors = connectorsData?.connectors ?? [];
  const identities = identitiesData?.identities ?? [];
  const connectedProviders = [...new Set(connectors.map((c) => c.connectorType))];

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link accounts</DialogTitle>
          <DialogDescription>
            Map {user?.name}'s accounts in connected integrations. This controls which files they can access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {identitiesLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : connectedProviders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-8 text-center">
              <p className="text-sm text-muted-foreground">No integrations connected yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">Connect an integration first to link user accounts.</p>
            </div>
          ) : (
            connectedProviders.map((provider) => {
              const existing = identities.find((i) => i.provider === provider);
              return (
                <ProviderLinkRow
                  key={provider}
                  provider={provider}
                  userId={user?.id ?? ""}
                  existing={existing ?? null}
                  onSuccess={() => {
                    queryClient.invalidateQueries({ queryKey: ["identities", user?.id] });
                  }}
                />
              );
            })
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderLinkRow({
  provider,
  userId,
  existing,
  onSuccess,
}: {
  provider: string;
  userId: string;
  existing: ProviderIdentity | null;
  onSuccess: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [providerUserId, setProviderUserId] = useState("");
  const [providerEmail, setProviderEmail] = useState("");

  const integration = getIntegration(provider as Parameters<typeof getIntegration>[0]);
  const displayName = integration?.name ?? provider;
  const color = integration?.color ?? "#888";

  const connectMutation = useMutation({
    mutationFn: () =>
      api.identities.connect({
        userId,
        provider,
        providerUserId: providerUserId.trim(),
        providerEmail: providerEmail.trim() || null,
      }),
    onSuccess: () => {
      toast.success(`${displayName} account linked`);
      setIsEditing(false);
      setProviderUserId("");
      setProviderEmail("");
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.identities.disconnect(userId, provider),
    onSuccess: () => {
      toast.success(`${displayName} account unlinked`);
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (existing && !isEditing) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-3">
        <span style={{ color }}>
          <ConnectorLogo type={provider} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{existing.providerEmail ?? existing.providerUserId}</p>
        </div>
        <Badge variant="outline" className="text-[10px] text-green-500 border-green-500/30">
          Linked
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          onClick={() => disconnectMutation.mutate()}
          disabled={disconnectMutation.isPending}
        >
          <XIcon size={14} />
        </Button>
      </div>
    );
  }

  if (isEditing) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-3">
        <div className="flex items-center gap-2 mb-3">
          <span style={{ color }}>
            <ConnectorLogo type={provider} size={18} />
          </span>
          <p className="text-sm font-medium">{displayName}</p>
        </div>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor={`link-${provider}-id`} className="text-xs">
              User ID
            </Label>
            <Input
              id={`link-${provider}-id`}
              value={providerUserId}
              onChange={(e) => setProviderUserId(e.target.value)}
              placeholder={getProviderIdPlaceholder(provider)}
              className="h-8 text-sm"
              disabled={connectMutation.isPending}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`link-${provider}-email`} className="text-xs">
              Email <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={`link-${provider}-email`}
              value={providerEmail}
              onChange={(e) => setProviderEmail(e.target.value)}
              placeholder="user@example.com"
              className="h-8 text-sm"
              disabled={connectMutation.isPending}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setIsEditing(false);
                setProviderUserId("");
                setProviderEmail("");
              }}
              disabled={connectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => connectMutation.mutate()}
              disabled={!providerUserId.trim() || connectMutation.isPending}
            >
              {connectMutation.isPending ? <SpinnerGapIcon size={12} className="animate-spin" /> : "Link"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-3">
      <span style={{ color }} className="opacity-50">
        <ConnectorLogo type={provider} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-muted-foreground">{displayName}</p>
        <p className="text-xs text-muted-foreground/70">Not linked</p>
      </div>
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setIsEditing(true)}>
        Link
      </Button>
    </div>
  );
}

function getProviderIdPlaceholder(provider: string): string {
  switch (provider) {
    case "clickup":
      return "ClickUp user ID (numeric)";
    case "google_drive":
      return "Google user ID or email";
    case "linear":
      return "Linear user ID";
    case "notion":
      return "Notion user ID";
    default:
      return "Provider user ID";
  }
}
