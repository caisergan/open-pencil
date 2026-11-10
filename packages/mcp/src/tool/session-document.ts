import { isPlainObject } from 'es-toolkit/predicate'

import type { RPCSender } from '#mcp/tool/registration'

/** Commands that act on the app as a whole or pick their own document, so take no default. */
const UNTARGETED_COMMANDS: ReadonlySet<string> = new Set([
  'list_documents',
  'list_recent_files',
  'agent_session_opened',
  'get_settings',
  'update_settings',
  'agent_session_closed',
  'open_file',
  'new_document'
])

/** Commands whose reply names the document the session now works in. */
const DOCUMENT_CHOOSING_COMMANDS: ReadonlySet<string> = new Set([
  'open_file',
  'new_document',
  'activate_document'
])

type Reply = { ok?: unknown; result?: unknown; target?: unknown; error?: unknown }

function readRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}

function replyDocumentId(reply: Reply): string | null {
  const id = readRecord(reply.target)?.documentId
  return typeof id === 'string' ? id : null
}

/**
 * Sends one MCP session's calls with the document it works in. Calls without a `document_id`
 * go to the document the session last opened, created, activated, or named, not to whichever
 * tab is in front: with several agents in one app, another agent's `open_file` changes that
 * tab, and these calls would land in its document. Before the session chooses a document,
 * calls go to the active tab as before.
 */
export function sendWithSessionDocument(send: RPCSender): RPCSender {
  let documentId: string | null = null

  return async (body) => {
    const command = typeof body.command === 'string' ? body.command : ''
    const args = readRecord(body.args) ?? {}
    const named = typeof args.document_id === 'string' ? args.document_id : null
    const targeted = !UNTARGETED_COMMANDS.has(command)
    const request =
      targeted && !named && documentId
        ? { ...body, args: { ...args, document_id: documentId } }
        : body

    const raw = await send(request)
    const reply: Reply | null = readRecord(raw)
    if (!reply) return raw
    if (reply.ok === false) {
      const pinned = request !== body ? documentId : null
      if (!pinned || reply.error !== `Document "${pinned}" not found`) return reply
      // The person closed the document; nothing else is a safe guess at where the call belongs.
      documentId = null
      return {
        ...reply,
        error: `${reply.error}: the document this session worked in was closed. Call list_documents and pass document_id.`
      }
    }

    const replied = replyDocumentId(reply)
    if (DOCUMENT_CHOOSING_COMMANDS.has(command) && replied) documentId = replied
    else if (named && targeted) documentId = named
    if (command === 'close_file' && readRecord(reply.result)?.closed === true) {
      if (replied === documentId) documentId = null
    }
    return reply
  }
}
