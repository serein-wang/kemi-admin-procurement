import { DomainError } from "./errors.js";

/** 走查贴图上限。与页面文案保持一致。 */
export const MAX_LINE_IMAGES = 4;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export interface DecodedLineImage {
  mime: ImageMime;
  name: string;
  bytes: Buffer;
}

const MIME_SET = new Set<string>(IMAGE_MIMES);
const DATA_PREFIX = "data:";
const BASE64_MARK = ";base64,";
const MAX_DATA_URL_CHARS =
  "data:image/webp;base64,".length + 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/**
 * 把请购行上的 data URL 贴图解成字节。
 * 只接受 png / jpeg / gif / webp，并核对文件头。拒绝 SVG 与 HTML。
 */
export function decodeLineImages(raw: unknown): DecodedLineImage[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new DomainError("INVALID_INPUT", "贴图格式不正确");
  }
  if (raw.length > MAX_LINE_IMAGES) {
    throw new DomainError("INVALID_INPUT", `每行最多 ${MAX_LINE_IMAGES} 张贴图`);
  }
  return raw.map((item) => decodeOne(item));
}

export function imageExtension(mime: ImageMime): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  return "png";
}

function decodeOne(item: unknown): DecodedLineImage {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new DomainError("INVALID_INPUT", "贴图格式不正确");
  }
  const record = item as { name?: unknown; dataUrl?: unknown };
  if (typeof record.dataUrl !== "string") {
    throw new DomainError("INVALID_INPUT", "贴图需要 data URL");
  }
  const dataUrl = record.dataUrl.trim();
  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    throw new DomainError("INVALID_INPUT", "单张贴图不能超过 2MB");
  }
  if (!dataUrl.startsWith(DATA_PREFIX)) {
    throw new DomainError("INVALID_INPUT", "贴图仅支持 png、jpeg、gif、webp 的 data URL");
  }
  const markAt = dataUrl.indexOf(BASE64_MARK);
  if (markAt <= DATA_PREFIX.length || markAt > 64) {
    throw new DomainError("INVALID_INPUT", "贴图仅支持 png、jpeg、gif、webp 的 data URL");
  }
  const mime = dataUrl.slice(DATA_PREFIX.length, markAt);
  if (!MIME_SET.has(mime)) {
    throw new DomainError("INVALID_INPUT", "贴图仅支持 png、jpeg、gif、webp 的 data URL");
  }
  const payload = dataUrl.slice(markAt + BASE64_MARK.length).replace(/[\r\n\t ]/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new DomainError("INVALID_INPUT", "贴图 data URL 不是合法的 base64");
  }
  if (payload.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) {
    throw new DomainError("INVALID_INPUT", "单张贴图不能超过 2MB");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < 8 || bytes.length > MAX_IMAGE_BYTES) {
    throw new DomainError("INVALID_INPUT", "单张贴图不能超过 2MB");
  }
  const imageMime = mime as ImageMime;
  if (!matchesMagic(imageMime, bytes)) {
    throw new DomainError("INVALID_INPUT", "贴图内容与类型不符");
  }
  return { mime: imageMime, name: cleanImageName(record.name), bytes };
}

function cleanImageName(raw: unknown): string {
  const source = typeof raw === "string" ? raw : "";
  const cleaned = source
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[<>"'`\\/]/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || "image";
}

function matchesMagic(mime: ImageMime, bytes: Buffer): boolean {
  if (mime === "image/png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mime === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/gif") {
    return (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61
    );
  }
  return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}
