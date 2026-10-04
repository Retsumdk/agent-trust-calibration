export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "CORRUPTION"
  | "CONFIG";

export class TrustError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "TrustError";
    this.code = code;
  }

  get httpStatus(): number {
    switch (this.code) {
      case "VALIDATION":
        return 400;
      case "NOT_FOUND":
        return 404;
      case "CONFLICT":
        return 409;
      case "UNAUTHORIZED":
        return 401;
      case "CORRUPTION":
        return 500;
      case "CONFIG":
        return 500;
    }
  }
}

/** Thrown when the audit ledger fails chain or hash verification. */
export class CorruptionError extends TrustError {
  constructor(message: string) {
    super("CORRUPTION", message);
    this.name = "CorruptionError";
  }
}
