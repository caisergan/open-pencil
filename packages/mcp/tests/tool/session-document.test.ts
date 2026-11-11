import { describe, expect, test } from 'bun:test'

import { isPlainObject } from 'es-toolkit/predicate'

import type { RPCSender } from '#mcp/tool/registration'
import { sendWithSessionDocument } from '#mcp/tool/session-document'

type Sent = { command: string; args: Record<string, unknown> }

/**
 * A stand-in app with tabs: `open_file` opens a new one and brings it forward, and a call
 * without `document_id` lands in the tab in front, as the app does.
 */
function fakeApp() {
  const open = new Set<string>(['tab-1'])
  let active = 'tab-1'
  let next = 2
  const sent: Sent[] = []
  const send: RPCSender = async (body) => {
    const command = String(body.command)
    const args: Record<string, unknown> = isPlainObject(body.args) ? body.args : {}
    sent.push({ command, args })
    if (command === 'list_documents') return { ok: true, result: { documents: [...open] } }
    if (command === 'open_file' || command === 'new_document') {
      const id = `tab-${next++}`
      open.add(id)
      active = id
      return { ok: true, result: {}, target: { documentId: id } }
    }
    const documentId = typeof args.document_id === 'string' ? args.document_id : active
    if (!open.has(documentId)) return { ok: false, error: `Document "${documentId}" not found` }
    if (command === 'close_file') {
      open.delete(documentId)
      return { ok: true, result: { closed: true }, target: { documentId } }
    }
    if (command === 'activate_document') active = documentId
    return { ok: true, result: {}, target: { documentId } }
  }
  return {
    send,
    sent,
    closeByHand: (id: string) => open.delete(id),
    lastDocument: () => sent.at(-1)?.args.document_id
  }
}

describe('MCP session document', () => {
  test('a session keeps working in the file it opened after another agent opens one', async () => {
    const app = fakeApp()
    const first = sendWithSessionDocument(app.send)
    const second = sendWithSessionDocument(app.send)

    const opened = (await first({ command: 'open_file', args: { path: '/a.fig' } })) as {
      target: { documentId: string }
    }
    await second({ command: 'open_file', args: { path: '/b.fig' } })
    const reply = await first({ command: 'tool', args: { name: 'create_shape', args: {} } })

    expect(app.lastDocument()).toBe(opened.target.documentId)
    expect(reply).toMatchObject({ target: { documentId: opened.target.documentId } })
  })

  test('a document the session names or activates becomes its default', async () => {
    const app = fakeApp()
    const session = sendWithSessionDocument(app.send)
    await session({ command: 'new_document', args: {} })

    await session({ command: 'tool', args: { document_id: 'tab-1', name: 'get_page_tree' } })
    await session({ command: 'undo', args: {} })
    expect(app.lastDocument()).toBe('tab-1')

    await session({ command: 'activate_document', args: { document_id: 'tab-2' } })
    await session({ command: 'save_file', args: {} })
    expect(app.lastDocument()).toBe('tab-2')
  })

  test('a session that has chosen no document follows the active tab', async () => {
    const app = fakeApp()
    const session = sendWithSessionDocument(app.send)

    await session({ command: 'tool', args: { name: 'get_page_tree' } })

    expect(app.lastDocument()).toBeUndefined()
  })

  test('app-wide commands are sent without a document', async () => {
    const app = fakeApp()
    const session = sendWithSessionDocument(app.send)
    await session({ command: 'new_document', args: {} })

    await session({ command: 'list_documents', args: {} })
    expect(app.lastDocument()).toBeUndefined()
    await session({ command: 'open_file', args: { path: '/c.fig' } })
    expect(app.lastDocument()).toBeUndefined()
  })

  test('closing the session document returns it to the active tab', async () => {
    const app = fakeApp()
    const session = sendWithSessionDocument(app.send)
    await session({ command: 'new_document', args: {} })

    await session({ command: 'close_file', args: {} })
    await session({ command: 'tool', args: { name: 'get_page_tree' } })

    expect(app.sent.at(-2)?.args.document_id).toBe('tab-2')
    expect(app.lastDocument()).toBeUndefined()
  })

  test('a document closed in the app fails the call instead of moving it elsewhere', async () => {
    const app = fakeApp()
    const session = sendWithSessionDocument(app.send)
    await session({ command: 'new_document', args: {} })
    app.closeByHand('tab-2')

    const reply = await session({ command: 'tool', args: { name: 'create_shape', args: {} } })

    expect(reply).toMatchObject({ ok: false })
    expect((reply as { error: string }).error).toContain('Call list_documents')
    await session({ command: 'tool', args: { name: 'get_page_tree' } })
    expect(app.lastDocument()).toBeUndefined()
  })

  test('a failed call does not change the session document', async () => {
    const app = fakeApp()
    const session = sendWithSessionDocument(app.send)
    await session({ command: 'new_document', args: {} })

    await session({ command: 'tool', args: { document_id: 'missing', name: 'get_page_tree' } })
    await session({ command: 'tool', args: { name: 'get_page_tree' } })

    expect(app.lastDocument()).toBe('tab-2')
  })
})
