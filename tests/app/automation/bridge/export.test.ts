import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { toUint8Array } from 'js-base64'

import { SkiaRenderer } from '@open-pencil/core/canvas'
import { getCanvasKit } from '@open-pencil/core/canvaskit'
import { BUILTIN_IO_FORMATS, IORegistry } from '@open-pencil/core/io'
import { parseFigFile } from '@open-pencil/core/io/formats/fig'
import { createCanvasKitRasterCodec } from '@open-pencil/core/io/formats/raster'
import { SceneGraph } from '@open-pencil/scene-graph'
import { imageSize } from '@open-pencil/scene-graph/images'

import { makeFigmaFromStore } from '@/app/automation/bridge/figma-factory'
import { createAutomationCommandHandlers } from '@/app/automation/bridge/handlers'
import type { AutomationTarget } from '@/app/automation/bridge/target'
import { createEditorStore, type EditorStore } from '@/app/editor/session/create'

const RED = { type: 'SOLID' as const, color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }
const { handleTargetCommand } = createAutomationCommandHandlers(makeFigmaFromStore)

let stores: EditorStore[] = []

beforeEach(() => {
  // The automation FigmaAPI reads the viewport size from the window.
  Object.assign(globalThis, { window: { innerWidth: 1024, innerHeight: 768 } })
})

afterEach(() => {
  for (const store of stores) store.dispose()
  stores = []
  Reflect.deleteProperty(globalThis, 'window')
})

async function storeWithCanvas(graph?: SceneGraph): Promise<EditorStore> {
  const store = createEditorStore(graph)
  stores.push(store)
  const ck = await getCanvasKit()
  const surface = ck.MakeSurface(1, 1)
  if (!surface) throw new Error('Failed to create CanvasKit surface')
  store.setCanvasKit(ck, new SkiaRenderer(ck, surface))
  return store
}

/** A `.fig` opened like the app does: only the first page has its layers. */
async function storeWithUnshownPage(): Promise<{ store: EditorStore; pageId: string }> {
  const source = new SceneGraph()
  source.createNode('FRAME', source.getPages()[0].id, { width: 10, height: 10, fills: [RED] })
  const second = source.addPage('Second')
  source.createNode('FRAME', second.id, {
    name: 'Second frame',
    width: 70,
    height: 35,
    fills: [RED]
  })
  const written = await new IORegistry(BUILTIN_IO_FORMATS).writeDocument('fig', source)
  const bytes = written.data as Uint8Array
  const graph = await parseFigFile(bytes.slice().buffer, { populate: 'first-page' })
  const store = await storeWithCanvas(graph)
  const page = graph.getPages().find((candidate) => candidate.name === 'Second')
  if (!page) throw new Error('Missing second page')
  expect(graph.getChildren(page.id)).toHaveLength(0)
  return { store, pageId: page.id }
}

function target(store: EditorStore, pageId: string): AutomationTarget {
  const page = store.graph.getNode(pageId)
  return {
    store,
    documentId: 'tab-1',
    documentName: 'Document',
    pageId,
    pageName: page?.name ?? ''
  }
}

function resultBytes(response: unknown): Uint8Array {
  const result = (response as { result?: { base64?: string } }).result
  if (!result?.base64) throw new Error(`No image in ${JSON.stringify(response)}`)
  return toUint8Array(result.base64)
}

describe('automation export of a page that is not on screen', () => {
  test('export_image renders nodes by ID from another page', async () => {
    const store = await storeWithCanvas()
    const shown = store.state.currentPageId
    const other = store.graph.addPage('Other').id
    const frame = store.graph.createNode('FRAME', other, { width: 40, height: 30, fills: [RED] })

    const response = await handleTargetCommand(target(store, shown), 'tool', {
      name: 'export_image',
      args: { ids: [frame.id] }
    })

    expect(imageSize(resultBytes(response))).toEqual({ width: 40, height: 30 })
    expect(store.state.currentPageId).toBe(shown)
  })

  test('export_image renders the layers of the page named by page_id', async () => {
    const store = await storeWithCanvas()
    const shown = store.state.currentPageId
    const other = store.graph.addPage('Other').id
    store.graph.createNode('FRAME', other, { width: 50, height: 20, fills: [RED] })

    const response = await handleTargetCommand(target(store, other), 'tool', {
      name: 'export_image',
      args: {}
    })

    expect(imageSize(resultBytes(response))).toEqual({ width: 50, height: 20 })
    expect(store.state.currentPageId).toBe(shown)
  })

  test('a page export renders the target page, not the selection on screen', async () => {
    const store = await storeWithCanvas()
    const shown = store.state.currentPageId
    const selected = store.graph.createNode('FRAME', shown, { width: 10, height: 10, fills: [RED] })
    store.select([selected.id])
    const other = store.graph.addPage('Other').id
    store.graph.createNode('FRAME', other, { width: 60, height: 25, fills: [RED] })

    const response = await handleTargetCommand(target(store, other), 'export', {
      scope: 'page',
      format: 'png'
    })

    expect(imageSize(resultBytes(response))).toEqual({ width: 60, height: 25 })
    expect(store.state.currentPageId).toBe(shown)
  })

  test('a page export loads the layers of a .fig page that has not been shown', async () => {
    const { store, pageId } = await storeWithUnshownPage()
    const shown = store.state.currentPageId

    const response = await handleTargetCommand(target(store, pageId), 'export', { scope: 'page' })

    expect(imageSize(resultBytes(response))).toEqual({ width: 70, height: 35 })
    expect(store.state.currentPageId).toBe(shown)
  })

  test('a JSX export lists the layers of a .fig page that has not been shown', async () => {
    const { store, pageId } = await storeWithUnshownPage()

    const response = (await handleTargetCommand(target(store, pageId), 'export_jsx', {})) as {
      result: { jsx: string }
    }

    expect(response.result.jsx).toContain('Second frame')
  })

  test('a page export lays out the target page first', async () => {
    const store = await storeWithCanvas()
    const shown = store.state.currentPageId
    const other = store.graph.addPage('Other').id
    // Not laid out yet: the row hugs one 80 px child but still says 10 px, and clips.
    const row = store.graph.createNode('FRAME', other, {
      width: 10,
      height: 20,
      fills: [RED],
      clipsContent: true,
      layoutMode: 'HORIZONTAL',
      primaryAxisSizing: 'HUG',
      counterAxisSizing: 'FIXED'
    })
    store.graph.createNode('FRAME', row.id, { width: 80, height: 20, fills: [RED] })

    const response = await handleTargetCommand(target(store, other), 'export', { scope: 'page' })

    expect(imageSize(resultBytes(response))).toEqual({ width: 80, height: 20 })
    expect(store.state.currentPageId).toBe(shown)
  })
})

/**
 * A document whose tab went to the background: the app unmounts its canvas, which takes the
 * canvas renderer away from the editor and destroys it.
 */
async function storeInBackgroundTab(): Promise<EditorStore> {
  const store = await storeWithCanvas()
  for (const renderer of store.canvasRenderers) {
    store.removeCanvasRenderer(renderer)
    renderer.destroy()
  }
  expect(store.renderer).toBeNull()
  return store
}

/** The RGBA pixel at the centre of an image. */
async function centrePixel(bytes: Uint8Array): Promise<number[]> {
  const image = createCanvasKitRasterCodec(await getCanvasKit()).decode(bytes)
  if (!image) throw new Error('Could not decode the image')
  const offset = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4
  return [...image.data.subarray(offset, offset + 4)]
}

describe('automation export of a document with no canvas', () => {
  test('export_image draws the layers of a document in a background tab', async () => {
    const store = await storeInBackgroundTab()
    const page = store.state.currentPageId
    const frame = store.graph.createNode('FRAME', page, { width: 40, height: 30, fills: [RED] })

    const response = await handleTargetCommand(target(store, page), 'tool', {
      name: 'export_image',
      args: { ids: [frame.id] }
    })

    const image = resultBytes(response)
    expect(imageSize(image)).toEqual({ width: 40, height: 30 })
    expect(await centrePixel(image)).toEqual([255, 0, 0, 255])
  })

  test('a page export draws a document in a background tab', async () => {
    const store = await storeInBackgroundTab()
    const page = store.state.currentPageId
    store.graph.createNode('FRAME', page, { width: 60, height: 25, fills: [RED] })

    const response = await handleTargetCommand(target(store, page), 'export', { scope: 'page' })

    const image = resultBytes(response)
    expect(imageSize(image)).toEqual({ width: 60, height: 25 })
    expect(await centrePixel(image)).toEqual([255, 0, 0, 255])
  })

  test('export_image draws a document whose canvas never started', async () => {
    const store = createEditorStore()
    stores.push(store)
    const page = store.state.currentPageId
    const frame = store.graph.createNode('FRAME', page, { width: 20, height: 20, fills: [RED] })

    const response = await handleTargetCommand(target(store, page), 'tool', {
      name: 'export_image',
      args: { ids: [frame.id] }
    })

    expect(await centrePixel(resultBytes(response))).toEqual([255, 0, 0, 255])
  })

  test('diff_visual compares layers of a document in a background tab', async () => {
    const store = await storeInBackgroundTab()
    const page = store.state.currentPageId
    const from = store.graph.createNode('FRAME', page, { width: 20, height: 20, fills: [RED] })
    const blue = { ...RED, color: { r: 0, g: 0, b: 1, a: 1 } }
    const to = store.graph.createNode('FRAME', page, {
      x: 40,
      width: 20,
      height: 20,
      fills: [blue]
    })

    const response = await handleTargetCommand(target(store, page), 'tool', {
      name: 'diff_visual',
      args: { from: from.id, to: to.id }
    })

    expect(imageSize(resultBytes(response))).toEqual({ width: 20, height: 20 })
    expect(response).toMatchObject({ result: { changedPixels: 400, totalPixels: 400 } })
  })
})
