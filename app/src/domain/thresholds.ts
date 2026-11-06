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
] as const;

export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];
export type ThresholdConfig = Record<ThresholdKey, string | null>;
export type CurrencyCode = "CNY" | "HKD";
export type ThresholdKind = "fin" | "ceo" | "rfq" | "capex";

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
  };
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
