import type { PipeTransform } from "@nestjs/common";
import { z } from "zod";
import type { ErrorCode, Issue } from "@kabuki-neko/shared/errors";
import { ApiError } from "./error.filter";

/** Route schemas use strictObject, including nested objects and query filters. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}
  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const details: Issue[] = result.error.issues.slice(0, 200).map((issue) => {
      let code: ErrorCode = "INVALID_FORMAT";
      if (issue.code === "invalid_type") code = "INVALID_TYPE";
      if (issue.code === "invalid_value") code = "INVALID_ENUM";
      if (issue.code === "too_small" || issue.code === "too_big") code = "OUT_OF_RANGE";
      // Unknown field names and parser messages are user input, not safe diagnostics.
      return { path: issue.path.map(String).join("."), code, params: {}, severity: "error" };
    });
    throw new ApiError("VALIDATION_FAILED", 422, {}, details);
  }
}
