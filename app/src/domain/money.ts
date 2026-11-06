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

export function subtractAmount(left: string, right: string): string {
  const delta = parseAmount(left) - parseAmount(right);
  if (delta < 0n) {
    throw new DomainError("INVALID_AMOUNT", "金额差额为负");
  }
  return formatAmount(delta);
}

/** 比例用万分位整数，避免浮点。只接受大于 0 且不超过 1。 */
export function parseRatio(raw: string): bigint {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(text)) {
    throw new DomainError("INVALID_RATIO", `比例格式无效：${raw}`);
  }
  const [whole, frac = ""] = text.split(".");
  const fracPadded = `${frac}0000`.slice(0, 4);
  const value = BigInt(whole) * 10000n + BigInt(fracPadded);
  if (value <= 0n || value > 10000n) {
    throw new DomainError("INVALID_RATIO", "比例必须大于 0 且不超过 1");
  }
  return value;
}

export function withinRatio(part: string, whole: string, ratio: string): boolean {
  return parseAmount(part) * 10000n <= parseAmount(whole) * parseRatio(ratio);
}

/** 展示用，截断到四位小数。 */
export function formatRatio(part: string, whole: string): string {
  const denominator = parseAmount(whole);
  if (denominator === 0n) {
    throw new DomainError("INVALID_AMOUNT", "不能对 0 金额计算比例");
  }
  const digits = (parseAmount(part) * 10000n) / denominator;
  const wholePart = digits / 10000n;
  const frac = (digits % 10000n).toString().padStart(4, "0");
  return `${wholePart.toString()}.${frac}`;
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
