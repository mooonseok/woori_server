import { ValidateBy, type ValidationOptions } from 'class-validator';

export function trimText(value: unknown) {
  return typeof value === 'string' ? value.trim() : value;
}
// Length is counted in Unicode code points, matching PostgreSQL varchar limits.
// Control characters, unpaired surrogates and bidirectional embedding/override/
// isolate controls (U+202A-U+202E, U+2066-U+2069, which can visually reorder text
// in operator screens) are rejected. Only multiline text may keep tab, line feed
// and carriage return; single-line text also rejects U+2028/U+2029 separators.
const MULTILINE_FORBIDDEN =
  /(?![\t\n\r])[\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]/u;
const SINGLE_LINE_FORBIDDEN =
  /[\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069\u2028\u2029]/u;
export function isPlainText(
  value: unknown,
  minLength: number,
  maxLength: number,
  multiline: boolean
): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  if (length < minLength || length > maxLength) return false;
  return !(multiline ? MULTILINE_FORBIDDEN : SINGLE_LINE_FORBIDDEN).test(value);
}
export function IsPlainText(
  minLength: number,
  maxLength: number,
  multiline: boolean,
  options?: ValidationOptions
) {
  return ValidateBy(
    {
      name: 'isPlainText',
      constraints: [minLength, maxLength, multiline],
      validator: {
        validate: (value) =>
          isPlainText(value, minLength, maxLength, multiline),
        defaultMessage: (args) =>
          `${args?.property ?? 'value'} must be ${minLength}-${maxLength} characters after trimming without control characters`,
      },
    },
    options
  );
}
