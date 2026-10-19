import { defineConfig } from 'vitepress'

/**
 * `DOCS_BASE` is set by the GitHub Pages workflow to `/<repository>/`.
 * Locally it defaults to `/` so `npm run docs:dev` opens at the site root.
 */
const base = process.env.DOCS_BASE || '/'

export default defineConfig({
  lang: 'zh-CN',
  title: 'pikafish-js',
  description: '在浏览器中运行 Pikafish 中国象棋引擎的前端包：WebAssembly、NNUE、人机对弈与本地分析。',
  base,
  cleanUrls: false,
  head: [
    ['meta', { name: 'theme-color', content: '#b91c1c' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'pikafish-js · 浏览器里的象棋引擎' }],
    ['meta', {
      property: 'og:description',
      content: '基于 WebAssembly 的 Pikafish 前端包：纯前端人机对弈、局面分析与可离线运行的象棋引擎。'
    }]
  ],
  themeConfig: {
    nav: [
      { text: '项目方案', link: '/plan/overview' },
      { text: '技术调研', link: '/plan/research' },
      { text: '系统架构', link: '/plan/architecture' },
      { text: '路线图', link: '/plan/roadmap' },
      { text: '上游 Pikafish', link: 'https://github.com/official-pikafish/Pikafish' }
    ],
    sidebar: {
      '/plan/': [
        {
          text: '项目方案',
          items: [
            { text: '方案总览', link: '/plan/overview' },
            { text: '选型记录', link: '/plan/decisions' },
            { text: '产品设计', link: '/plan/product' },
            { text: '技术调研：象棋生态', link: '/plan/research' },
            { text: '技术调研：Web 移植', link: '/plan/research-web' },
            { text: '系统架构', link: '/plan/architecture' },
            { text: '实施路线图', link: '/plan/roadmap' },
            { text: '风险与对策', link: '/plan/risks' }
          ]
        },
        {
          text: '参考资料',
          items: [
            { text: '术语表', link: '/reference/glossary' },
            { text: '一手资料', link: '/reference/sources' }
          ]
        }
      ],
      '/reference/': [
        {
          text: '参考资料',
          items: [
            { text: '术语表', link: '/reference/glossary' },
            { text: '一手资料', link: '/reference/sources' },
            { text: '返回方案总览', link: '/plan/overview' }
          ]
        }
      ]
    },
    search: {
      provider: 'local'
    },
    outline: {
      level: [2, 3],
      label: '本页目录'
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },
    footer: {
      message: '项目代码以 AGPL-3.0-or-later 发布；上游 Pikafish 为 GPL-3.0；NNUE 权重适用其自身声明。',
      copyright: 'pikafish-js 项目方案 · 2026'
    }
  }
})
