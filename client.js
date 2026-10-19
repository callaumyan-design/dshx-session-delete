// dshx-session-delete — browser half.
//
// Adds 「删除对话」 to the "..." menu of every sidebar conversation row
// (slot `sidebar.workspaces.session.menu.item`, after 归档 at order 400).
//
// Flow on confirm:
//   1. stop + archive through the official workspace API
//      (`workspaces.archiveSession(id, { stopActivity: true })`), which cancels a
//      running turn and takes the row out of navigation; the live
//      workspaceController owns workspace.json, so this is the only safe way to
//      drop the row;
//   2. POST /dshx-session-delete/delete — the host half force-stops anything
//      still resident, then erases the log directory and projection cache.
// A failed step 2 leaves the conversation archived (recoverable via
// 「显示已归档」), never half-deleted and invisible.
window.__ModuleLoader__.load({
  id: 'dshx-session-delete',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const exports = {}

    const TRASH = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M2.75 4.25h10.5M6.25 4.25V2.9c0-.36.29-.65.65-.65h2.2c.36 0 .65.29.65.65v1.35', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M4 4.25l.62 8.4c.05.62.57 1.1 1.2 1.1h4.36c.63 0 1.15-.48 1.2-1.1L12 4.25', stroke: 'currentColor', strokeWidth: 1.1, strokeLinejoin: 'round' }),
      h('path', { d: 'M6.6 6.9v4.2M9.4 6.9v4.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }))

    async function erase(sessionId) {
      const res = await fetch('/dshx-session-delete/delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        throw new Error(detail.error || ('HTTP ' + res.status))
      }
      return res.json()
    }

    exports.inject = ['slots', 'workspaces']
    exports.apply = (ctx) => {
      const workspaces = ctx.get('workspaces')
      let MenuItemButton = null
      try { MenuItemButton = require('@deepseek-ai/dsh-client-ui-primitives').MenuItemButton } catch { /* fallback below */ }

      function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
        const [, setMenuOpen] = useMenuOpenState ? useMenuOpenState() : [null, () => {}]
        const onSelect = () => {
          setMenuOpen(false)
          const title = displayTitle || sessionId
          if (!window.confirm('永久删除对话「' + title + '」？\n\n如果它正在运行，会先被强制终止。\n会话记录会从磁盘彻底删除，无法恢复。')) return
          void (async () => {
            try {
              try {
                await workspaces.archiveSession(sessionId, { stopActivity: true })
              } catch (error) {
                // Already archived / not accounted: the host still force-stops.
                console.warn('dshx-session-delete: archive before delete failed', error)
              }
              await erase(sessionId)
            } catch (error) {
              window.alert('删除失败：' + (error && error.message ? error.message : error) + '\n\n对话已被归档，可在侧边栏「显示已归档」中找回。')
            }
          })()
        }
        if (MenuItemButton) return h(MenuItemButton, { icon: TRASH, danger: true, separatorBefore: true, onSelect }, '删除对话')
        return h('button', { type: 'button', role: 'menuitem', onClick: onSelect, style: { color: 'var(--dsw-alias-state-error-primary)' } }, '删除对话')
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'dshx-delete',
        order: 900,
      }, DeleteSessionMenuItem))
    }
    return exports
  },
})
