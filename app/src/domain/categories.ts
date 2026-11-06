import { DomainError } from "./errors.js";

/** 行政非生产品类。fixed_asset 强制走 ①-8a（Q3 品类强制建卡）。 */
export const ADMIN_CATEGORIES = ["fixed_asset", "consumable", "service", "low_value"] as const;

export type AdminCategory = (typeof ADMIN_CATEGORIES)[number];

/**
 * 生产轨品类。误入则拒绝，不写入单据，也不代调用生产采购。
 * docs/01：procurement_class 必须是 admin_non_production。
 */
export const PRODUCTION_CATEGORIES = [
  "production_material",
  "outsourced_processing",
  "bom_component",
] as const;

export function parseCategory(raw: string): AdminCategory {
  if ((PRODUCTION_CATEGORIES as readonly string[]).includes(raw)) {
    throw new DomainError(
      "PRODUCTION_CATEGORY_REJECTED",
      `品类 ${raw} 属于生产物料或委外，行政采购拒绝接收`,
      422,
    );
  }
  if (!(ADMIN_CATEGORIES as readonly string[]).includes(raw)) {
    throw new DomainError("UNKNOWN_CATEGORY", `未知品类 ${raw}`, 422);
  }
  return raw as AdminCategory;
}
