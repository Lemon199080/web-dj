/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
      "./index.html",
      "./src/**/*.{js,jsx,ts,tsx}",
    ],
    theme: {
      extend: {
        colors: {
          primary: {
            DEFAULT: "#3B82F6", // blue-500
            dark: "#2563EB",    // blue-600
            light: "#93C5FD",   // blue-300
          },
          secondary: {
            DEFAULT: "#6B7280", // gray-500
            dark: "#4B5563",    // gray-600
            light: "#9CA3AF",   // gray-400
          }
        },
        typography: {
          DEFAULT: {
            css: {
              maxWidth: '65ch',
            },
          },
        },
      },
    },
    plugins: [],
  }