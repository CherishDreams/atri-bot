/**
 * prepend 之后把视图钉回用户正在看的那一条。
 *
 * 量法是「比**同一个元素**的前后位移」，不是 `scrollHeight` 差量、也不是记 `scrollTop`：
 * 新增的高度只有在气泡**同步渲染完**时才等于 scrollHeight 的变化，而 `MarkdownView` 哪天
 * 改成懒渲染、加代码高亮或图片加载，那个等式就静默地不成立 —— 症状是一屏跳走的文字，
 * 而代码看起来没改过。记 `scrollTop` 更错：prepend 之后「第一个元素」已经是新拉来的那条，
 * 前后比的根本不是同一个东西（AGENTS.md 的验证判据就是这条）。
 *
 * 靠 `data-msg-id` 钉住一条（Vue 的 `:key` 保证 prepend 不会换掉它的 DOM 节点），
 * 恢复时比它的 `rect.top` 位移，加回 `scrollTop`。
 *
 * 两个平台共用这一份：它一有分支就不再是「两份各写、漂不出 bug」的那种形状
 *（`Conversation.vue` 与 `views/chat/ChatSessionView.vue` 各自只有四行调用）。
 */

/** 容器里**当前可见的第一条**消息；一条都看不见（空列表）时返回 null。 */
function firstVisibleRow(box: HTMLElement): HTMLElement | null {
  const top = box.getBoundingClientRect().top;
  for (const el of box.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    // bottom 而不是 top 越过容器上沿：顶部那条常常被裁掉一半，按 top 判会选中一条已经看不见的。
    if (el.getBoundingClientRect().bottom > top) return el;
  }
  return null;
}

/**
 * 现在就记下锚点，返回一个「DOM 变完之后调用」的恢复函数。
 *
 * 拆成两步是因为必须 `await nextTick()`：Vue 还没渲染出新行之前量什么都没有意义，
 * 而调用方需要的是「钉住 → 等渲染 → 挪回来」这条顺序，不是两个 API。
 */
export function captureAnchor(box: HTMLElement): () => void {
  const row = firstVisibleRow(box);
  const before = row?.getBoundingClientRect().top ?? 0;
  return () => {
    // 元素被 Vue 回收掉了（比如这期间换了会话）：什么都不做比硬挪一下更诚实。
    if (!row || !row.isConnected) return;
    box.scrollTop += row.getBoundingClientRect().top - before;
  };
}
