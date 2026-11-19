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
//      still resident, erases the log of this conversation and of every subagent
//      session it spawned, drops the projection-cache rows, collects the
//      attachment bytes nothing else references, and then removes the id from
//      the workspace service;
//   3. clear this conversation's browser-side state (draft, view, right-panel
//      layout) — the host cannot reach it and it would otherwise outlive the
//      conversation forever.
// A failed step 2 leaves the conversation archived (recoverable via
// 「显示已归档」), never half-deleted and invisible.
window.__ModuleLoader__.load({
  id: 'dshx-session-delete',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const exports = {}

    /** Per-conversation browser stores written by the shipped UI. */
    const LOCAL_KEYS = ['dsh.conversation', 'dsh.sidebar-right.v1']

    const TRASH = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M2.75 4.25h10.5M6.25 4.25V2.9c0-.36.29-.65.65-.65h2.2c.36 0 .65.29.65.65v1.35', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M4 4.25l.62 8.4c.05.62.57 1.1 1.2 1.1h4.36c.63 0 1.15-.48 1.2-1.1L12 4.25', stroke: 'currentColor', strokeWidth: 1.1, strokeLinejoin: 'round' }),
      h('path', { d: 'M6.6 6.9v4.2M9.4 6.9v4.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }))

    /** Drop this conversation's browser-side records, in both id spellings. */
    function clearLocalState(sessionId) {
      const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
      for (const prefix of LOCAL_KEYS) {
        for (const id of [sessionId, bare]) {
          try { window.localStorage.removeItem(prefix + '.' + id) } catch { /* storage disabled */ }
        }
      }
    }

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

    /** One short line for the console: what the host actually removed. */
    function describeResult(result) {
      const parts = []
      if (Array.isArray(result.children) && result.children.length > 0) parts.push('子会话 ' + result.children.length + ' 个')
      if (Array.isArray(result.removed)) parts.push('文件 ' + result.removed.length + ' 项')
      if (result.attachments && result.attachments.deleted && result.attachments.deleted.length > 0) {
        parts.push('附件 ' + result.attachments.deleted.length + ' 个')
      }
      if (result.verified && Array.isArray(result.verified.remaining) && result.verified.remaining.length > 0) {
        parts.push('仍有残留 ' + result.verified.remaining.length + ' 项')
      }
      return parts.join('，')
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
          if (!window.confirm('永久删除对话「' + title + '」？\n\n如果它正在运行，会先被强制终止。\n会连带删除它派生的子 agent 会话、专属图片和浏览器里的草稿，无法恢复。')) return
          void (async () => {
            try {
              try {
                await workspaces.archiveSession(sessionId, { stopActivity: true })
              } catch (error) {
                // Already archived / not accounted: the host still force-stops.
                console.warn('dshx-session-delete: archive before delete failed', error)
              }
              const result = await erase(sessionId)
              clearLocalState(sessionId)
              const summary = describeResult(result)
              if (summary.length > 0) console.info('dshx-session-delete: ' + title + ' → ' + summary)
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
