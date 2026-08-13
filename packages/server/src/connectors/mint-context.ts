export interface MintContextBlock {
  key: string;
  label: string;
  selection: string;
  total: number;
  items: string[];
  truncated?: boolean;
  via: "prompt" | "tool";
}
