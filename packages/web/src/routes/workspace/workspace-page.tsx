/**
 * Workspace file browser page — split-pane file manager with Monaco editor.
 * State management, handlers, and layout composition.
 */
import {
  type WorkspaceScope,
  useCreateFile,
  useCreateFolder,
  useDeleteFile,
  useFileContent,
  useFiles,
  useRenameFile,
  useSaveFile,
  useSearchFiles,
  useUploadFile,
} from "@/api/workspace";
import {
  ArrowClockwiseIcon,
  CaretUpDownIcon,
  CheckIcon,
  FileTextIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { FileMetadata } from "@sketch/shared";
import { fileNameSchema } from "@sketch/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Progress } from "@sketch/ui/components/progress";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sketch/ui/components/tooltip";
import { useIsMobile } from "@sketch/ui/hooks/use-mobile";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { cn } from "@sketch/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EditorPane } from "./editor-pane";
import { FileTreeNode, InlineCreateInput } from "./file-tree";
import { FileTreeContext } from "./file-tree-context";
import { getFileExtension, getLanguageFromExtension } from "./utils";

export function WorkspacePage() {
  const isMobile = useIsMobile();
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();

  // ── Workspace scope ──────────────────────────────────────
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceScope>("personal");

  // ── Core state ────────────────────────────────────────────
  const [focusedFolder, setFocusedFolder] = useState(".");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; isDirectory: boolean } | null>(null);
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState(280);
  const [isDragging, setIsDragging] = useState(false);
  const [showTreeOnMobile, setShowTreeOnMobile] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Search state ──────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  // ── Inline creation state ─────────────────────────────────
  const [isCreatingAtRoot, setIsCreatingAtRoot] = useState<"file" | "folder" | null>(null);
  const [creatingInFolder, setCreatingInFolder] = useState<{ path: string; type: "file" | "folder" } | null>(null);

  // ── Drag-drop state ───────────────────────────────────────
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const dragCounter = useRef(0);

  // ── Accumulated metadata map across all loaded dirs ───────
  const [metadataMap, setMetadataMap] = useState<Map<string, FileMetadata>>(new Map());

  const registerMetadata = useCallback((files: FileMetadata[]) => {
    setMetadataMap((prev) => {
      const next = new Map(prev);
      for (const f of files) next.set(f.path, f);
      return next;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset all state when scope changes
  useEffect(() => {
    setSelectedFile(null);
    setExpandedFolders(new Set());
    setFocusedFolder(".");
    setEditorContent(null);
    setIsDirty(false);
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setRenamingPath(null);
    setIsCreatingAtRoot(null);
    setCreatingInFolder(null);
    setMetadataMap(new Map());
  }, [workspaceScope]);

  // ── Debounce search 300ms ─────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ── Queries ───────────────────────────────────────────────
  const rootFilesQuery = useFiles(workspaceScope, ".");
  const fileContentQuery = useFileContent(workspaceScope, selectedFile);
  const searchResultQuery = useSearchFiles(workspaceScope, debouncedSearchQuery);

  const rootFiles = useMemo(
    () =>
      [...(rootFilesQuery.data?.files ?? [])].sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      }),
    [rootFilesQuery.data?.files],
  );

  useEffect(() => {
    if (rootFilesQuery.data?.files) registerMetadata(rootFilesQuery.data.files);
  }, [rootFilesQuery.data?.files, registerMetadata]);

  useEffect(() => {
    if (searchResultQuery.data?.files) registerMetadata(searchResultQuery.data.files);
  }, [searchResultQuery.data?.files, registerMetadata]);

  // ── Mutations ─────────────────────────────────────────────
  const saveMutation = useSaveFile();
  const uploadMutation = useUploadFile();
  const createFolderMutation = useCreateFolder();
  const createFileMutation = useCreateFile();
  const deleteMutation = useDeleteFile();
  const renameMutation = useRenameFile();

  useEffect(() => {
    if (fileContentQuery.data?.content != null) {
      setEditorContent(fileContentQuery.data.content);
      setIsDirty(false);
    }
  }, [fileContentQuery.data?.content]);

  // ── Handlers ─────────────────────────────────────────────
  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleFileClick = useCallback(
    (path: string, isDirectory: boolean) => {
      if (isDirectory) {
        toggleFolder(path);
        return;
      }
      setSelectedFile(path);
    },
    [toggleFolder],
  );

  const handleSave = useCallback(async () => {
    if (!selectedFile || editorContent == null) return;
    try {
      await saveMutation.mutateAsync({ scope: workspaceScope, path: selectedFile, content: editorContent });
      setIsDirty(false);
      toast.success("File saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save file");
    }
  }, [selectedFile, editorContent, saveMutation, workspaceScope]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (selectedFile && isDirty && !saveMutation.isPending) void handleSave();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedFile, isDirty, saveMutation.isPending, handleSave]);

  const handleUpload = useCallback(
    async (file: File) => {
      const uploadPath = focusedFolder === "." ? file.name : `${focusedFolder}/${file.name}`;
      try {
        await uploadMutation.mutateAsync({ scope: workspaceScope, path: uploadPath, file });
        toast.success(`Uploaded ${file.name}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to upload file");
      }
    },
    [focusedFolder, uploadMutation, workspaceScope],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleUpload(file);
      e.target.value = "";
    },
    [handleUpload],
  );

  const handleCreateItem = useCallback(
    async (name: string, parentPath: string, type: "file" | "folder") => {
      if (!name.trim()) return;
      const nameValidation = fileNameSchema.safeParse(name);
      if (!nameValidation.success) {
        toast.error(nameValidation.error.issues[0]?.message ?? "Invalid name");
        return;
      }
      const itemPath = parentPath === "." ? name : `${parentPath}/${name}`;
      try {
        if (type === "folder") {
          await createFolderMutation.mutateAsync({ scope: workspaceScope, path: itemPath });
          toast.success("Folder created");
        } else {
          await createFileMutation.mutateAsync({ scope: workspaceScope, path: itemPath });
          setSelectedFile(itemPath);
          toast.success("File created");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to create");
      }
    },
    [createFolderMutation, createFileMutation, workspaceScope],
  );

  const handleCreateAtRoot = useCallback(
    (name: string) => {
      const type = isCreatingAtRoot;
      setIsCreatingAtRoot(null);
      if (type) void handleCreateItem(name, focusedFolder, type);
    },
    [focusedFolder, isCreatingAtRoot, handleCreateItem],
  );

  const handleCreateInFolderConfirm = useCallback(
    (name: string) => {
      if (!creatingInFolder) return;
      const { path, type } = creatingInFolder;
      setCreatingInFolder(null);
      void handleCreateItem(name, path, type);
    },
    [creatingInFolder, handleCreateItem],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ scope: workspaceScope, path: deleteTarget.path });
      if (selectedFile === deleteTarget.path) setSelectedFile(null);
      setDeleteTarget(null);
      toast.success("Deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }, [deleteTarget, selectedFile, deleteMutation, workspaceScope]);

  const handleRename = useCallback(async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      setRenameValue("");
      return;
    }
    const nameValidation = fileNameSchema.safeParse(renameValue);
    if (!nameValidation.success) {
      toast.error(nameValidation.error.issues[0]?.message ?? "Invalid name");
      return;
    }
    const parent = renamingPath.split("/").slice(0, -1).join("/") || ".";
    const newPath = parent === "." ? renameValue : `${parent}/${renameValue}`;
    try {
      await renameMutation.mutateAsync({ scope: workspaceScope, oldPath: renamingPath, newPath });
      setRenamingPath(null);
      setRenameValue("");
      if (selectedFile === renamingPath) setSelectedFile(newPath);
      toast.success("Renamed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename");
    }
  }, [renamingPath, renameValue, selectedFile, renameMutation, workspaceScope]);

  const handleDownload = useCallback(
    (path: string) => {
      const params = new URLSearchParams();
      params.set("path", path);
      params.set("download", "true");
      params.set("scope", workspaceScope);
      const a = document.createElement("a");
      a.href = `/api/workspace/files/content?${params.toString()}`;
      a.download = path.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    [workspaceScope],
  );

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["workspace"] });
  }, [queryClient]);

  // ── Drag-drop handlers ─────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer.items.length > 0 && e.dataTransfer.items[0]?.kind === "file") setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      dragCounter.current = 0;
      const items = e.dataTransfer.files;
      if (items.length === 0) return;
      setUploadProgress(0);
      const totalFiles = items.length;
      let completedFiles = 0;
      for (const file of Array.from(items)) {
        const uploadPath = focusedFolder === "." ? file.name : `${focusedFolder}/${file.name}`;
        try {
          await uploadMutation.mutateAsync({ scope: workspaceScope, path: uploadPath, file });
          completedFiles += 1;
          setUploadProgress(Math.round((completedFiles / totalFiles) * 100));
        } catch (err) {
          toast.error(`Failed to upload ${file.name}: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      }
      setTimeout(() => setUploadProgress(null), 1000);
      toast.success(`Uploaded ${completedFiles} of ${totalFiles} files`);
    },
    [focusedFolder, uploadMutation, workspaceScope],
  );

  // ── Resizer handlers ──────────────────────────────────────
  const handleResizerMouseDown = useCallback(() => setIsDragging(true), []);

  const handleResizerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setLeftPaneWidth((w) => Math.max(200, w - 50));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setLeftPaneWidth((w) => Math.min(500, w + 50));
    }
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    function handleMouseMove(e: MouseEvent) {
      setLeftPaneWidth(Math.max(200, Math.min(500, e.clientX - 256)));
    }
    function handleMouseUp() {
      setIsDragging(false);
    }
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  // ── Derived values ────────────────────────────────────────
  const selectedFileData = useMemo(
    () => (selectedFile ? metadataMap.get(selectedFile) : undefined),
    [selectedFile, metadataMap],
  );
  const fileExtension = selectedFile ? getFileExtension(selectedFile.split("/").pop() || "") : "";
  const language = getLanguageFromExtension(fileExtension);
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";
  const treePaneVisible = !isMobile || showTreeOnMobile;

  // ── File tree context value ───────────────────────────────
  const treeContextValue = useMemo(
    () => ({
      scope: workspaceScope,
      selectedFile,
      expandedFolders,
      renamingPath,
      renameValue,
      creatingInFolder,
      onToggleFolder: toggleFolder,
      onFocusFolder: setFocusedFolder,
      onFileClick: handleFileClick,
      onStartRename: (path: string, name: string) => {
        setRenamingPath(path);
        setRenameValue(name);
      },
      onRenameChange: setRenameValue,
      onRenameConfirm: () => void handleRename(),
      onRenameCancel: () => {
        setRenamingPath(null);
        setRenameValue("");
      },
      onDeleteTarget: (path: string, isDir: boolean) => setDeleteTarget({ path, isDirectory: isDir }),
      onDownload: handleDownload,
      onRegisterMetadata: registerMetadata,
      onCreateInFolder: (folderPath: string, type: "file" | "folder") => {
        setCreatingInFolder({ path: folderPath, type });
        setExpandedFolders((prev) => new Set(prev).add(folderPath));
      },
      onCreateInFolderConfirm: handleCreateInFolderConfirm,
      onCreateInFolderCancel: () => setCreatingInFolder(null),
    }),
    [
      workspaceScope,
      selectedFile,
      expandedFolders,
      renamingPath,
      renameValue,
      creatingInFolder,
      toggleFolder,
      handleFileClick,
      handleRename,
      handleDownload,
      registerMetadata,
      handleCreateInFolderConfirm,
    ],
  );

  // ── Tree pane ─────────────────────────────────────────────
  const treePane = (
    <div
      className={cn(
        "flex flex-col bg-card relative",
        isDragOver && "ring-2 ring-primary ring-inset",
        isMobile ? "w-full" : "",
      )}
      style={isMobile ? undefined : { width: leftPaneWidth }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Tree header */}
      <div className="flex items-center justify-between px-4 border-b border-border h-11">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex items-center gap-1.5 text-sm font-semibold hover:text-foreground/80">
              {workspaceScope === "personal" ? "Personal" : "Organization"}
              <CaretUpDownIcon size={14} className="text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => setWorkspaceScope("personal")}>
              <CheckIcon size={14} className={cn("mr-2", workspaceScope !== "personal" && "invisible")} />
              Personal
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setWorkspaceScope("org")}>
              <CheckIcon size={14} className={cn("mr-2", workspaceScope !== "org" && "invisible")} />
              Organization
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRefresh}>
                  <ArrowClockwiseIcon size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {isMobile && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowTreeOnMobile(false)}>
              <XIcon size={16} />
            </Button>
          )}
        </div>
      </div>

      {/* Search bar */}
      <div className="p-2 border-b border-border">
        <div className="relative">
          <MagnifyingGlassIcon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 pr-8 text-sm"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <XIcon size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-end gap-1 px-2 py-1 border-b border-border">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => fileInputRef.current?.click()}>
                <UploadSimpleIcon size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Upload file</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsCreatingAtRoot("file")}>
                <FileTextIcon size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New file</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsCreatingAtRoot("folder")}>
                <FolderIcon size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New folder</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInputChange} />
      </div>

      {/* Upload progress */}
      {uploadProgress !== null && (
        <div className="px-3 py-2 border-b border-border">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground">Uploading...</span>
            <span className="text-xs text-muted-foreground">{uploadProgress}%</span>
          </div>
          <Progress value={uploadProgress} className="h-1" />
        </div>
      )}

      {/* Drag-drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary m-1 rounded flex items-center justify-center pointer-events-none z-10">
          <div className="text-center">
            <UploadSimpleIcon size={32} className="mx-auto mb-2 text-primary" />
            <p className="text-sm font-medium text-primary">Drop files here to upload</p>
          </div>
        </div>
      )}

      {/* Tree content */}
      <div className="flex-1 overflow-auto py-2 relative">
        {debouncedSearchQuery.trim() ? (
          searchResultQuery.isLoading ? (
            <div className="space-y-2 px-3">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-4/5" />
              <Skeleton className="h-6 w-3/5" />
            </div>
          ) : (searchResultQuery.data?.files ?? []).length === 0 ? (
            <div className="px-4 py-8 text-center text-muted-foreground text-sm">
              <p>No files match &quot;{debouncedSearchQuery}&quot;</p>
              <p className="text-xs mt-1">Try a different search term</p>
            </div>
          ) : (
            [...(searchResultQuery.data?.files ?? [])]
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((item) => (
                <FileTreeNode
                  key={item.path}
                  name={item.path}
                  path={item.path}
                  isDirectory={item.isDirectory}
                  depth={0}
                />
              ))
          )
        ) : rootFilesQuery.isLoading ? (
          <div className="space-y-2 px-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5 ml-4" />
            <Skeleton className="h-6 w-4/5 ml-4" />
            <Skeleton className="h-6 w-3/5" />
          </div>
        ) : rootFiles.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted-foreground text-sm">
            <p>No files yet</p>
            <p className="text-xs mt-1">Drop files here or create one above</p>
          </div>
        ) : (
          <>
            {isCreatingAtRoot && (
              <InlineCreateInput
                placeholder={isCreatingAtRoot === "folder" ? "Folder name..." : "File name..."}
                onConfirm={handleCreateAtRoot}
                onCancel={() => setIsCreatingAtRoot(null)}
              />
            )}
            {rootFiles.map((item) => (
              <FileTreeNode
                key={item.path}
                name={item.name}
                path={item.path}
                isDirectory={item.isDirectory}
                depth={0}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );

  // ── Layout ────────────────────────────────────────────────
  return (
    <FileTreeContext.Provider value={treeContextValue}>
      <div
        className={cn(
          "flex overflow-hidden border-t border-border",
          isMobile ? "flex-col h-[calc(100vh-52px)]" : "flex-row h-[calc(100vh-52px)]",
        )}
      >
        {isMobile ? (
          <>
            {treePaneVisible && treePane}
            {!showTreeOnMobile && (
              <EditorPane
                isMobile
                showTreeOnMobile={showTreeOnMobile}
                onShowTree={() => setShowTreeOnMobile(true)}
                selectedFile={selectedFile}
                selectedFileData={selectedFileData}
                editorContent={editorContent}
                isDirty={isDirty}
                language={language}
                monacoTheme={monacoTheme}
                isLoading={fileContentQuery.isLoading}
                isSaving={saveMutation.isPending}
                onEditorChange={(v) => {
                  setEditorContent(v ?? "");
                  setIsDirty(true);
                }}
                onSave={() => void handleSave()}
                onDownload={handleDownload}
                onDelete={(path) => setDeleteTarget({ path, isDirectory: false })}
                onUploadClick={() => fileInputRef.current?.click()}
              />
            )}
          </>
        ) : (
          <>
            {treePane}
            {/* Resizer */}
            <div
              role="separator"
              aria-label="Resize panels"
              aria-orientation="vertical"
              tabIndex={0}
              className={cn(
                "w-px bg-border cursor-col-resize hover:bg-primary/50 active:bg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary relative before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']",
                isDragging && "bg-primary",
              )}
              onMouseDown={handleResizerMouseDown}
              onKeyDown={handleResizerKeyDown}
            />
            <EditorPane
              isMobile={false}
              showTreeOnMobile={showTreeOnMobile}
              onShowTree={() => setShowTreeOnMobile(true)}
              selectedFile={selectedFile}
              selectedFileData={selectedFileData}
              editorContent={editorContent}
              isDirty={isDirty}
              language={language}
              monacoTheme={monacoTheme}
              isLoading={fileContentQuery.isLoading}
              isSaving={saveMutation.isPending}
              onEditorChange={(v) => {
                setEditorContent(v ?? "");
                setIsDirty(true);
              }}
              onSave={() => void handleSave()}
              onDownload={handleDownload}
              onDelete={(path) => setDeleteTarget({ path, isDirectory: false })}
              onUploadClick={() => fileInputRef.current?.click()}
            />
          </>
        )}

        {/* Delete confirmation dialog */}
        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {deleteTarget?.isDirectory ? "Folder" : "File"}?</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget?.isDirectory
                  ? `This will delete the folder "${deleteTarget.path.split("/").pop()}" and all its contents.`
                  : `This will permanently delete "${deleteTarget?.path.split("/").pop()}".`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => void handleDelete()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </FileTreeContext.Provider>
  );
}
