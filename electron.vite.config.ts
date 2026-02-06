import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react-swc'
import { resolve } from 'path'

const isDev = process.env.NODE_ENV === 'development'
const isProd = process.env.NODE_ENV === 'production'

// Worker 文件通过 scripts/build-workers.js 构建
// package.json 的 "dev" 和 "build" 脚本已配置先运行 build:workers

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('shared')
      }
    },
    build: {
      // 不清理 out 目录，保留 workers 和 lsp-process 目录
      emptyOutDir: false,
      rollupOptions: {
        external: [
          'better-sqlite3',
          'hnswlib-node',
          'pdf-parse',
          'fluent-ffmpeg',
          '@ffmpeg-installer/ffmpeg',
          'fs-extra',
          'electron-store',
          'selection-hook'
        ],
        output: {
          // Disable code splitting for main process - bundle into single file for faster IO
          manualChunks: undefined,
          // Inline all dynamic imports for faster startup
          inlineDynamicImports: true
        }
      },
      sourcemap: isDev
    },
    esbuild: isProd ? { legalComments: 'none' } : {},
    // Disable dependency discovery in dev mode for faster startup
    optimizeDeps: {
      noDiscovery: isDev
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared')
      }
    },
    build: {
      sourcemap: isDev
    }
  },
  renderer: {
    plugins: [react()],
    root: 'src/renderer',
    publicDir: '../../public',
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@components': resolve('src/renderer/src/components'),
        '@services': resolve('src/renderer/src/services'),
        '@store': resolve('src/renderer/src/store'),
        '@utils': resolve('src/renderer/src/utils'),
        '@shared': resolve('shared')
      }
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'zustand', 'clsx'],
      exclude: ['pdfjs-dist']
    },
    build: {
      target: 'esnext',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          selectionAction: resolve(__dirname, 'src/renderer/selectionAction.html'),
          selectionToolbar: resolve(__dirname, 'src/renderer/selectionToolbar.html')
        },
        output: {
          /**
           * 优化的代码分割策略
           * 参考 VS Code 和 Cherry Studio 的分包实践
           * 
           * 目标:
           * 1. 首屏快速加载 (核心 React + 状态管理)
           * 2. Monaco 编辑器延迟加载
           * 3. PDF 预览独立分包
           * 4. 大型依赖隔离
           */
          manualChunks: (id) => {
            // React 核心 - 首屏必需
            if (id.includes('node_modules/react/') || 
                id.includes('node_modules/react-dom/') ||
                id.includes('node_modules/scheduler/')) {
              return 'vendor-react-core'
            }
            
            // Monaco Editor - 延迟加载的大型依赖
            if (id.includes('node_modules/monaco-editor/') ||
                id.includes('node_modules/@monaco-editor/')) {
              return 'vendor-monaco'
            }
            
            // PDF.js - 只在需要时加载
            if (id.includes('node_modules/pdfjs-dist/')) {
              return 'vendor-pdf'
            }
            
            // 动画和 UI 组件
            if (id.includes('node_modules/framer-motion/')) {
              return 'vendor-motion'
            }
            
            // 图标库
            if (id.includes('node_modules/lucide-react/')) {
              return 'vendor-icons'
            }
            
            // Markdown 渲染
            if (id.includes('node_modules/react-markdown/') ||
                id.includes('node_modules/remark-') ||
                id.includes('node_modules/rehype-') ||
                id.includes('node_modules/unified/') ||
                id.includes('node_modules/micromark/')) {
              return 'vendor-markdown'
            }
            
            // 数学公式
            if (id.includes('node_modules/katex/')) {
              return 'vendor-katex'
            }
            
            // 状态管理
            if (id.includes('node_modules/zustand/')) {
              return 'vendor-state'
            }
            
            // 其他小型工具库打包在一起
            if (id.includes('node_modules/clsx/') ||
                id.includes('node_modules/react-resizable-panels/')) {
              return 'vendor-utils'
            }
          }
        }
      },
      cssCodeSplit: true,
      chunkSizeWarningLimit: 1000,
      minify: 'esbuild',
      sourcemap: false
    },
    server: {
      hmr: {
        overlay: false
      }
    },
    esbuild: isProd ? { legalComments: 'none' } : {}
  }
})
