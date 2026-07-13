import { AgentToolsField } from "@/components/team/agent-tools-field";
import { PhoneNumberField } from "@/components/team/phone-number-field";
import { SlackChannelsField } from "@/components/team/slack-channels-field";
import { WhatsappFallbackField } from "@/components/team/whatsapp-fallback-field";
import { WhatsAppGroupsField } from "@/components/team/whatsapp-groups-field";
import type { User } from "@/lib/api";
import { api } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_TOOL_CATALOG,
  DEFAULT_PHONE_COUNTRY,
  type PhoneCountryCode,
  emailSchema,
  normalizePhoneNumberToE164,
  whatsappNumberSchema,
} from "@sketch/shared";
/**
 * AddMemberDialog — create a new human member or AI agent.
 * Human members require a name, email, and WhatsApp number; agents require only a name.
 * The toggle between Human/Agent changes which fields are shown and
 * which schema is used for validation.
 */
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
import { Textarea } from "@sketch/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

const addMemberSchema = z.object({
  name: z.string().min(1),
  email: emailSchema,
  whatsappNumber: whatsappNumberSchema,
});

const addAgentSchema = z.object({
  name: z.string().min(1),
});

export function AddMemberDialog({
  open,
  users,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  users: User[];
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [memberType, setMemberType] = useState<"human" | "agent">("human");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [phoneCountry, setPhoneCountry] = useState<PhoneCountryCode>(DEFAULT_PHONE_COUNTRY);
  const [phoneNationalNumber, setPhoneNationalNumber] = useState("");
  const [description, setDescription] = useState("");
  const [reportsTo, setReportsTo] = useState("none");
  const [allowedTools, setAllowedTools] = useState<string[]>(() => AGENT_TOOL_CATALOG.map((t) => t.name));
  const [slackChannelIds, setSlackChannelIds] = useState<string[]>([]);
  const [whatsappGroupJids, setWhatsappGroupJids] = useState<string[]>([]);
  const [isWhatsappFallback, setIsWhatsappFallback] = useState(false);
  const [error, setError] = useState("");
  const normalizedPhone = phoneNationalNumber.trim()
    ? normalizePhoneNumberToE164(phoneNationalNumber, phoneCountry)
    : null;
  const phoneError =
    phoneNationalNumber.trim() && !normalizedPhone ? "Enter a valid WhatsApp number for the selected country" : "";

  const createMutation = useMutation({
    mutationFn: () =>
      api.users.create({
        name: name.trim(),
        type: memberType,
        role: role.trim() || null,
        reportsTo: reportsTo === "none" ? null : reportsTo || null,
        description: description.trim() || null,
        ...(memberType === "human"
          ? {
              email: email.trim() || null,
              whatsappNumber: normalizedPhone,
            }
          : {
              allowedTools,
              slackChannelIds,
              whatsappGroupJids,
              isWhatsappFallback,
            }),
      }),
    onSuccess: (data) => {
      if (data.verificationSent) {
        toast.success("Member added. Verification email sent.");
      } else {
        toast.success(memberType === "agent" ? "Agent added" : "Member added");
      }
      resetAndClose();
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

  const resetAndClose = () => {
    setMemberType("human");
    setName("");
    setRole("");
    setEmail("");
    setPhoneCountry(DEFAULT_PHONE_COUNTRY);
    setPhoneNationalNumber("");
    setDescription("");
    setReportsTo("none");
    setAllowedTools(AGENT_TOOL_CATALOG.map((t) => t.name));
    setSlackChannelIds([]);
    setWhatsappGroupJids([]);
    setIsWhatsappFallback(false);
    setError("");
    onOpenChange(false);
  };

  const canSubmit =
    memberType === "agent"
      ? addAgentSchema.safeParse({ name: name.trim() }).success
      : !phoneError &&
        addMemberSchema.safeParse({
          name: name.trim(),
          email: email.trim(),
          whatsappNumber: normalizedPhone ?? "",
        }).success;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAndClose();
        else onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{memberType === "agent" ? "Add agent" : "Add human member"}</DialogTitle>
          <DialogDescription>
            {memberType === "agent"
              ? "Add an AI agent to your team. Agents have no messaging channels."
              : "Add a new team member. Name, email, and WhatsApp number are required."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-4 overflow-y-auto py-2 pr-1">
          <div className="flex rounded-md border border-border">
            <button
              type="button"
              className={`flex-1 rounded-l-md px-3 py-1.5 text-sm font-medium transition-colors ${
                memberType === "human"
                  ? "bg-primary text-primary-foreground"
                  : "bg-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMemberType("human")}
            >
              Human
            </button>
            <button
              type="button"
              className={`flex-1 rounded-r-md px-3 py-1.5 text-sm font-medium transition-colors ${
                memberType === "agent"
                  ? "bg-primary text-primary-foreground"
                  : "bg-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMemberType("agent")}
            >
              Agent
            </button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-name">Name</Label>
            <Input
              id="add-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              disabled={createMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-role">Role</Label>
            <Input
              id="add-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. VP Marketing, Research Assistant"
              disabled={createMutation.isPending}
            />
          </div>

          {memberType === "agent" ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="add-description">Instructions</Label>
                <span className="text-xs text-muted-foreground">
                  {description.length}/{AGENT_INSTRUCTIONS_MAX_LENGTH}
                </span>
              </div>
              <Textarea
                id="add-description"
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, AGENT_INSTRUCTIONS_MAX_LENGTH))}
                placeholder="Describe how this agent should behave. e.g. You are the marketing maven. Always cite source URLs and write in first person."
                disabled={createMutation.isPending}
                rows={8}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="add-description">Description</Label>
              <Textarea
                id="add-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this person do? e.g. Marketing Lead, handles competitive analysis"
                disabled={createMutation.isPending}
                rows={2}
              />
            </div>
          )}

          {memberType === "agent" && (
            <>
              <AgentToolsField value={allowedTools} onChange={setAllowedTools} disabled={createMutation.isPending} />
              <SlackChannelsField
                value={slackChannelIds}
                onChange={setSlackChannelIds}
                users={users}
                selfName={name.trim() || "this agent"}
                disabled={createMutation.isPending}
              />
              <WhatsAppGroupsField
                value={whatsappGroupJids}
                onChange={setWhatsappGroupJids}
                users={users}
                selfName={name.trim() || "this agent"}
                disabled={createMutation.isPending}
              />
              <WhatsappFallbackField
                value={isWhatsappFallback}
                onChange={setIsWhatsappFallback}
                users={users}
                disabled={createMutation.isPending}
              />
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="add-reports-to">Reports to</Label>
            <Select value={reportsTo} onValueChange={setReportsTo}>
              <SelectTrigger id="add-reports-to">
                <SelectValue placeholder="None (root)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                    {u.role ? ` — ${u.role}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {memberType === "human" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="add-email">Email</Label>
                <Input
                  id="add-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  disabled={createMutation.isPending}
                />
              </div>
              <PhoneNumberField
                id="add-phone"
                label="WhatsApp number"
                country={phoneCountry}
                nationalNumber={phoneNationalNumber}
                onCountryChange={setPhoneCountry}
                onNationalNumberChange={(value) => {
                  setPhoneNationalNumber(value);
                  setError("");
                }}
                disabled={createMutation.isPending}
                error={error || phoneError}
              />
            </>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={createMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => createMutation.mutate()} disabled={!canSubmit || createMutation.isPending}>
            {createMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Adding...
              </>
            ) : memberType === "agent" ? (
              "Add agent"
            ) : (
              "Add member"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
