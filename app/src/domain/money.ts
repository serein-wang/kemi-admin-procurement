import { DomainError } from "./errors.js";

/**
 * 金额用十进制字符串保存（docs/06：decimal）。
 * 比较时换算成 1/100 的整数，只为避免二进制浮点；不是业务阈值，也不是币种政策。
 */
const SCALE = 100n;

export function parseAmount(raw: string): bigint {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new DomainError("INVALID_AMOUNT", `金额格式无效：${raw}`);
  }
  const [whole, frac = ""] = text.split(".");
  const fracPadded = `${frac}00`.slice(0, 2);
  return BigInt(whole) * SCALE + BigInt(fracPadded);
}

export function formatAmount(minor: bigint): string {
  if (minor < 0n) {
    throw new DomainError("INVALID_AMOUNT", "金额不能为负");
  }
  const whole = minor / SCALE;
  const frac = (minor % SCALE).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}`;
}

export function compareAmount(left: string, right: string): number {
  const delta = parseAmount(left) - parseAmount(right);
  if (delta < 0n) return -1;
  if (delta > 0n) return 1;
  return 0;
}

export function addAmount(left: string, right: string): string {
  return formatAmount(parseAmount(left) + parseAmount(right));
}

/** 数量按正整数。单价必须大于 0。 */
export function lineAmount(qty: number, unitPrice: string): string {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new DomainError("INVALID_QTY", "数量必须为正整数");
  }
  if (compareAmount(unitPrice, "0.00") <= 0) {
    throw new DomainError("INVALID_AMOUNT", "单价必须大于 0");
  }
  return formatAmount(parseAmount(unitPrice) * BigInt(qty));
}
