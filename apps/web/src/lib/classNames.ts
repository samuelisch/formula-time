// Joins CSS module class names, skipping any falsy ones -- shared by every
// component that builds a className from optional pieces (a caller override,
// a selected/gain/loss modifier, ...).
export function cx(...classNames: Array<string | false | null | undefined>): string {
  return classNames.filter((className): className is string => Boolean(className)).join(" ");
}
