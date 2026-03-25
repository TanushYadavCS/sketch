/**
 * Recursive file tree components — FileTreeNode and FolderContents.
 * All shared actions and state come from FileTreeContext instead of props.
 */
import { useFiles } from "@/api/workspace";
import {
  CaretDownIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFileTreeContext } from "./file-tree-context";
import { FileIconComponent } from "./utils";

// ── Inline creation input ──────────────────────────────────────────────────

export function InlineCreateInput({
  placeholder,
  onConfirm,
  onCancel,
}: {
  placeholder: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex gap-1 px-2 py-1">
      <Input
        ref={inputRef}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onConfirm(value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (value.trim()) onConfirm(value);
          else onCancel();
        }}
        className="h-6 py-0 text-sm"
      />
    </div>
  );
}

// ── FolderContents ─────────────────────────────────────────────────────────

export function FolderContents({ folderPath, depth }: { folderPath: string; depth: number }) {
  const ctx = useFileTreeContext();
  const query = useFiles(ctx.scope, folderPath);
  const files = query.data?.files ?? [];

  useEffect(() => {
    if (files.length > 0) {
      ctx.onRegisterMetadata(files);
    }
  }, [files, ctx.onRegisterMetadata]);

  const sorted = useMemo(
    () =>
      [...files].sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      }),
    [files],
  );

  const isCreatingHere = ctx.creatingInFolder?.path === folderPath;

  return (
    <>
      {isCreatingHere && (
        <InlineCreateInput
          placeholder={ctx.creatingInFolder?.type === "folder" ? "Folder name..." : "File name..."}
          onConfirm={ctx.onCreateInFolderConfirm}
          onCancel={ctx.onCreateInFolderCancel}
        />
      )}
      {query.isLoading ? (
        <div className="space-y-1 py-1" style={{ paddingLeft: `${depth * 12 + 8}px` }}>
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: `${depth * 12 + 20}px` }}>
          Empty folder
        </div>
      ) : (
        sorted.map((item) => (
          <FileTreeNode
            key={item.path}
            name={item.name}
            path={item.path}
            isDirectory={item.isDirectory}
            depth={depth}
          />
        ))
      )}
    </>
  );
}

// ── FileTreeNode ───────────────────────────────────────────────────────────

export function FileTreeNode({
  name,
  path,
  isDirectory,
  depth,
}: {
  name: string;
  path: string;
  isDirectory: boolean;
  depth: number;
}) {
  const ctx = useFileTreeContext();
  const isExpanded = ctx.expandedFolders.has(path);
  const isSelected = ctx.selectedFile === path;
  const isRenaming = ctx.renamingPath === path;

  const [pendingCreateType, setPendingCreateType] = useState<"file" | "folder" | null>(null);

  const handleCreateMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open && pendingCreateType) {
        ctx.onCreateInFolder(path, pendingCreateType);
        setPendingCreateType(null);
      }
    },
    [ctx.onCreateInFolder, path, pendingCreateType],
  );

  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: can't use <button> here because it contains nested interactive elements (caret toggle, dropdown triggers) which is invalid HTML and causes event handling bugs */}
      <div
        role="button"
        tabIndex={0}
        aria-label={isDirectory ? `Folder: ${name}` : `File: ${name}`}
        className={cn(
          "flex items-center gap-1 py-1.5 px-2 mx-1 cursor-pointer hover:bg-accent/50 rounded-md group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary w-[calc(100%-0.5rem)] text-left",
          isSelected && "bg-accent",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (isDirectory) ctx.onFocusFolder(path);
          ctx.onFileClick(path, isDirectory);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isDirectory) ctx.onFocusFolder(path);
            ctx.onFileClick(path, isDirectory);
          }
        }}
      >
        {isDirectory ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onToggleFolder(path);
            }}
            className="p-0.5 hover:bg-accent rounded"
          >
            {isExpanded ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
          </button>
        ) : (
          <span className="w-5" />
        )}

        <FileIconComponent fileName={name} isDirectory={isDirectory} isExpanded={isExpanded} />

        {isRenaming ? (
          <Input
            value={ctx.renameValue}
            onChange={(e) => ctx.onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") ctx.onRenameConfirm();
              if (e.key === "Escape") ctx.onRenameCancel();
            }}
            onBlur={ctx.onRenameConfirm}
            autoFocus
            className="h-6 py-0 text-sm"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-sm truncate flex-1">{name}</span>
        )}

        {!isRenaming && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
            {isDirectory && (
              <DropdownMenu modal={false} onOpenChange={handleCreateMenuOpenChange}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => e.stopPropagation()}
                    className="p-1 hover:bg-accent rounded"
                    aria-label="Create inside folder"
                  >
                    <PlusIcon size={12} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.stopPropagation();
                      setPendingCreateType("file");
                    }}
                  >
                    <FileTextIcon size={14} className="mr-2" />
                    New File
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.stopPropagation();
                      setPendingCreateType("folder");
                    }}
                  >
                    <FolderIcon size={14} className="mr-2" />
                    New Folder
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" onClick={(e) => e.stopPropagation()} className="p-1 hover:bg-accent rounded">
                  <PencilIcon size={12} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => ctx.onStartRename(path, name)}>
                  <PencilIcon size={14} className="mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => ctx.onDownload(path)}>
                  <DownloadSimpleIcon size={14} className="mr-2" />
                  Download
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={() => ctx.onDeleteTarget(path, isDirectory)}>
                  <TrashIcon size={14} className="mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {isDirectory && isExpanded && <FolderContents folderPath={path} depth={depth + 1} />}
    </div>
  );
}
