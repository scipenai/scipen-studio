/**
 * @file MarkdownRenderService.ts - Markdown render pipeline
 * @description Converts Markdown into sanitized themed HTML with asset rewriting, heading anchors and diagnostics.
 */

import type { Element, Root, RootContent } from 'hast';
import { defaultSchema } from 'hast-util-sanitize';
import GithubSlugger from 'github-slugger';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { t } from '../../locales';
import type {
  MarkdownFrontmatterField,
  MarkdownRenderDiagnostic,
  MarkdownRenderInput,
  MarkdownRenderResult,
  MarkdownTocItem,
} from '../../types';
import { highlightMarkdownCode } from '../../utils/markdownPrism';
import { MarkdownAssetResolver } from '../MarkdownAssetResolver';

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'div',
    'span',
    'img',
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
    'details',
    'summary',
    'kbd',
    'sub',
    'sup',
    'mark',
  ],
  attributes: {
    ...(defaultSchema.attributes || {}),
    '*': [
      ...(defaultSchema.attributes?.['*'] || []),
      'className',
      'id',
      'align',
      'width',
      'height',
      'title',
    ],
    a: [...(defaultSchema.attributes?.a || []), 'href', 'target', 'rel'],
    img: [
      ...(defaultSchema.attributes?.img || []),
      'src',
      'alt',
      'title',
      'width',
      'height',
      'align',
    ],
    div: [...(defaultSchema.attributes?.div || []), 'align'],
    span: [...(defaultSchema.attributes?.span || []), 'align'],
    code: [...(defaultSchema.attributes?.code || []), 'className'],
    pre: [...(defaultSchema.attributes?.pre || []), 'className'],
  },
};

export class MarkdownRenderService {
  dispose(): void {}

  async render(input: MarkdownRenderInput): Promise<MarkdownRenderResult> {
    const diagnostics: MarkdownRenderDiagnostic[] = [];
    const { body, frontmatter } = this.extractFrontmatter(input.markdown);
    const toc: MarkdownTocItem[] = [];
    const slugger = new GithubSlugger();
    const resolver = new MarkdownAssetResolver();

    const baseProcessor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize, sanitizeSchema as never);

    const tree = (await baseProcessor.run(baseProcessor.parse(body))) as Root;
    await this.decorateTree(tree, input, toc, diagnostics, slugger, resolver);

    const finalProcessor = unified()
      .use(rehypeKatex)
      .use(() => (tree: Root) => {
        this.highlightCodeBlocks(tree);
      })
      .use(rehypeStringify, { allowDangerousHtml: true });

    const outputTree = (await finalProcessor.run(tree)) as Root;
    const html = String(finalProcessor.stringify(outputTree));

    return { html, toc, diagnostics, frontmatter };
  }

  private extractFrontmatter(markdown: string): {
    body: string;
    frontmatter: MarkdownFrontmatterField[];
  } {
    const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
      return { body: markdown, frontmatter: [] };
    }

    const rawFrontmatter = match[1];
    const body = markdown.slice(match[0].length);
    const fields: MarkdownFrontmatterField[] = [];

    for (const rawLine of rawFrontmatter.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const separatorIndex = line.indexOf(':');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');

      if (!key || !value) {
        continue;
      }

      fields.push({ key, value });
    }

    return { body, frontmatter: fields };
  }

  private async decorateTree(
    tree: Root,
    input: MarkdownRenderInput,
    toc: MarkdownTocItem[],
    diagnostics: MarkdownRenderDiagnostic[],
    slugger: GithubSlugger,
    resolver: MarkdownAssetResolver
  ): Promise<void> {
    const tasks: Promise<void>[] = [];

    visit(tree, 'element', (node: Element) => {
      if (node.position?.start?.line != null) {
        node.properties = node.properties || {};
        node.properties['data-line'] = String(node.position.start.line);
      }

      if (/^h[1-6]$/.test(node.tagName)) {
        const text = this.getNodeText(node);
        const id = slugger.slug(text || node.tagName);
        node.properties = node.properties || {};
        node.properties.id = id;
        toc.push({
          depth: Number(node.tagName.slice(1)),
          text,
          id,
          line: node.position?.start?.line,
        });
      }

      if (node.tagName === 'img' && typeof node.properties?.src === 'string') {
        tasks.push(this.rewriteImageNode(node, input, diagnostics, resolver));
      }

      if (node.tagName === 'a' && typeof node.properties?.href === 'string') {
        tasks.push(this.rewriteAnchorNode(node, input, diagnostics, resolver));
      }
    });

    await Promise.all(tasks);
  }

  private async rewriteImageNode(
    node: Element,
    input: MarkdownRenderInput,
    diagnostics: MarkdownRenderDiagnostic[],
    resolver: MarkdownAssetResolver
  ): Promise<void> {
    const src =
      typeof node.properties.src === 'string'
        ? node.properties.src
        : String(node.properties.src || '');
    const result = await resolver.resolve(src, {
      filePath: input.filePath,
      projectPath: input.projectPath,
    });
    if (result.diagnostics) diagnostics.push(...result.diagnostics);
    if (result.kind === 'local-file' || result.kind === 'external') {
      node.properties.src = result.url || result.value;
    }
  }

  private async rewriteAnchorNode(
    node: Element,
    input: MarkdownRenderInput,
    diagnostics: MarkdownRenderDiagnostic[],
    resolver: MarkdownAssetResolver
  ): Promise<void> {
    const href =
      typeof node.properties.href === 'string'
        ? node.properties.href
        : String(node.properties.href || '');
    const result = await resolver.resolve(href, {
      filePath: input.filePath,
      projectPath: input.projectPath,
    });
    if (result.diagnostics) diagnostics.push(...result.diagnostics);

    node.properties = node.properties || {};

    if (result.kind === 'anchor') {
      node.properties.href = result.url;
      return;
    }

    if (result.kind === 'external') {
      node.properties.href = result.url;
      node.properties.target = '_blank';
      node.properties.rel = 'noopener noreferrer';
      return;
    }

    if (result.kind === 'local-file') {
      node.properties.href = result.url || '#';
      node.properties['data-scipen-local-path'] = result.value;
    }
  }

  private highlightCodeBlocks(tree: Root): void {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'pre') return;

      const codeNode = node.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'code'
      );
      if (!codeNode) return;

      const classNames = Array.isArray(codeNode.properties?.className)
        ? codeNode.properties.className
        : [];
      const languageClass = classNames.find(
        (name): name is string => typeof name === 'string' && name.startsWith('language-')
      );
      if (!languageClass) return;

      const requestedLanguage = languageClass.replace(/^language-/, '').toLowerCase();
      const code = this.getNodeText(codeNode);
      if (!code) return;

      const { html, language } = highlightMarkdownCode(code, requestedLanguage);
      const resolvedLanguage = language || requestedLanguage;

      const line =
        node.position?.start?.line != null ? String(node.position.start.line) : undefined;

      node.tagName = 'div';
      node.properties = {
        ...(line ? { 'data-line': line } : {}),
        className: ['markdown-code-block'],
        'data-language': resolvedLanguage,
      };
      node.children = [
        {
          type: 'element',
          tagName: 'div',
          properties: { className: ['markdown-code-block__toolbar'] },
          children: [
            {
              type: 'element',
              tagName: 'div',
              properties: { className: ['markdown-code-block__meta'] },
              children: [
                {
                  type: 'element',
                  tagName: 'span',
                  properties: { className: ['markdown-code-block__language'] },
                  children: [{ type: 'text', value: resolvedLanguage.toLowerCase() || 'text' }],
                },
              ],
            },
            {
              // 纯图标复制按钮(图标走 CSS mask,sanitize 安全);文案改为 aria/title。
              type: 'element',
              tagName: 'button',
              properties: {
                type: 'button',
                className: ['markdown-code-block__copy'],
                'data-copy-code': encodeURIComponent(code),
                'data-copied': 'false',
                'aria-label': t('markdownRender.copyCode'),
                title: t('markdownRender.copyCode'),
              },
              children: [],
            },
          ],
        },
        {
          type: 'element',
          tagName: 'div',
          properties: { className: ['markdown-code-block__scroll'] },
          children: [
            {
              type: 'element',
              tagName: 'pre',
              properties: { className: ['markdown-code-block__body'] },
              children: [
                {
                  type: 'element',
                  tagName: 'code',
                  properties: {
                    className: [
                      `language-${resolvedLanguage}`,
                      'prism-code',
                      'markdown-code-block__code',
                    ],
                  },
                  children: [{ type: 'raw', value: html }],
                },
              ],
            },
          ],
        },
      ];
    });
  }

  private getNodeText(
    node:
      | RootContent
      | Element
      | { type?: string; value?: string; children?: RootContent[] }
      | null
      | undefined
  ): string {
    if (!node) return '';
    if (node.type === 'text') return node.value || '';
    if (!('children' in node) || !Array.isArray(node.children)) return '';
    return node.children.map((child: RootContent) => this.getNodeText(child)).join('');
  }
}
