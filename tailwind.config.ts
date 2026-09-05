import type { Config } from "tailwindcss";

const config: Config = {
    darkMode: ["class"],
    content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
  	extend: {
  		fontFamily: {
  			sans:  ['var(--font-sans)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
  			serif: ['var(--font-serif)', 'Georgia', 'Cambria', 'serif'],
  			mono:  ['var(--font-mono)', 'ui-monospace', 'monospace'],
  			ui:    ['var(--font-ui)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
  			reading: ['var(--font-reading)', 'Georgia', 'Cambria', 'serif'],
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			sidebar: {
  				DEFAULT: 'hsl(var(--sidebar-background))',
  				foreground: 'hsl(var(--sidebar-foreground))',
  				muted: 'hsl(var(--sidebar-muted))',
  				primary: 'hsl(var(--sidebar-primary))',
  				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
  				accent: 'hsl(var(--sidebar-accent))',
  				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
  				border: 'hsl(var(--sidebar-border))',
  				ring: 'hsl(var(--sidebar-ring))'
  			},
  			/* iOS accent palette */
  			ios: {
  				red:    'hsl(var(--ios-red))',
  				orange: 'hsl(var(--ios-orange))',
  				yellow: 'hsl(var(--ios-yellow))',
  				green:  'hsl(var(--ios-green))',
  				teal:   'hsl(var(--ios-teal))',
  				indigo: 'hsl(var(--ios-indigo))',
  				purple: 'hsl(var(--ios-purple))',
  				pink:   'hsl(var(--ios-pink))',
  			},
  			blue: {
  				'300': 'hsl(var(--blue-300))',
  				'400': 'hsl(var(--blue-400))',
  				'500': 'hsl(var(--blue-500))',
  				'600': 'hsl(var(--blue-600))',
  			},
  			heart: 'hsl(var(--heart))',
  			star:  'hsl(var(--star))',
  		},
  		borderRadius: {
  			lg:   'var(--radius)',
  			md:   'calc(var(--radius) - 2px)',
  			sm:   'calc(var(--radius) - 4px)',
  			xl:   'var(--radius-xl)',
  			'2xl': 'var(--radius-2xl)',
  			full: 'var(--radius-full)',
  		},
  		boxShadow: {
  			xs:      'var(--shadow-xs)',
  			sm:      'var(--shadow-sm)',
  			md:      'var(--shadow-md)',
  			lg:      'var(--shadow-lg)',
  			overlay: 'var(--shadow-overlay)',
  		},
  		spacing: {
  			'header': 'var(--header-height)',
  			'sidebar': 'var(--sidebar-width)',
  			'sidebar-icon': 'var(--sidebar-width-icon)',
  			'timeline': 'var(--timeline-width)',
  			'measure': 'var(--reading-measure)',
  		},
  		transitionTimingFunction: {
  			'standard': 'var(--ease-standard)',
  		},
  		transitionDuration: {
  			'fast': 'var(--duration-fast)',
  			'base': 'var(--duration-base)',
  			'slow': 'var(--duration-slow)',
  		},
  	}
  },
  plugins: [require("@tailwindcss/typography")],
};
export default config;
