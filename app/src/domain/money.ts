import { DomainError } from "./errors.js";

/**
 * 金额用十进制字符串保存（docs/06：decimal）。
 * 比较时换算成 1/100 的整数，只为避免二进制浮点；不是业务阈值，也不是币种政策。
 */
const SCALE = 100n;

/** 表单和 JSON 都可能把金额当成数字。数字不能走 trim，否则会 500。 */
function amountText(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (Object.is(raw, -0)) return "0";
    const text = String(raw);
    if (/e/i.test(text)) throw new DomainError("INVALID_AMOUNT", `金额格式无效：${text}`);
    return text;
  }
  throw new DomainError("INVALID_AMOUNT", "金额格式无效");
}

export function parseAmount(raw: unknown): bigint {
  const text = amountText(raw);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new DomainError("INVALID_AMOUNT", `金额格式无效：${text}`);
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
export function parseRatio(raw: unknown): bigint {
  let text: string;
  if (typeof raw === "string") text = raw.trim();
  else if (typeof raw === "number" && Number.isFinite(raw)) text = String(raw);
  else throw new DomainError("INVALID_RATIO", "比例格式无效");
  if (!/^\d+(\.\d{1,4})?$/.test(text)) {
    throw new DomainError("INVALID_RATIO", `比例格式无效：${text}`);
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

export function parseQty(qty: unknown): number {
  if (typeof qty === "number" && Number.isInteger(qty) && qty > 0 && qty <= 1_000_000) return qty;
  if (typeof qty === "string" && /^[1-9]\d{0,6}$/.test(qty.trim())) return Number(qty.trim());
  throw new DomainError("INVALID_QTY", "数量必须为正整数");
}

/** 数量按正整数。单价必须大于 0。数量和单价都可以是数字或数字字符串。 */
export function lineAmount(qty: unknown, unitPrice: unknown): string {
  const count = parseQty(qty);
  const price = parseAmount(unitPrice);
  if (price <= 0n) {
    throw new DomainError("INVALID_AMOUNT", "单价必须大于 0");
  }
  return formatAmount(price * BigInt(count));
}
