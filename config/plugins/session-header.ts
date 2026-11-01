import type { Plugin } from "@opencode-ai/plugin"

const SOURCE_TYPE_HEADER = "X-Source-Type"
const SOURCE_TYPE_METADATA_KEY = "source_type"
const REQUEST_GROUP_HEADER = "X-Group-Id"
const REQUEST_GROUP_TIMEOUT_MS = 6_000

// Keep these local: packaged OpenCode loads this file without workspace
// node_modules. Values mirror @hilo/protocol/workspace-identity.
const WORKSPACE_CLAIM_ENV = "HILO_WORKSPACE_CLAIM"
const WORKSPACE_INSTANCE_ENV = "HILO_WORKSPACE_INSTANCE_ID"
const WORKSPACE_GENERATION_ENV = "HILO_WORKSPACE_GENERATION"
const MANAGED_RUNTIME_ENV = "HILO_MANAGED_RUNTIME"
const WORKSPACE_CLAIM_HEADER = "x-hilo-workspace"
const WORKSPACE_INSTANCE_HEADER = "x-hilo-workspace-instance"
const WORKSPACE_GENERATION_HEADER = "x-hilo-workspace-generation"

interface RequestGroupResponse {
  mode: "canonical" | "legacy" | "unknown"
  groupId: string | null
}

function gatewayIdentityHeaders(): Headers {
  const headers = new Headers()
  const claim = process.env[WORKSPACE_CLAIM_ENV]?.trim()
  if (!claim) return headers

  headers.set(WORKSPACE_CLAIM_HEADER, claim)
  const instanceId = process.env[WORKSPACE_INSTANCE_ENV]?.trim()
  const generation = Number(process.env[WORKSPACE_GENERATION_ENV])
  if (instanceId && Number.isSafeInteger(generation) && generation > 0) {
    headers.set(WORKSPACE_INSTANCE_HEADER, instanceId)
    headers.set(WORKSPACE_GENERATION_HEADER, String(generation))
  }
  return headers
}

function mapRequestGroupResponse(body: unknown): RequestGroupResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { mode: "unknown", groupId: null }
  }

  const record = body as Record<string, unknown>
  const rawGroupId = record.group_id
  const groupId =
    typeof rawGroupId === "string" && /^[1-9]\d*$/.test(rawGroupId)
      ? rawGroupId
      : null

  if (record.mode === "canonical") {
    return groupId
      ? { mode: "canonical", groupId }
      : { mode: "unknown", groupId: null }
  }
  if (record.mode === "legacy") {
    return groupId
      ? { mode: "unknown", groupId: null }
      : { mode: "legacy", groupId: null }
  }
  if (record.mode === "unknown") return { mode: "unknown", groupId: null }

  return { mode: "unknown", groupId: null }
}

async function resolveRequestGroup(
  gatewayUrl: string,
  sessionID: string | undefined,
): Promise<RequestGroupResponse> {
  const baseUrl = gatewayUrl.replace(/\/+$/, "")
  const path = sessionID
    ? `/api/internal/sessions/${encodeURIComponent(sessionID)}/request-group`
    : "/api/internal/sessions/billing-current-scope"
  const response = await fetch(`${baseUrl}${path}`, {
    headers: gatewayIdentityHeaders(),
    signal: AbortSignal.timeout(REQUEST_GROUP_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`gateway returned HTTP ${response.status}`)
  }
  return mapRequestGroupResponse(await response.json())
}

function sourceTypeFromParts(parts: unknown[]): string | undefined {
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue

    const candidate = part as { type?: unknown; metadata?: unknown }
    if (candidate.type !== "text") continue
    if (typeof candidate.metadata !== "object" || candidate.metadata === null) continue

    const sourceType = (candidate.metadata as Record<string, unknown>)[
      SOURCE_TYPE_METADATA_KEY
    ]
    if (typeof sourceType === "string" && sourceType.length > 0) return sourceType
  }
}

const plugin: Plugin = async () => {
  const sourceTypeByMessage = new Map<string, string>()
  const gatewayUrl = process.env.GATEWAY_URL?.trim()
  const isManagedRuntime = process.env[MANAGED_RUNTIME_ENV] === "1"

  return {
    "chat.message": async (_ctx, output) => {
      const sourceType = sourceTypeFromParts(output.parts)
      if (sourceType) sourceTypeByMessage.set(output.message.id, sourceType)
    },
    "chat.headers": async (ctx, output) => {
      // OpenCode 在新 session 首条请求时,偶发顶层 ctx.sessionID 为空字符串,
      // 导致 HTTP client 序列化时跳过空 header,云端拿不到 X-OpenCode-Session-Id。
      // fallback 链:顶层 sessionID → message 内部 sessionID → message.id → 时间戳占位,
      // 确保 header 永远有非空值。
      const sessionID =
        ctx.sessionID ||
        ctx.message?.sessionID ||
        ctx.message?.id ||
        `pending-${Date.now()}`

      output.headers["X-OpenCode-Session-Id"] = sessionID

      // Consume the one-shot telemetry marker before request-Group resolution:
      // that lookup may fail closed, and leaving cleanup below the throwing
      // path would retain one entry for every rejected message during a local
      // gateway outage.
      const messageID = ctx.message?.id
      if (messageID) {
        const sourceType = sourceTypeByMessage.get(messageID)
        sourceTypeByMessage.delete(messageID)
        if (sourceType) output.headers[SOURCE_TYPE_HEADER] = sourceType
      }

      // Standalone OpenCode auto-discovers project-local plugins but has no
      // MiniMax Hub Group selection to resolve. Only Hub-managed runtimes (or
      // explicit standalone GATEWAY_URL users) must apply this billing guard.
      // Billing attribution must not depend exclusively on
      // @hilo/opencode-plugin-hilo: a damaged/missing business-plugin bundle
      // otherwise leaves OpenCode's direct text-model request unscoped while
      // media MCP submit uses the selected Group. This foundational plugin is
      // packaged separately, resolves the immutable turn scope from the local
      // gateway, and fails closed unless the gateway explicitly vouches for a
      // legacy no-Group request.
      if (gatewayUrl || isManagedRuntime) {
        try {
          if (!gatewayUrl) throw new Error("GATEWAY_URL is not set")
          const requestGroupSessionID = ctx.sessionID || ctx.message?.sessionID
          const requestGroup = await resolveRequestGroup(
            gatewayUrl,
            requestGroupSessionID,
          )
          if (requestGroup.mode === "canonical" && requestGroup.groupId) {
            output.headers[REQUEST_GROUP_HEADER] = requestGroup.groupId
          } else if (requestGroup.mode !== "legacy") {
            throw new Error("gateway returned an unresolved billing scope")
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          console.warn(
            `[session-header] request Group resolution failed` +
              ` session=${ctx.sessionID || "<pending>"} detail=${detail}`,
          )
          // OpenCode >= 1.18 classifies any error containing "unavailable" as a
          // retryable provider overload. Keep this fail-closed error non-retryable
          // so a local gateway/configuration failure is surfaced immediately.
          throw new Error(
            `REQUEST_GROUP_REQUIRED: refusing to send an unscoped model request` +
              ` (session=${ctx.sessionID || "<pending>"}). Ensure the MiniMax Hub gateway is ready, then resend the message.`,
          )
        }
      }

      const agent = ctx.agent as unknown
      if (typeof agent === "object" && agent !== null) {
        const name = (agent as { name?: unknown }).name
        if (typeof name === "string" && name.length > 0) {
          output.headers["X-Agent-Type"] = name
        }
      }

    },
  }
}

export default plugin
