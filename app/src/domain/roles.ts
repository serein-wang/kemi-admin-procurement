/** 应用内泳道。OIDC 不提供这些角色（docs/01、docs/08）。 */
export const ROLES = ["applicant", "dept", "admin", "finance", "ceo", "cashier"] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
