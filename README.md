# dshx-session-delete

> Permanently delete a DeepSeek Harness conversation from the sidebar — DSH itself only offers archiving.

DSH 只有「归档」，归档后会话日志仍留在磁盘上。本插件在侧边栏每个会话的 **「…」菜单**里加一项 **「删除对话」**。

确认后：

1. 先通过官方 workspace API 停止并归档该会话（这一步把它从导航里移除）；
2. 再调用 `POST /dshx-session-delete/delete`，由 host 端停止残留活动并**永久删除**日志目录和投影缓存。

第 2 步失败时会话只是保持归档状态（可在「显示已归档」里找回），不会出现删一半又看不见的情况。

> ⚠️ 删除是永久的，没有回收站。

## 安装

```sh
# Web profile
dsh plugin --profile web add github:callaumyan-design/dshx-session-delete
# Desktop（用 DSH Desktop 自带的 dsh 命令，先从托盘完全退出 Desktop）
dsh plugin --profile desktop add github:callaumyan-design/dshx-session-delete
```

安装后重启 DSH。卸载：`dsh plugin --profile <profile> remove dshx-session-delete`。

## 兼容性

在 DeepSeek Harness 0.2.0-rc.2（desktop / web profile）上开发和使用。纯 JavaScript，无构建步骤，无安装脚本。

## License

MIT
