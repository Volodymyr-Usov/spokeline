import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'spokeline',
  component: 'Pane',
  requestId: 'spokeline-menu',
  surface: 'terminal',
  props: {
    title: 'Spokeline',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the /spokeline menu draws one row per setting', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  const listening = await ui.find({ type: 'Button', text: /Listening/ })
  expect(listening).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /Speak answers/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Arrows: move/ })).toBeTruthy()
  await ui.unmount()
})

test('each menu row has its fixed number key, on every surface', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', text: /Listening/ }))?.props.hotkey).toBe('1')
    expect((await ui.find({ type: 'Button', text: /Speak answers/ }))?.props.hotkey).toBe('2')
    expect((await ui.find({ type: 'Button', text: /Voice/ }))?.props.hotkey).toBe('3')
    expect((await ui.find({ type: 'Button', text: /Switch off after/ }))?.props.hotkey).toBe('7')
    await ui.unmount()
  }
})

test('the hint says Tab in VS Code and the arrows in the terminal', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const vscode = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await vscode.find({ type: 'Text', text: /^Tab: move · Enter: change · Esc: close$/ })).toBeTruthy()
  expect(await vscode.find({ type: 'Text', text: /Arrows/ })).toBeUndefined()
  await vscode.unmount()
  const terminal = await $.ui.mount(PANE)
  expect(await terminal.find({ type: 'Text', text: /^Arrows: move · Enter or 1-7: change · Esc: close$/ })).toBeTruthy()
  await terminal.unmount()
})
