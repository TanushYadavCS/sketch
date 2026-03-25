import { CaretDownIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
/**
 * SearchBar — search input with keyword search and refinement filter dropdowns.
 * All filter state lives in the parent (FilesPage) and is passed down as props.
 */
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";

export function SearchBar({
  search,
  onSearchChange,
  typeFilter,
  accessFilter,
  statusFilter,
  onTypeChange,
  onAccessChange,
  onStatusChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  typeFilter: string | null;
  accessFilter: string | null;
  statusFilter: string | null;
  onTypeChange: (value: string | null) => void;
  onAccessChange: (value: string | null) => void;
  onStatusChange: (value: string | null) => void;
}) {
  return (
    <div className="mt-4 flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search files..."
          className="pl-9 text-sm"
        />
      </div>

      <FilterDropdown
        label="Type"
        value={typeFilter === "document" ? "Documents" : typeFilter === "structured" ? "Data" : null}
        options={[
          { value: "document", label: "Documents" },
          { value: "structured", label: "Data" },
        ]}
        onChange={onTypeChange}
      />

      <FilterDropdown
        label="Access"
        value={accessFilter === "restricted" ? "Restricted" : accessFilter === "unrestricted" ? "Open" : null}
        options={[
          { value: "restricted", label: "Restricted" },
          { value: "unrestricted", label: "Open" },
        ]}
        onChange={onAccessChange}
      />

      <FilterDropdown
        label="Status"
        value={statusFilter === "enriched" ? "Enriched" : statusFilter === "raw" ? "Raw" : null}
        options={[
          { value: "raw", label: "Raw" },
          { value: "enriched", label: "Enriched" },
        ]}
        onChange={onStatusChange}
      />
    </div>
  );
}

function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  if (value) {
    return (
      <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => onChange(null)}>
        {value}
        <XIcon size={10} className="text-muted-foreground" />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
          {label}
          <CaretDownIcon size={12} className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((opt) => (
          <DropdownMenuItem key={opt.value} onClick={() => onChange(opt.value)}>
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
