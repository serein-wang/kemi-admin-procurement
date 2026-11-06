import type { Role } from "../domain/roles.js";

/** 本地走查用的泳道账号。uc_user_id 是假的，只在 ALLOW_DEV_LOGIN 时能建立会话。 */
export const DEMO_USERS: Array<{ ucUserId: string; displayName: string; roles: Role[] }> = [
  { ucUserId: "uc-applicant", displayName: "申请人甲", roles: ["applicant"] },
  { ucUserId: "uc-dept", displayName: "部门负责人乙", roles: ["dept"] },
  { ucUserId: "uc-admin", displayName: "行政专员丙", roles: ["admin"] },
  { ucUserId: "uc-finance", displayName: "财务丁", roles: ["finance"] },
  { ucUserId: "uc-ceo", displayName: "总经理戊", roles: ["ceo"] },
  { ucUserId: "uc-cashier", displayName: "出纳己", roles: ["cashier"] },
];
