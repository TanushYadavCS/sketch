/**
 * Team page — manage workspace members.
 * Primary use case: add WhatsApp users so they can chat with the bot.
 * Slack users are auto-created on first DM; this page lets admins manage
 * WhatsApp access and see everyone. Agents are first-class team members with
 * a type toggle in the add dialog and a Robot icon avatar in the list.
 *
 * Also: link provider identities (ClickUp, Google Drive, etc.) to users
 * so file-level access control works at query time.
 */
import { AddMemberDialog } from "@/components/team/add-member-dialog";
import { EditMemberDialog, LinkProviderDialog, RemoveMemberDialog } from "@/components/team/edit-member-dialog";
import { MemberList } from "@/components/team/member-list";
import type { User } from "@/lib/api";
import { api } from "@/lib/api";
import { useDashboardAuth } from "@/routes/dashboard";
import { PlusIcon, RobotIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { Avatar, AvatarFallback } from "@sketch/ui/components/avatar";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Card, CardContent } from "@sketch/ui/components/card";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sketch/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sketch/ui/components/tooltip";
import { getInitials } from "@sketch/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute } from "./dashboard";

export const teamRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/team",
  component: TeamPage,
});

export function TeamPage() {
  const auth = useDashboardAuth();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.users.list(),
  });

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [removingUser, setRemovingUser] = useState<User | null>(null);
  const [linkingUser, setLinkingUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState("list");

  const users = data?.users ?? [];
  const isMember = auth.role === "member";

  return (
    <div className="px-6 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Team</h1>
          {!isMember && (
            <Button size="sm" onClick={() => setShowAddDialog(true)}>
              <PlusIcon size={14} weight="bold" />
              Add member
            </Button>
          )}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-6">
        <div className="mx-auto w-full max-w-3xl">
          <TabsList>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="chart">Chart</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="list">
          <div className="mx-auto w-full max-w-3xl">
            {isLoading ? (
              <LoadingSkeleton />
            ) : users.length === 0 ? (
              isMember ? (
                <p className="text-sm text-muted-foreground">No team members yet.</p>
              ) : (
                <EmptyState onAdd={() => setShowAddDialog(true)} />
              )
            ) : (
              <MemberList
                users={users}
                auth={auth}
                onEdit={setEditingUser}
                onRemove={setRemovingUser}
                onLink={setLinkingUser}
              />
            )}
          </div>
        </TabsContent>
        <TabsContent value="chart">{isLoading ? <LoadingSkeleton /> : <OrgChart users={users} />}</TabsContent>
      </Tabs>

      {!isMember && (
        <AddMemberDialog
          open={showAddDialog}
          users={users}
          onOpenChange={setShowAddDialog}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ["users"] });
          }}
        />
      )}

      <EditMemberDialog
        user={editingUser}
        users={users}
        isMember={isMember}
        onOpenChange={(open) => !open && setEditingUser(null)}
        onSuccess={() => {
          setEditingUser(null);
          queryClient.invalidateQueries({ queryKey: ["users"] });
        }}
      />

      {!isMember && (
        <RemoveMemberDialog
          user={removingUser}
          onOpenChange={(open) => !open && setRemovingUser(null)}
          onSuccess={() => {
            setRemovingUser(null);
            queryClient.invalidateQueries({ queryKey: ["users"] });
          }}
        />
      )}

      <LinkProviderDialog user={linkingUser} onOpenChange={(open) => !open && setLinkingUser(null)} />
    </div>
  );
}

export interface TreeNode {
  user: User;
  children: TreeNode[];
}

export function buildTree(users: User[]): TreeNode[] {
  const byId = new Map(users.map((u) => [u.id, { user: u, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    if (node.user.reports_to && byId.has(node.user.reports_to)) {
      byId.get(node.user.reports_to)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function OrgChart({ users }: { users: User[] }) {
  const roots = buildTree(users);

  if (users.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
        <p className="text-sm text-muted-foreground">No team members yet.</p>
      </div>
    );
  }

  const allRoots = roots.every((r) => r.children.length === 0) && roots.length > 1;

  return (
    <div className="overflow-x-auto py-4">
      {allRoots && (
        <p className="mb-4 text-center text-xs text-muted-foreground">
          Set "Reports to" on team members to see the hierarchy.
        </p>
      )}
      <div className="flex min-w-fit justify-center">
        <ul className="flex gap-8">
          {roots.map((node) => (
            <li key={node.user.id} className="flex flex-col items-center">
              <OrgChartNode node={node} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function OrgChartNode({ node }: { node: TreeNode }) {
  const hasChildren = node.children.length > 0;

  return (
    <div className="flex flex-col items-center">
      <OrgChartCard user={node.user} />
      {hasChildren && (
        <>
          <div className="h-5 w-px bg-border" />
          <ul className="flex items-start">
            {node.children.map((child, i) => {
              const isFirst = i === 0;
              const isLast = i === node.children.length - 1;
              return (
                <li key={child.user.id} className="relative flex flex-col items-center">
                  <div className="flex h-5 w-full">
                    <div className={`w-1/2 ${isFirst ? "" : "border-t border-border"}`} />
                    <div className={`w-1/2 ${isLast ? "" : "border-t border-border"}`} />
                  </div>
                  <div className="absolute left-1/2 top-0 h-5 w-px -translate-x-px bg-border" />
                  <div className="px-2">
                    <OrgChartNode node={child} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function OrgChartCard({ user }: { user: User }) {
  const isAgent = user.type === "agent";
  const initials = getInitials(user.name);

  return (
    <Card className="w-48">
      <CardContent className="flex flex-col items-center p-4 text-center">
        <Avatar className="size-10">
          {isAgent ? (
            <AvatarFallback className="bg-primary/10 text-primary">
              <RobotIcon size={20} weight="fill" />
            </AvatarFallback>
          ) : (
            <AvatarFallback className="text-sm font-medium">{initials}</AvatarFallback>
          )}
        </Avatar>
        <div className="mt-2 flex items-center gap-1">
          <span className="text-sm font-medium">{user.name}</span>
          {isAgent && (
            <Badge variant="outline" className="px-1 py-0 text-[10px]">
              Agent
            </Badge>
          )}
        </div>
        {user.role && (
          <Badge variant="secondary" className="mt-1 text-[10px]">
            {user.role}
          </Badge>
        )}
        {user.description && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{user.description}</p>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <p>{user.description}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-lg bg-muted">
        <UsersThreeIcon size={22} className="text-muted-foreground" />
      </div>
      <p className="mt-4 text-sm font-medium">Your team's empty!</p>
      <p className="mt-1 text-xs text-muted-foreground">Add your first team member to get started.</p>
      <Button size="sm" onClick={onAdd} className="mt-4">
        <PlusIcon size={14} weight="bold" />
        Add member
      </Button>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-24" />
      <div className="rounded-lg border border-border bg-card">
        {[1, 2, 3].map((i) => (
          <div key={i} className={`flex items-center gap-4 px-4 py-4 ${i < 3 ? "border-b border-border" : ""}`}>
            <Skeleton className="size-9 rounded-full" />
            <Skeleton className="h-4 w-36" />
            <div className="ml-auto flex gap-2">
              <Skeleton className="size-4" />
              <Skeleton className="size-4" />
              <Skeleton className="size-4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
