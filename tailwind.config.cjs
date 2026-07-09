/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/renderer/index.html",
    "./src/renderer/src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class', // Theme is toggled via .light-theme / .dark-theme classes on html
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        // Tailwind v4 note: the @config compat layer emits utilities for FLAT string
        // colors but silently drops color OBJECTS that carry a `DEFAULT` key. These were
        // objects in v3; flattened to `name` + `name-foreground` keys so `bg-primary`,
        // `text-muted-foreground`, etc. keep generating. The old numbered scales
        // (primary-50..950 / accent-50..950) were unused and dropped.
        primary: "hsl(var(--primary))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        secondary: "hsl(var(--secondary))",
        "secondary-foreground": "hsl(var(--secondary-foreground))",
        destructive: "hsl(var(--destructive))",
        "destructive-foreground": "hsl(var(--destructive-foreground))",
        muted: "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        accent: "hsl(var(--accent))",
        "accent-foreground": "hsl(var(--accent-foreground))",
        popover: "hsl(var(--popover))",
        "popover-foreground": "hsl(var(--popover-foreground))",
        card: "hsl(var(--card))",
        "card-foreground": "hsl(var(--card-foreground))",
        // Legacy colors for compatibility
        ink: {
          void: '#020617',
          deep: '#0f172a',
          dark: '#1e293b',
          base: '#334155',
          elevated: '#1e293b',
          hover: '#334155',
        },
        // Editor-specific colors (CSS variable references)
        editor: {
          bg: 'var(--color-bg-secondary)',
          sidebar: 'var(--color-bg-primary)',
          border: 'var(--color-border)',
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      // 仅新增 Tailwind 默认 scale 没有的 2xs(10px),映射到 --text-2xs。
      // 其余字号梯度以 CSS 变量形式存在(--text-*/--leading-*),供后续迁移
      // 用 arbitrary 引用,刻意不覆盖默认 text-sm/lg 等,以免改动现有视觉。
      fontSize: {
        '2xs': 'var(--text-2xs)',
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
      },
      typography: (theme) => ({
        DEFAULT: {
          css: {
            maxWidth: 'none',
            color: 'hsl(var(--foreground))',
            a: {
              color: 'hsl(var(--primary))',
              '&:hover': {
                color: 'hsl(var(--primary))',
                textDecoration: 'underline',
              },
            },
            code: {
              color: 'hsl(var(--accent-foreground))',
              backgroundColor: 'hsl(var(--accent))',
              borderRadius: '0.25rem',
              padding: '0.2em 0.4em',
            },
          },
        },
      }),
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
