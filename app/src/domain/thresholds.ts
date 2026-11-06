import { DomainError } from "./errors.js";
import { compareAmount } from "./money.js";

/**
 * 审批矩阵占位符（docs/05）。
 * 值只能来自配置注入。null 表示仍是占位，禁止在这里写业务金额。
 */
export const THRESHOLD_KEYS = [
  "THR_CNY_FIN",
  "THR_CNY_CEO",
  "THR_HKD_FIN",
  "THR_HKD_CEO",
  "THR_CNY_RFQ",
  "THR_HKD_RFQ",
  "THR_CNY_CAPEX",
  "THR_HKD_CAPEX",
  "THR_CNY_PREPAY_FIN",
  "THR_CNY_PREPAY_CEO",
  "THR_HKD_PREPAY_FIN",
  "THR_HKD_PREPAY_CEO",
  "THR_CNY_PREPAY_CONTRACT",
  "THR_HKD_PREPAY_CONTRACT",
  "THR_CNY_REIM",
  "THR_HKD_REIM",
] as const;

export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];
export type ThresholdConfig = Record<ThresholdKey, string | null>;
export type CurrencyCode = "CNY" | "HKD";
export type ThresholdKind = "fin" | "ceo" | "rfq" | "capex";

/**
 * Q4：同一套角色逻辑，SZ 与 HK 各用一张阈值表。
 * 公司代码决定币种，两套数字独立注入，空值仍是占位。
 */
export function currencyForCompany(companyCode: "SZ" | "HK"): CurrencyCode {
  return companyCode === "SZ" ? "CNY" : "HKD";
}

export function companyForCurrency(currency: CurrencyCode): "SZ" | "HK" {
  return currency === "CNY" ? "SZ" : "HK";
}

export function emptyThresholds(): ThresholdConfig {
  return {
    THR_CNY_FIN: null,
    THR_CNY_CEO: null,
    THR_HKD_FIN: null,
    THR_HKD_CEO: null,
    THR_CNY_RFQ: null,
    THR_HKD_RFQ: null,
    THR_CNY_CAPEX: null,
    THR_HKD_CAPEX: null,
    THR_CNY_PREPAY_FIN: null,
    THR_CNY_PREPAY_CEO: null,
    THR_HKD_PREPAY_FIN: null,
    THR_HKD_PREPAY_CEO: null,
    THR_CNY_PREPAY_CONTRACT: null,
    THR_HKD_PREPAY_CONTRACT: null,
    THR_CNY_REIM: null,
    THR_HKD_REIM: null,
  };
}

/**
 * 预付政策里的非金额开关（Q9 / Q10）。
 * 比例空着就是未配置。全额预付默认关闭。继承请购矩阵默认关闭。
 */
export interface PrepayPolicy {
  ratioMax: string | null;
  allowFullPrepay: boolean;
  inheritPrMatrix: boolean;
  /** Q11。null 表示 PREPAY_OVERDUE_DAYS 仍是占位，不套默认天数。 */
  overdueDays: number | null;
}

export function emptyPrepayPolicy(): PrepayPolicy {
  return { ratioMax: null, allowFullPrepay: false, inheritPrMatrix: false, overdueDays: null };
}

export type PrepayThresholdKind = "fin" | "ceo" | "contract";

export function prepayThresholdKey(currency: CurrencyCode, kind: PrepayThresholdKind): ThresholdKey {
  const suffix = kind === "fin" ? "PREPAY_FIN" : kind === "ceo" ? "PREPAY_CEO" : "PREPAY_CONTRACT";
  return `THR_${currency}_${suffix}`;
}

/** D5。低额 < THR_*_REIM；达到该额为超额，须 ②-7。 */
export function reimburseThresholdKey(currency: CurrencyCode): ThresholdKey {
  return `THR_${currency}_REIM`;
}

export function thresholdKey(currency: CurrencyCode, kind: ThresholdKind): ThresholdKey {
  const suffix = kind === "fin" ? "FIN" : kind === "ceo" ? "CEO" : kind === "rfq" ? "RFQ" : "CAPEX";
  return `THR_${currency}_${suffix}`;
}

export type ApprovalBand = "low" | "mid" | "high";

/** 低额 < FIN；中额 FIN ≤ x < CEO；高额 ≥ CEO。 */
export function approvalBand(
  amount: string,
  thrFin: string,
  thrCeo: string,
  finKey: string,
  ceoKey: string,
): ApprovalBand {
  if (compareAmount(thrFin, thrCeo) >= 0) {
    throw new DomainError("THRESHOLD_CONFIG_INVALID", `${finKey} 必须小于 ${ceoKey}`, 422);
  }
  if (compareAmount(amount, thrCeo) >= 0) return "high";
  if (compareAmount(amount, thrFin) >= 0) return "mid";
  return "low";
}
