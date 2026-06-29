const CODE_SUFFIX_RE =
  /(Dto|Dtos|Request|Response|Entity|Repository|Controller|Service|Impl|Component|Model|Schema|Enum|Interface|Handler|Mapper|Config|Util|Utils)$/i;
const CODE_PUNCTUATION_RE = /_|\.|::|\(|\)|<|>|;/;
const HYPHENATED_CODE_TOKEN_RE = /^[a-z0-9]+(-[a-z0-9]+){2,}$/;
const CONSTANT_TOKEN_RE = /^[A-Z0-9_]{4,}$/;

export function isCodeShapedFeatureName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return (
    CODE_SUFFIX_RE.test(trimmed) ||
    CODE_PUNCTUATION_RE.test(trimmed) ||
    HYPHENATED_CODE_TOKEN_RE.test(trimmed) ||
    CONSTANT_TOKEN_RE.test(trimmed)
  );
}
