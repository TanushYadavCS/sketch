import {
  DownloadSimpleIcon,
  FileTextIcon,
  FloppyDiskIcon,
  FolderOpenIcon,
  TrashIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import type { FileMetadata } from "@sketch/shared";
/**
 * Editor pane — Monaco editor with toolbar, loading skeleton, and error boundary.
 */
import { Button } from "@sketch/ui/components/button";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sketch/ui/components/tooltip";
import { formatFileSize } from "@sketch/ui/lib/utils";
import { Component, Suspense, lazy } from "react";
import { FileIconComponent } from "./utils";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

const MAX_FILE_SIZE_MB = 1;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// ── Error boundary for Monaco ──────────────────────────────────────────────

class EditorErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <p className="text-muted-foreground mb-4">Editor crashed. Click to retry.</p>
          <Button onClick={() => this.setState({ hasError: false })}>Retry</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Loading skeleton ───────────────────────────────────────────────────────

function EditorSkeleton() {
  return (
    <div className="p-4 space-y-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

// ── Editor pane ────────────────────────────────────────────────────────────

export interface EditorPaneProps {
  isMobile: boolean;
  showTreeOnMobile: boolean;
  onShowTree: () => void;
  selectedFile: string | null;
  selectedFileData: FileMetadata | undefined;
  editorContent: string | null;
  isDirty: boolean;
  language: string;
  monacoTheme: string;
  isLoading: boolean;
  isSaving: boolean;
  onEditorChange: (value: string | undefined) => void;
  onSave: () => void;
  onDownload: (path: string) => void;
  onDelete: (path: string) => void;
  onUploadClick: () => void;
}

export function EditorPane({
  isMobile,
  showTreeOnMobile,
  onShowTree,
  selectedFile,
  selectedFileData,
  editorContent,
  isDirty,
  language,
  monacoTheme,
  isLoading,
  isSaving,
  onEditorChange,
  onSave,
  onDownload,
  onDelete,
  onUploadClick,
}: EditorPaneProps) {
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background">
      {isMobile && !showTreeOnMobile && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
          <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={onShowTree}>
            <FolderOpenIcon size={14} />
            Files
          </Button>
        </div>
      )}
      {selectedFile ? (
        <>
          {/* Toolbar */}
          <div className="flex items-center justify-between px-4 border-b border-border h-11">
            <div className="flex items-center gap-2 min-w-0">
              <FileIconComponent fileName={selectedFile.split("/").pop() || ""} isDirectory={false} />
              <span className="font-medium text-sm truncate">
                {selectedFile.split("/").pop()}
                {isDirty && <span className="text-warning ml-1">●</span>}
              </span>
              {selectedFileData && (
                <span className="text-xs text-muted-foreground">({formatFileSize(selectedFileData.size)})</span>
              )}
            </div>
            <div className="flex gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={isDirty ? "default" : "ghost"}
                      size="icon"
                      className="h-8 w-8"
                      onClick={onSave}
                      disabled={!isDirty || isSaving}
                    >
                      <FloppyDiskIcon size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{isSaving ? "Saving..." : "Save"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDownload(selectedFile)}>
                      <DownloadSimpleIcon size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Download</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => onDelete(selectedFile)}
                    >
                      <TrashIcon size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {/* Editor area */}
          <div className="flex-1 overflow-hidden">
            {selectedFileData && selectedFileData.size > MAX_FILE_SIZE_BYTES ? (
              <div className="flex flex-col items-center justify-center h-full p-8 text-center">
                <p className="text-muted-foreground mb-4">
                  This file is too large to edit ({formatFileSize(selectedFileData.size)})
                </p>
                <Button onClick={() => onDownload(selectedFile)}>
                  <DownloadSimpleIcon size={16} className="mr-2" />
                  Download to edit locally
                </Button>
              </div>
            ) : selectedFileData && !selectedFileData.isEditable ? (
              <div className="flex flex-col items-center justify-center h-full p-8 text-center">
                <p className="text-muted-foreground mb-4">Binary files cannot be edited in the browser</p>
                <Button onClick={() => onDownload(selectedFile)}>
                  <DownloadSimpleIcon size={16} className="mr-2" />
                  Download file
                </Button>
              </div>
            ) : isLoading ? (
              <EditorSkeleton />
            ) : (
              <EditorErrorBoundary>
                <Suspense fallback={<EditorSkeleton />}>
                  <MonacoEditor
                    loading={null}
                    value={editorContent ?? ""}
                    language={language}
                    onChange={onEditorChange}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 14,
                      lineNumbers: "on",
                      lineNumbersMinChars: 3,
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                      wordWrap: "on",
                    }}
                    theme={monacoTheme}
                  />
                </Suspense>
              </EditorErrorBoundary>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="rounded-full bg-muted p-4 mb-4">
            <FileTextIcon size={32} className="text-muted-foreground" />
          </div>
          <h3 className="font-medium mb-2">Select a file to view or edit</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md">
            Choose a file from the sidebar to start editing, or upload a new file to get started.
          </p>
          <Button onClick={onUploadClick}>
            <UploadSimpleIcon size={16} className="mr-2" />
            Upload File
          </Button>
        </div>
      )}
    </div>
  );
}
