export function loginEquals(login: string | undefined, botUsername: string): boolean {
  return typeof login === "string" && login.toLowerCase() === botUsername.toLowerCase();
}

export function loginEqualsNonEmpty(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}
