/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './client/index.html',
    './client/src/**/*.{ts,tsx,js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        'wa-green': '#25D366',
        'wa-dark': '#128C7E',
        'wa-teal': '#075E54',
      },
    },
  },
  plugins: [],
};
