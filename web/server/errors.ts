/**
 * Domain errors with a stable code the browser can branch on.
 *
 * The transport (web/src/host/transport.ts) reads `{ error: { code, message } }`
 * out of a non-2xx body, so "wrong password" stays distinguishable from "the
 * server fell over" -- which matters, because one of those is worth showing the
 * user a prompt for and the other is not.
 */
export type SheetsErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'session_gone'
  | 'session_elsewhere'
  | 'password_required'
  | 'password_incorrect'
  | 'version_conflict'
  | 'quota_exceeded'
  | 'invalid_request'
  | 'not_implemented'
  | 'sidecar_failed'
  /** Anything we did not classify. Never used as a fallback label for others. */
  | 'internal'

const STATUS: Record<SheetsErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  // Gone, not 404: the document exists, the *session* does not. The client's
  // correct response is to reopen, which is not what it does for a 404.
  session_gone: 410,
  // 421 Misdirected Request, which is exactly what this is: the request is
  // well formed and this server cannot produce a response for it, because the
  // workbook it names is open on a different one.
  session_elsewhere: 421,
  password_required: 428,
  password_incorrect: 403,
  version_conflict: 409,
  quota_exceeded: 429,
  invalid_request: 400,
  not_implemented: 501,
  sidecar_failed: 500,
  internal: 500,
}

export class SheetsError extends Error {
  readonly code: SheetsErrorCode
  readonly status: number
  /** Extra fields serialized alongside the error, e.g. the current version. */
  readonly detail: Record<string, unknown> | undefined

  constructor(code: SheetsErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'SheetsError'
    this.code = code
    this.status = STATUS[code]
    this.detail = detail
  }
}

export class VersionConflictError extends SheetsError {
  constructor(currentVersion: string) {
    super('version_conflict', 'The document changed since this session opened it.', {
      currentVersion,
    })
    this.name = 'VersionConflictError'
  }
}

/**
 * Zod is resolved from the repo root by upstream's schema module, and this
 * package deliberately does not install its own copy -- two zod instances
 * would make `instanceof ZodError` silently false. So detect structurally.
 */
export function isZodError(error: unknown): error is { issues: { message: string }[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  )
}

export function toSheetsError(error: unknown): SheetsError {
  if (error instanceof SheetsError) return error
  if (isZodError(error)) {
    const first = error.issues[0]?.message ?? 'Request failed validation.'
    return new SheetsError('invalid_request', first, { issues: error.issues })
  }
  // 'internal', not 'sidecar_failed'. An unclassified failure is not evidence
  // the sidecar failed -- a blocked path traversal in a storage adapter came
  // back labelled as a spreadsheet-engine fault, which points whoever reads it
  // at the wrong component entirely.
  const message = error instanceof Error ? error.message : String(error)
  return new SheetsError('internal', message)
}
