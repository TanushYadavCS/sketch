import { type PhoneCountryCode, formatPhoneNumberNationalInput, getSupportedPhoneCountries } from "@sketch/shared";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { useMemo } from "react";

interface PhoneNumberFieldProps {
  id: string;
  label: string;
  country: PhoneCountryCode;
  nationalNumber: string;
  onCountryChange: (country: PhoneCountryCode) => void;
  onNationalNumberChange: (nationalNumber: string) => void;
  disabled?: boolean;
  error?: string;
  helperText?: string;
}

function getCountryName(country: PhoneCountryCode): string {
  const displayNames =
    typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
  return displayNames?.of(country) ?? country;
}

export function PhoneNumberField({
  id,
  label,
  country,
  nationalNumber,
  onCountryChange,
  onNationalNumberChange,
  disabled = false,
  error,
  helperText,
}: PhoneNumberFieldProps) {
  const countries = useMemo(
    () =>
      getSupportedPhoneCountries()
        .map((option) => ({
          ...option,
          label: getCountryName(option.country),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );

  const handleNumberChange = (value: string) => {
    onNationalNumberChange(formatPhoneNumberNationalInput(value, country));
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Select value={country} onValueChange={(value) => onCountryChange(value as PhoneCountryCode)}>
          <SelectTrigger aria-label={`${label} country`} className="w-40 shrink-0" disabled={disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {countries.map((option) => (
              <SelectItem key={option.country} value={option.country}>
                {option.label} +{option.callingCode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id={id}
          type="tel"
          inputMode="tel"
          value={nationalNumber}
          onChange={(event) => handleNumberChange(event.target.value)}
          placeholder="98765 43210"
          disabled={disabled}
        />
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : helperText ? (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      ) : null}
    </div>
  );
}
