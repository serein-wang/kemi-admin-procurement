/** 业务拒绝。httpStatus 由 HTTP 适配层原样返回，不把堆栈给客户端。 */
export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly sodViolationCode?: "S1" | "S2" | "S3";

  constructor(
    code: string,
    message: string,
    httpStatus = 400,
    sodViolationCode?: "S1" | "S2" | "S3",
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.sodViolationCode = sodViolationCode;
  }
}
