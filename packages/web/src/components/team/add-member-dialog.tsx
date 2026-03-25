import type { User } from "@/lib/api";
import { api } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import { emailSchema, whatsappNumberSchema } from "@sketch/shared";
/**
 * AddMemberDialog — create a new human member or AI agent.
 * Human members require a name + email; agents require only a name.
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

const optionalPhone = z.literal("").or(whatsappNumberSchema);

const addMemberSchema = z.object({
  name: z.string().min(1),
  email: emailSchema,
  whatsappNumber: optionalPhone,
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
  const [phone, setPhone] = useState("");
  const [description, setDescription] = useState("");
  const [reportsTo, setReportsTo] = useState("none");
  const [error, setError] = useState("");

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
              whatsappNumber: phone.trim() || null,
            }
          : {}),
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
    setPhone("");
    setDescription("");
    setReportsTo("none");
    setError("");
    onOpenChange(false);
  };

  const canSubmit =
    memberType === "agent"
      ? addAgentSchema.safeParse({ name: name.trim() }).success
      : addMemberSchema.safeParse({ name: name.trim(), email: email.trim(), whatsappNumber: phone.trim() }).success;

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
              : "Add a new team member. Name and email are required."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
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
              <div className="space-y-1.5">
                <Label htmlFor="add-phone">WhatsApp number</Label>
                <Input
                  id="add-phone"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setError("");
                  }}
                  placeholder="+91 98765 43210"
                  disabled={createMutation.isPending}
                />
                {error && <p className="text-xs text-destructive">{error}</p>}
              </div>
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
