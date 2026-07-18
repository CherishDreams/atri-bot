<script setup lang="ts">
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { computed } from "vue";

const props = defineProps<{ content: string }>();

/**
 * 模块级单例：markdown-it 构造时要装载整条规则链，而渲染路径是
 * 「每个流式增量 × 每条消息」都走一遍，放进 setup 等于每个 token 重建一次实例。
 *
 * `html: false` 是第一道防线——模型返回的原始 HTML 一律转义成字面文本，不进 DOM。
 * `breaks: true`  让单个换行渲染成 `<br>`，保住改造前 `whitespace-pre-wrap` 的换行观感，
 *                  否则聊天里手打的换行会被 markdown 折叠进同一段。
 * `linkify: true` 让裸 URL 自动成链接。
 */
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

/** 只放行这几种协议，`javascript:` / `data:` / `vbscript:` 一律当纯文本处理。 */
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function isSafeHref(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    return SAFE_PROTOCOLS.has(new URL(href, window.location.origin).protocol);
  } catch {
    return false;
  }
}

/*
 * 链接由渲染规则统一收口，而不是事后正则改字符串。
 * DOMPurify 不会替你加 rel；带 target 的外链少了 noopener 就能被
 * 打开页通过 window.opener 反向控制。
 */
md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  if (token) {
    if (isSafeHref(token.attrGet("href"))) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    } else {
      // 摘掉 href 而不是塞 "#"：留 "#" 一点就把整页滚回顶部，
      // 摘掉后这个 <a> 退化成不可点的行内文字，符合「链接不可信就当文本看」。
      token.attrs = (token.attrs ?? []).filter(([name]) => name !== "href");
    }
  }
  return self.renderToken(tokens, index, options);
};

function render(src: string): string {
  /*
   * 净化是第二道防线。`html:false` 只保证原始 HTML 不直通，兜不住渲染规则自身的
   * 疏漏；而服务端今天不发任何 CSP（server.js 的 sendFile 只给 content-type/length/
   * cache-control），所以页面这一层就是唯一防线，两道都要留。
   */
  return DOMPurify.sanitize(md.render(src), { ADD_ATTR: ["target"] });
}

/**
 * 按消息 memoize。每条消息是独立的 MarkdownView 实例、外层 v-for 的 :key 是稳定的
 * 消息 id，所以流式期间只有正在追加 content 的那一条会重解析，历史消息一律不重算。
 */
const html = computed(() => render(props.content));
</script>

<template>
  <div class="atri-markdown" v-html="html" />
</template>

<style scoped>
/*
 * v-html 注入的节点不带 scoped 的 data-v 属性，选择器必须走 :deep()，
 * 否则整块样式静默不生效（不报错，只是没效果）。
 *
 * 颜色一律取 --atri-* 变量而不是再写 hex：明暗两套主题靠这些变量翻转。
 * 代码底色用 raised，所以宿主气泡必须是 surface——两者同为 raised 时
 * 行内代码会完全看不见。
 */
.atri-markdown {
  overflow-wrap: anywhere;
}

.atri-markdown > :first-child {
  margin-top: 0;
}

.atri-markdown > :last-child {
  margin-bottom: 0;
}

:deep(p) {
  margin: 0 0 0.5em;
}

:deep(ul),
:deep(ol) {
  margin: 0 0 0.5em;
  padding-left: 1.4em;
}

:deep(li) {
  margin: 0.15em 0;
}

:deep(ul ul),
:deep(ol ol),
:deep(ul ol),
:deep(ol ul) {
  margin-bottom: 0;
}

:deep(h1),
:deep(h2),
:deep(h3),
:deep(h4),
:deep(h5),
:deep(h6) {
  margin: 0.9em 0 0.4em;
  font-weight: 600;
  line-height: 1.25;
}

:deep(h1) {
  font-size: 1.3em;
}

:deep(h2) {
  font-size: 1.18em;
}

:deep(h3) {
  font-size: 1.06em;
}

:deep(h4),
:deep(h5),
:deep(h6) {
  font-size: 1em;
}

:deep(code) {
  padding: 0.12em 0.36em;
  border-radius: var(--atri-radius-sm);
  background: var(--atri-raised);
  font-family: var(--atri-font-family-mono);
  font-size: 0.88em;
}

:deep(pre) {
  margin: 0 0 0.6em;
  padding: 0.75em 1em;
  overflow-x: auto;
  border: 1px solid var(--atri-line);
  border-radius: var(--atri-radius-md);
  background: var(--atri-raised);
}

:deep(pre code) {
  padding: 0;
  border-radius: 0;
  background: none;
  font-size: 0.86em;
  line-height: 1.55;
}

:deep(blockquote) {
  margin: 0 0 0.6em;
  padding-left: 0.8em;
  border-left: 3px solid var(--atri-line-strong);
  color: var(--atri-ink-muted);
}

/* 表格用 display:block 横向滚动，避免宽表把气泡撑破气泡的 max-width。 */
:deep(table) {
  display: block;
  max-width: 100%;
  margin: 0 0 0.6em;
  overflow-x: auto;
  border-collapse: collapse;
}

:deep(th),
:deep(td) {
  padding: 0.3em 0.6em;
  border: 1px solid var(--atri-line);
  text-align: left;
}

:deep(th) {
  background: var(--atri-raised);
  font-weight: 600;
}

:deep(a) {
  color: var(--atri-primary);
  text-decoration: none;
}

:deep(a:hover) {
  text-decoration: underline;
}

/* 被摘掉 href 的不可信链接：退回正文字色，别留个看起来能点却是死链的蓝色。 */
:deep(a:not([href])) {
  color: inherit;
}

:deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--atri-radius-md);
}

:deep(hr) {
  margin: 0.9em 0;
  border: none;
  border-top: 1px solid var(--atri-line);
}
</style>
