/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "IBM Plex Sans Thai",
          "ui-sans-serif",
          "system-ui",
          "Noto Sans Thai",
          "sans-serif",
        ],
        display: [
          "Inter",
          "IBM Plex Sans Thai",
          "Noto Sans Thai",
          "sans-serif",
        ],
        thai: [
          "IBM Plex Sans Thai",
          "Inter",
          "Noto Sans Thai",
          "sans-serif",
        ],
      },
      colors: {
        bg: {
          DEFAULT: "#08070d",
          soft: "#11101a",
          card: "#171626",
          hover: "#1f1e30",
          glass: "rgba(23, 22, 38, 0.6)",
        },
        line: {
          DEFAULT: "#26243a",
          strong: "#363353",
        },
        ink: {
          DEFAULT: "#f5f5f9",
          dim: "#a8a6c0",
          mute: "#6f6c8a",
        },
        brand: {
          DEFAULT: "#8b5cf6",
          hover: "#a78bfa",
          soft: "rgba(139, 92, 246, 0.15)",
          glow: "rgba(139, 92, 246, 0.45)",
        },
        accent: {
          DEFAULT: "#f59e0b",
          soft: "rgba(245, 158, 11, 0.15)",
        },
        pink: "#ec4899",
        cyan: "#06b6d4",
        danger: "#f43f5e",
      },
      boxShadow: {
        glow: "0 0 24px -4px rgba(139, 92, 246, 0.55)",
        "glow-sm": "0 0 12px -2px rgba(139, 92, 246, 0.4)",
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 30px -12px rgba(0,0,0,0.5)",
      },
      backgroundImage: {
        "brand-grad": "linear-gradient(135deg, #8b5cf6 0%, #ec4899 50%, #f59e0b 100%)",
        "brand-grad-soft":
          "linear-gradient(135deg, rgba(139,92,246,0.18) 0%, rgba(236,72,153,0.12) 60%, rgba(245,158,11,0.10) 100%)",
        "card-grad":
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0))",
        "page-grad":
          "radial-gradient(60% 50% at 20% 0%, rgba(139,92,246,0.18) 0%, transparent 60%), radial-gradient(45% 40% at 100% 10%, rgba(236,72,153,0.10) 0%, transparent 60%), radial-gradient(50% 50% at 50% 100%, rgba(6,182,212,0.07) 0%, transparent 60%)",
      },
      animation: {
        "pulse-glow": "pulse-glow 2.2s ease-in-out infinite",
        "fade-in": "fade-in 0.25s ease-out",
        "slide-up": "slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-in-right": "slide-in-right 0.28s cubic-bezier(0.16, 1, 0.3, 1)",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { opacity: "1", filter: "brightness(1)" },
          "50%": { opacity: "0.8", filter: "brightness(1.2)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
      },
    },
  },
  plugins: [],
};
